import { access } from 'fs/promises';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
export const ADMIN_ACCOUNTABILITY = {
    admin: true,
    role: '',
    roles: [],
    user: null,
    app: false,
    ip: null
};
export function nodeImport(dir, file) {
    return import(pathToFileURL(resolve(dir, file)).href);
}
/**
 * Ensure Directus license entitlements are loaded before schema/data
 * mutations that enforce tier limits (mirrors directus/directus#27869).
 * Required for CLI paths that do not start the full app.
 * Lazy-imported so unit tests can load this module without a Directus env.
 */
let licenseInitializePromise = null;
export async function ensureLicenseInitialized() {
    if (licenseInitializePromise)
        return licenseInitializePromise;
    licenseInitializePromise = (async () => {
        try {
            const { getLicenseManager } = await import('@directus/api/license/index');
            const manager = getLicenseManager();
            // App startup already initializes the license before `app.before`;
            // only initialize when running via CLI (or if it has not run yet).
            if (manager.initialized)
                return;
            await manager.initialize();
        }
        catch (error) {
            licenseInitializePromise = null;
            throw error;
        }
    })();
    return licenseInitializePromise;
}
export async function fileExists(path) {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}
export function utcTS(isoTimestamp = new Date().toISOString()) {
    return isoTimestamp.replace('T', ' ').replace(/\.\d*Z/, '');
}
export function deepEqual(obj1, obj2) {
    if (obj1 === obj2)
        return true;
    if (typeof obj1 !== 'object' || obj1 === null || typeof obj2 !== 'object' || obj2 === null) {
        return false;
    }
    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);
    if (keys1.length !== keys2.length)
        return false;
    for (let key of keys1) {
        if (!keys2.includes(key))
            return false;
        if (!deepEqual(obj1[key], obj2[key]))
            return false;
    }
    return true;
}
export function getDiff(newObj, oldObj) {
    if (!oldObj)
        return newObj;
    const result = {};
    let isDifferent = false;
    Object.keys(newObj).forEach(key => {
        if (!deepEqual(newObj[key], oldObj[key])) {
            result[key] = newObj[key];
            isDifferent = true;
        }
    });
    return isDifferent ? result : null;
}
export function sortObject(obj) {
    if (typeof obj !== 'object' || obj === null) {
        return obj;
    }
    if (Array.isArray(obj)) {
        return obj.map(sortObject);
    }
    const sortedObj = {};
    Object.keys(obj)
        .sort()
        .forEach(key => {
        sortedObj[key] = sortObject(obj[key]);
    });
    return sortedObj;
}
