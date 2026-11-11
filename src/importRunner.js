import { describeLockResult } from './updateManager.js';
/**
 * Import the exported schema and data if the export is newer than what the DB has.
 * Safe to run on many instances at once: only the one that acquires the lock imports.
 * Never throws, so it can run in the background.
 */
export async function runImport(deps, mode) {
    const { logger, updateManager } = deps;
    const started = Date.now();
    let locked = false;
    let outcome;
    try {
        logger.info(`Schema sync (${mode}): checking for pending import`);
        const meta = await deps.getExportMeta();
        if (!meta) {
            logger.info('Nothing exported yet it seems');
            return 'nothing_exported';
        }
        logger.info(`Schema sync: export meta hash=${meta.hash} ts=${meta.ts}`);
        const lock = await updateManager.lockForUpdates(meta.hash, meta.ts);
        if (!lock.success) {
            const level = lock.reason === 'row_locked' ? 'warn' : 'info';
            logger[level](`Schema sync skipped: ${describeLockResult(lock)}`);
            return 'skipped';
        }
        locked = true;
        if (lock.reason === 'not_installed') {
            logger.warn('Schema sync: mv_* columns missing on directus_settings, so every start re-imports everything without a lock. Run `npx directus schema-sync install` to fix this.');
        }
        logger.info(`Updating schema and data with hash: ${meta.hash}`);
        await deps.load();
        await updateManager.commitUpdates();
        outcome = 'imported';
    }
    catch (e) {
        logger.error(e);
        if (!locked)
            return 'failed';
        logger.info('Releasing lock...');
        try {
            await updateManager.releaseLock();
        }
        catch (releaseErr) {
            logger.error(releaseErr);
        }
        outcome = 'failed';
    }
    // Also after a failed import, since part of it may already be written
    try {
        await deps.notifyChanged();
    }
    catch (e) {
        logger.warn('Schema sync: could not flush caches / notify other instances');
        logger.warn(e);
    }
    const duration = Date.now() - started;
    if (outcome === 'imported') {
        logger.info(`Schema sync: import finished in ${duration}ms`);
    }
    else {
        logger.error(`Schema sync: import failed after ${duration}ms`);
    }
    return outcome;
}
