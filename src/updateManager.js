/**
 * Decide whether a settings row is eligible for schema-sync updates.
 * Pure helper so skip reasons can be unit-tested without a database.
 */
export function evaluateLockEligibility(row, newHash, isoTS) {
    if (!row) {
        return { success: false, reason: 'row_missing' };
    }
    if (row.mv_locked) {
        return { success: false, reason: 'row_locked' };
    }
    if (row.mv_hash === newHash) {
        return {
            success: false,
            reason: 'hash_unchanged',
            detail: `db hash already ${row.mv_hash}`,
        };
    }
    if (row.mv_ts != null) {
        const dbTs = toUtcMillis(row.mv_ts);
        const fileTs = toUtcMillis(isoTS);
        if (!(dbTs < fileTs)) {
            return {
                success: false,
                reason: 'ts_not_newer',
                detail: `file ts ${isoTS} is not newer than db ts ${formatTs(row.mv_ts)}`,
            };
        }
    }
    return { success: true, reason: 'acquired' };
}
function formatTs(value) {
    if (value instanceof Date)
        return value.toISOString();
    if (typeof value === 'number')
        return new Date(value).toISOString();
    return String(value);
}
/** Parse hash.txt-style timestamps (`YYYY-MM-DD HH:mm:ss`), Date values and epoch millis as UTC. */
function toUtcMillis(value) {
    if (value instanceof Date)
        return value.getTime();
    if (typeof value === 'number')
        return value;
    const raw = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(raw)) {
        return new Date(raw.replace(' ', 'T') + 'Z').getTime();
    }
    return new Date(raw).getTime();
}
/**
 * Convert a hash.txt timestamp to an absolute instant for `mv_ts`.
 * Writing the raw string lets the DB interpret it in its session time zone,
 * which shifts the stored value whenever that zone is not UTC.
 */
export function toDbTimestamp(isoTS) {
    return new Date(toUtcMillis(isoTS));
}
export function describeLockResult(result) {
    switch (result.reason) {
        case 'acquired':
            return 'lock acquired';
        case 'not_installed':
            return 'schema-sync columns not installed yet; proceeding without lock';
        case 'already_locking':
            return 'lock attempt already in progress in this process';
        case 'already_locked':
            return 'this process already holds the schema-sync lock';
        case 'row_missing':
            return 'directus_settings row not found';
        case 'row_locked':
            return 'locked by another process (mv_locked=true)';
        case 'hash_unchanged':
            return `hash already applied${result.detail ? ` (${result.detail})` : ''}`;
        case 'ts_not_newer':
            return `export timestamp is not newer than DB${result.detail ? ` (${result.detail})` : ''}`;
    }
}
export class UpdateManager {
    db;
    tableName = 'directus_settings';
    rowId = 1;
    _locking = false;
    _installed = false;
    _locked = false;
    constructor(database) {
        this.db = database;
    }
    /**
     * Acquire the lock to make updates
     * @param newHash - New hash value of latest changes
     * @param isoTS - ISO timestamp
     */
    async lockForUpdates(newHash, isoTS) {
        if (this._locked)
            return { success: false, reason: 'already_locked' };
        if (this._locking)
            return { success: false, reason: 'already_locking' };
        this._locking = true;
        try {
            // Don't lock if schema sync is not installed yet
            if (!this._installed) {
                this._installed = await this.db.schema.hasColumn(this.tableName, 'mv_hash');
                if (!this._installed) {
                    return { success: true, reason: 'not_installed' };
                }
            }
            // Cheap read first: on most starts nothing changed, so skip the row-locking transaction
            const current = await this.db(this.tableName)
                .select('mv_locked', 'mv_hash', 'mv_ts')
                .where('id', this.rowId)
                .first();
            const precheck = evaluateLockEligibility(current, newHash, isoTS);
            if (!precheck.success) {
                return precheck;
            }
            // Re-check under a row lock, another instance may have taken it since the read above
            return await this.db.transaction(async (trx) => {
                const rows = await trx(this.tableName)
                    .select('mv_locked', 'mv_hash', 'mv_ts')
                    .where('id', this.rowId)
                    .forUpdate();
                const eligibility = evaluateLockEligibility(rows[0], newHash, isoTS);
                if (!eligibility.success) {
                    return eligibility;
                }
                await trx(this.tableName).where('id', this.rowId).update({
                    mv_locked: true,
                });
                this._locked = {
                    hash: newHash,
                    ts: isoTS,
                };
                return { success: true, reason: 'acquired' };
            });
        }
        finally {
            this._locking = false;
        }
    }
    async commitUpdates() {
        if (!this._locked)
            return false;
        await this.db(this.tableName).where('id', this.rowId).update({
            mv_hash: this._locked.hash,
            mv_ts: toDbTimestamp(this._locked.ts),
            mv_locked: false,
        });
        this._locked = false;
        return true;
    }
    async forceCommitUpdates(newHash, isoTS) {
        await this.db(this.tableName).where('id', this.rowId).update({
            mv_hash: newHash,
            mv_ts: toDbTimestamp(isoTS),
            mv_locked: false,
        });
        this._locked = false;
        return true;
    }
    async releaseLock() {
        if (!this._locked)
            return false;
        await this.db(this.tableName).where('id', this.rowId).update({
            mv_locked: false,
        });
        this._locked = false;
        return true;
    }
    async ensureInstalled() {
        const tableName = 'directus_settings';
        const isInstalled = await this.db.schema.hasColumn(tableName, 'mv_hash');
        if (!isInstalled) {
            await this.db.schema.table(tableName, table => {
                table.string('mv_hash').defaultTo('').notNullable();
                table.timestamp('mv_ts', { useTz: true }).defaultTo('2020-01-01').notNullable();
                table.boolean('mv_locked').defaultTo(false).notNullable();
            });
            this._installed = true;
            return true;
        }
        return false;
    }
}
