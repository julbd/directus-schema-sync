import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { glob } from 'glob';
import { condenseAction } from './condenseAction.js';
import { exportHook } from './schemaExporterHooks.js';
import { computeSchemaHash } from './schemaHash.js';
import { MetaExporter } from './metaExporter.js';
import { ensureLicenseInitialized, fileExists } from './utils.js';
/**
 * Removes all destructive (DELETE) operations from a schema diff.
 * Used with SCHEMA_SYNC_SAFE=true to prevent project-specific collections,
 * fields, and relations from being dropped when importing a base snapshot.
 */
function filterNonDestructive(diff) {
    const isTopLevelDelete = (diffs) => diffs.some(d => d.kind === 'D' && !d.path);
    const deletedCollections = new Set(diff.collections.filter(c => isTopLevelDelete(c.diff)).map(c => c.collection));
    return {
        ...diff,
        collections: diff.collections.filter(c => !deletedCollections.has(c.collection)),
        fields: diff.fields.filter(f => !deletedCollections.has(f.collection) && !isTopLevelDelete(f.diff)),
        systemFields: (diff.systemFields ?? []).filter(f => !deletedCollections.has(f.collection) && !isTopLevelDelete(f.diff)),
        relations: diff.relations.filter(r => !deletedCollections.has(r.collection) && !isTopLevelDelete(r.diff)),
    };
}
export class SchemaExporter {
    getSchemaService;
    logger;
    options;
    _exportMeta;
    _filePath;
    _exportHandler = condenseAction(() => this.createAndSaveSnapshot());
    // Directus SchemaService, database and getSchema
    constructor(getSchemaService, logger, options = { path: undefined as String?, split: true, safe: false }) {
        this.getSchemaService = getSchemaService;
        this.logger = logger;
        this.options = options;
        this._exportMeta = new MetaExporter(options.path);
        this._filePath = `${this._exportMeta.dataDir}/schema.json`;
    }
    ensureSchemaFilesDir = async () => {
        if (!(await fileExists(`${this._exportMeta.dataDir}/schema`))) {
            await mkdir(`${this._exportMeta.dataDir}/schema`, { recursive: true });
        }
        else {
            // Clean up old schema files
            const files = await glob(this.schemaFilesPath('*'));
            await Promise.all(files.map(file => rm(file)));
        }
    };
    schemaFilesPath(collection) {
        return `${this._exportMeta.dataDir}/schema/${collection}.json`;
    }
    get name() {
        return 'schema';
    }
    export = () => this._exportHandler();
    /**
     * Read the snapshot from schema.json, stitching in the per-collection files when it is partial.
     * Returns null when there is no (usable) schema file.
     */
    async readSnapshotFromFiles() {
        let json;
        try {
            json = await readFile(this._filePath, { encoding: 'utf8' });
        }
        catch (e) {
            return null;
        }
        if (!json)
            return null;
        const schemaParsed = JSON.parse(json);
        // For older versions, the snapshot was stored under the key `snapshot`
        const { partial, hash, ...snapshot } = (schemaParsed.snapshot ? { ...schemaParsed.snapshot, hash: schemaParsed.hash } : schemaParsed);
        if (partial) {
            snapshot.collections = [];
            snapshot.fields = [];
            snapshot.relations = [];
            let found = 0;
            const files = await glob(this.schemaFilesPath('*'));
            await Promise.all(files.map(async (file) => {
                const collectionJson = await readFile(file, { encoding: 'utf8' });
                const { fields, relations, ...collectionInfo } = JSON.parse(collectionJson);
                ++found;
                // Only add collection if it has a meta definition (actual table or group)
                if (collectionInfo.meta) {
                    snapshot.collections.push(collectionInfo);
                }
                for (const field of fields) {
                    snapshot.fields.push(Object.assign({ collection: collectionInfo.collection }, field));
                }
                for (const relation of relations) {
                    snapshot.relations.push(Object.assign({ collection: collectionInfo.collection }, relation));
                }
            }));
            if (found === 0) {
                this.logger.error('No schema files found in schema directory');
                return null;
            }
            this.logger.info(`Stitched ${found} partial schema files`);
            snapshot.collections.sort((a, b) => a.collection.localeCompare(b.collection));
            // Sort non-table collections to the start
            snapshot.collections.sort((a, b) => String(!!a.schema).localeCompare(String(!!b.schema)));
            // Sort fields and relations by collection
            snapshot.fields.sort((a, b) => a.collection.localeCompare(b.collection));
            snapshot.relations.sort((a, b) => a.collection.localeCompare(b.collection));
        }
        return { snapshot, hash, schemaParsed };
    }
    /**
     * Import the schema from file to the database
     * @param force Diff and apply even when the hashes say it is up-to-date
     */
    load = async (_merge = false, force = false) => {
        const fromFiles = await this.readSnapshotFromFiles();
        if (!fromFiles)
            return;
        const { snapshot } = fromFiles;
        // Hash the files themselves rather than trusting the stored hash, which is stale when they were edited by hand
        const filesHash = computeSchemaHash(snapshot);
        if (fromFiles.hash !== filesHash) {
            this.logger.warn('Schema hash in schema.json does not match the schema files, run `npx directus schema-sync hash` to update it');
        }
        const svc = await this.getSchemaService();
        const currentSnapshot = await svc.snapshot();
        // The files were written after exportHook, so compare against the same shape.
        // Clone since the hook mutates, and the diff/apply below need the untouched snapshot.
        const currentHash = computeSchemaHash(exportHook(structuredClone(currentSnapshot)));
        if (currentHash === filesHash) {
            if (!force) {
                this.logger.info('Schema is already up-to-date');
                return;
            }
            this.logger.info('Schema seems up-to-date, diffing anyway since forced');
        }
        this.logger.info(`Diffing schema with hash: ${currentHash} and hash: ${filesHash}`);
        let diff = await svc.diff(snapshot, { currentSnapshot, force: true });
        if (diff !== null) {
            if (this.options.safe) {
                diff = filterNonDestructive(diff);
                this.logger.info('SCHEMA_SYNC_SAFE: filtered destructive operations from diff');
            }
            // Load license so schema changes are checked against active limits (Directus 12+)
            await ensureLicenseInitialized();
            this.logger.info(`Applying schema diff...`);
            // apply() validates against Directus' own hash of the raw (un-hooked) snapshot
            await svc.apply({ diff, hash: svc.getHashedSnapshot(currentSnapshot).hash });
            this.logger.info(`Schema updated`);
        }
    };
    /**
     * Recalculate the hash stored in schema.json from the schema files, eg. after editing them by hand.
     * Doesn't need a database connection.
     * @returns whether the stored hash changed
     */
    async updateHash() {
        const fromFiles = await this.readSnapshotFromFiles();
        if (!fromFiles)
            return false;
        const hash = computeSchemaHash(fromFiles.snapshot);
        if (hash === fromFiles.hash)
            return false;
        // Keep the file as it is, only replace the hash
        fromFiles.schemaParsed.hash = hash;
        await writeFile(this._filePath, JSON.stringify(fromFiles.schemaParsed, null, 2));
        return true;
    }
    /**
     * Create and save the schema snapshot to file
     */
    createAndSaveSnapshot = async () => {
        const svc = await this.getSchemaService();
        let snapshot = (await svc.snapshot());
        snapshot = exportHook(snapshot);
        // Before splitting below, which adds fields/relations onto the collections
        let hash = computeSchemaHash(snapshot);
        if (this.options.split) {
            await this.ensureSchemaFilesDir();
            const { collections, fields, relations, ...meta } = snapshot;
            // Sort on field name to ensure consistent order
            fields.sort((a, b) => a.field.localeCompare(b.field));
            relations.sort((a, b) => a.field.localeCompare(b.field));
            // Sort relations also by related_collection
            relations.sort((a, b) => a.related_collection && b.related_collection ? a.related_collection.localeCompare(b.related_collection) : 0);
            const map = {};
            collections.forEach(item => {
                map[item.collection] = item;
                map[item.collection].fields = [];
                map[item.collection].relations = [];
            });
            for (const field of fields) {
                const { collection, ...fieldMeta } = field;
                if (!map[collection]) {
                    map[collection] = { collection, fields: [], relations: [] };
                }
                map[collection].fields.push(fieldMeta);
            }
            for (const relation of relations) {
                const { collection, ...relationMeta } = relation;
                if (!map[collection]) {
                    map[collection] = { collection, fields: [], relations: [] };
                }
                map[collection].relations.push(relationMeta);
            }
            // Save inital snapshot file as partial
            const schemaJson = JSON.stringify(Object.assign({ hash, partial: true }, meta), null, 2);
            await writeFile(this._filePath, schemaJson);
            // Save all collections with fields as individual files
            await Promise.all(Object.entries(map).map(([collection, item]) => writeFile(this.schemaFilesPath(collection), JSON.stringify(item, null, 2))));
        }
        else {
            const schemaJson = JSON.stringify(Object.assign({ hash }, snapshot), null, 2);
            await writeFile(this._filePath, schemaJson);
        }
    };
}
