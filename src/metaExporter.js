import { createHash } from 'crypto';
import { readFile, readdir, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { utcTS } from './utils';
export class metaExporter {
    schemaDir;
    constructor(schemaDir) {
        this.schemaDir = resolve(process.cwd(), schemaDir ?? 'schema-sync');
    }
    get dataDir() {
        return resolve(this.schemaDir, 'data');
    }
    get hashFile() {
        return resolve(this.schemaDir, 'hash.txt');
    }
    /**
     * Collect every `.json` file under dataDir (including nested schema/ and grouped dirs),
     * with stable sorted relative paths.
     */
    async listDataJsonFiles() {
        const entries = await readdir(this.dataDir, { recursive: true });
        return entries
            .map(file => file.toString().replace(/\\/g, '/'))
            .filter(file => file.endsWith('.json'))
            .sort();
    }
    async computeDataHash() {
        const hasher = createHash('sha256');
        const files = await this.listDataJsonFiles();
        for (const file of files) {
            hasher.update(file);
            const json = await readFile(resolve(this.dataDir, file), { encoding: 'utf8' });
            hasher.update(json);
        }
        return hasher.digest('hex');
    }
    async updateExportMeta() {
        const hash = await this.computeDataHash();
        const { hash: previousHash } = await this.getExportMeta() || {};
        // Only update hash file if it has changed
        if (hash === previousHash)
            return false;
        const ts = utcTS();
        const txt = hash + '@' + ts;
        await writeFile(this.hashFile, txt);
        return {
            hash,
            ts,
        };
    }
    async getExportMeta() {
        try {
            const content = await readFile(this.hashFile, { encoding: 'utf8' });
            return metaExporter.parseExportMeta(content);
        }
        catch {
            // ignore
        }
        return null;
    }
    /** Parse `hash@ts` content of hash.txt, ignoring surrounding whitespace (eg. a trailing newline added by an editor or git). */
    static parseExportMeta(content) {
        const [hash, ts] = content.trim().split('@').map(part => part.trim());
        if (hash && ts && new Date(ts).toString() !== 'Invalid Date') {
            return {
                hash,
                ts,
            };
        }
        return null;
    }
}
