import { CollectionExporter } from './collectionExporter.js';
export class ExportManager {
    path;
    logger;
    clearSchemaCache;
    exporters = [];
    constructor(path, logger, clearSchemaCache) {
        this.path = path;
        this.logger = logger;
        this.clearSchemaCache = clearSchemaCache;
    }
    // FIRST: Add exporters
    addExporter(exporterConfig) {
        this.exporters.push(exporterConfig);
    }
    addCollectionExporter(config, getItemsService) {
        for (let collectionName in config) {
            const opts = {
                ...config[collectionName],
                path: this.path
            };
            this.exporters.push({
                watch: opts.watch,
                exporter: new CollectionExporter(collectionName, getItemsService, opts, this.logger),
            });
        }
    }
    // SECOND: Import if needed
    async loadAll(merge = false, force = false) {
        await this._loadNextExporter(0, merge, force);
    }
    refreshSchemaCache() {
        this.clearSchemaCache?.();
        for (const { exporter } of this.exporters) {
            exporter.clearCache?.();
        }
    }
    async _loadNextExporter(i = 0, merge = false, force = false) {
        if (i >= this.exporters.length)
            return;
        try {
            const finishUp = await this.exporters[i].exporter.load(merge, force);
            if (this.exporters[i].exporter.name === 'schema') {
                this.refreshSchemaCache();
            }
            await this._loadNextExporter(i + 1, merge, force);
            if (typeof finishUp === 'function')
                await finishUp();
        }
        catch (e) {
            this.logger.error(`Failed loading "${this.exporters[i].exporter.name}".`);
            throw e;
        }
    }
    // THIRD: Start watching for changes
    attachAllWatchers(action, updateMeta) {
        // EXPORT SCHEMAS & COLLECTIONS ON CHANGE //
        const actions = ['create', 'update', 'delete'];
        this.exporters.forEach(({ watch, exporter }) => {
            watch.forEach(col => {
                actions.forEach(evt => {
                    action(`${col}.${evt}`, async () => {
                        await exporter.export();
                        await updateMeta();
                    });
                });
            });
        });
    }
    async exportAll() {
        console.log('Exporting ', this.exporters.length, ' exporters');
        await Promise.all(this.exporters.map(e => e.exporter.export()));
    }
}
