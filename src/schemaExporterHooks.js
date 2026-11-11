import * as pgUtils from './dialects/postgres/utils.js';
const modifiers = {
    postgres: [pgUtils.sequenceToSerialType],
};
export function exportHook(snapshot) {
    if (modifiers[snapshot.vendor]?.length)
        return modifiers[snapshot.vendor].reduce((_snapshot, modifier) => {
            return modifier(_snapshot);
        }, snapshot);
    return snapshot;
}
