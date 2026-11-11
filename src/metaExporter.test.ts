import assert from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { MetaExporter } from './metaExporter';

describe('MetaExporter.parseExportMeta', () => {
	it('parses hash and timestamp', () => {
		assert.deepStrictEqual(MetaExporter.parseExportMeta('abc@2024-06-01 12:00:00'), {
			hash: 'abc',
			ts: '2024-06-01 12:00:00',
		});
	});

	it('ignores a trailing newline or CRLF', () => {
		const expected = { hash: 'abc', ts: '2024-06-01 12:00:00' };
		assert.deepStrictEqual(MetaExporter.parseExportMeta('abc@2024-06-01 12:00:00\n'), expected);
		assert.deepStrictEqual(MetaExporter.parseExportMeta('abc@2024-06-01 12:00:00\r\n'), expected);
	});

	it('rejects missing or invalid parts', () => {
		assert.strictEqual(MetaExporter.parseExportMeta(''), null);
		assert.strictEqual(MetaExporter.parseExportMeta('abc'), null);
		assert.strictEqual(MetaExporter.parseExportMeta('abc@not a date'), null);
	});
});

describe('MetaExporter data hashing', () => {
	async function withTempDataDir(run: (dataDir: string) => Promise<void>) {
		const root = await mkdtemp(join(tmpdir(), 'schema-sync-hash-'));
		const dataDir = join(root, 'data');
		await mkdir(dataDir, { recursive: true });
		try {
			await run(dataDir);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}

	it('lists nested schema and grouped collection JSON files', async () => {
		await withTempDataDir(async dataDir => {
			await writeFile(join(dataDir, 'schema.json'), '{"partial":true}');
			await mkdir(join(dataDir, 'schema'), { recursive: true });
			await writeFile(join(dataDir, 'schema', 'articles.json'), '{"collection":"articles"}');
			await mkdir(join(dataDir, 'directus_permissions'), { recursive: true });
			await writeFile(join(dataDir, 'directus_permissions', 'admin.json'), '[]');

			const metaExporter = new MetaExporter(dataDir);
			const files = await metaExporter.listDataJsonFiles();
			assert.deepStrictEqual(files, [
				'directus_permissions/admin.json',
				'schema.json',
				'schema/articles.json',
			]);
		});
	});

	it('changes hash when a nested schema file changes', async () => {
		await withTempDataDir(async dataDir => {
			await writeFile(join(dataDir, 'schema.json'), '{"partial":true,"hash":"abc"}');
			await mkdir(join(dataDir, 'schema'), { recursive: true });
			await writeFile(join(dataDir, 'schema', 'articles.json'), '{"collection":"articles"}');

			const metaExporter = new MetaExporter(dataDir);
			const before = await metaExporter.computeDataHash();
			await writeFile(join(dataDir, 'schema', 'articles.json'), '{"collection":"articles","fields":[]}');
			const after = await metaExporter.computeDataHash();

			assert.notStrictEqual(before, after);
		});
	});

	it('changes hash when a grouped collection file changes', async () => {
		await withTempDataDir(async dataDir => {
			await writeFile(join(dataDir, 'directus_permissions.json'), '{"partial":true,"count":1}');
			await mkdir(join(dataDir, 'directus_permissions'), { recursive: true });
			await writeFile(join(dataDir, 'directus_permissions', 'admin.json'), '[{"id":1}]');

			const metaExporter = new MetaExporter(dataDir);
			const before = await metaExporter.computeDataHash();
			await writeFile(join(dataDir, 'directus_permissions', 'admin.json'), '[{"id":1},{"id":2}]');
			const after = await metaExporter.computeDataHash();

			assert.notStrictEqual(before, after);
		});
	});
});
