/**
 * IndexedDB-based file cache for persisting raw File data across sessions.
 * Stores ArrayBuffers keyed by metadata ID, and reconstructs File objects on load.
 *
 * Storage management features:
 * - Only saves new/changed files (skips already-cached entries)
 * - Cleans orphaned entries on startup (no matching metadata ID)
 * - Tracks total cache size and exposes it for UI display
 * - Enforces a configurable max cache size with LRU eviction
 * - Supports lazy loading (single file on demand)
 */

import { MAX_CACHE_BYTES } from './config.js';

const DB_NAME = 'docucata_files';
const DB_VERSION = 1;
const STORE_NAME = 'files';

let _db = null;

async function getDB() {
    if (_db) return _db;
    _db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    return _db;
}

/**
 * Save File objects from a metadata array into IndexedDB.
 * Only writes files that aren't already cached (checks by key existence).
 * Pre-reads all ArrayBuffers before opening the write transaction to avoid
 * the IndexedDB auto-commit issue with await inside transactions.
 */
export async function saveFiles(metadataArray) {
    const itemsWithFiles = metadataArray.filter(i => i._file);
    if (itemsWithFiles.length === 0) return;

    try {
        const db = await getDB();

        // Get existing keys in a separate transaction
        const existingKeys = await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).getAllKeys();
            req.onsuccess = () => resolve(new Set(req.result));
            req.onerror = () => reject(req.error);
        });

        const newItems = itemsWithFiles.filter(i => !existingKeys.has(i.id));
        if (newItems.length === 0) return;

        // Pre-read all buffers BEFORE opening the write transaction
        const prepared = [];
        for (const item of newItems) {
            const buffer = await item._file.arrayBuffer();
            prepared.push({
                id: item.id,
                buffer,
                name: item._file.name,
                type: item._file.type,
                lastModified: item._file.lastModified,
                size: buffer.byteLength,
            });
        }

        // Now write everything synchronously in one transaction
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const entry of prepared) {
            store.put({
                buffer: entry.buffer,
                name: entry.name,
                type: entry.type,
                lastModified: entry.lastModified,
                size: entry.size,
                cachedAt: Date.now(),
            }, entry.id);
        }

        await txComplete(tx);
        console.log(`[Docucata:FileCache] Cached ${prepared.length} new files (${existingKeys.size} already cached)`);

        // Enforce size cap after writing
        await enforceMaxSize();
    } catch (e) {
        console.warn('[Docucata:FileCache] Failed to save files:', e);
    }
}

/**
 * Restore File objects onto metadata items that are missing _file.
 * Mutates the array in place.
 * Fires all get requests synchronously to avoid transaction auto-commit.
 */
export async function loadFiles(metadataArray) {
    const missing = metadataArray.filter(i => !i._file);
    if (missing.length === 0) return;

    try {
        const db = await getDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);

        // Fire all get requests synchronously (no await between them)
        const requests = missing.map(item => ({
            item,
            promise: getRecord(store, item.id),
        }));

        // Now await all results after the requests are queued
        let restored = 0;
        for (const { item, promise } of requests) {
            const record = await promise;
            if (record && record.buffer) {
                item._file = new File([record.buffer], record.name, {
                    type: record.type,
                    lastModified: record.lastModified,
                });
                restored++;
            }
        }

        if (restored > 0) {
            console.log(`[Docucata:FileCache] Restored ${restored} / ${missing.length} files from cache`);
        }
    } catch (e) {
        console.warn('[Docucata:FileCache] Failed to load files:', e);
    }
}

/**
 * Load a single file by metadata ID. Used for lazy/on-demand loading.
 * @returns {File|null}
 */
export async function loadSingleFile(id, fallbackName, fallbackType) {
    try {
        const db = await getDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const record = await getRecord(tx.objectStore(STORE_NAME), id);
        if (record && record.buffer) {
            return new File([record.buffer], record.name || fallbackName, {
                type: record.type || fallbackType,
                lastModified: record.lastModified || Date.now(),
            });
        }
    } catch (e) {
        console.warn('[Docucata:FileCache] Failed to load single file:', e);
    }
    return null;
}

/**
 * Remove orphaned cache entries whose IDs don't match any current metadata.
 */
export async function cleanOrphans(metadataArray) {
    try {
        const db = await getDB();
        const validIds = new Set(metadataArray.map(i => i.id));

        // Read keys in a separate transaction first
        const allKeys = await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).getAllKeys();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });

        const orphanKeys = allKeys.filter(key => !validIds.has(key));
        if (orphanKeys.length === 0) return;

        // Delete orphans in a single synchronous burst
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const key of orphanKeys) {
            store.delete(key);
        }

        await txComplete(tx);
        console.log(`[Docucata:FileCache] Cleaned ${orphanKeys.length} orphaned cache entries`);
    } catch (e) {
        console.warn('[Docucata:FileCache] Failed to clean orphans:', e);
    }
}

/**
 * Get the total cache size and entry count.
 * @returns {Promise<{size: number, count: number}>}
 */
export async function getCacheStats() {
    try {
        const db = await getDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);

        const allRecords = await new Promise((resolve, reject) => {
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });

        let totalSize = 0;
        for (const record of allRecords) {
            totalSize += record.size || record.buffer?.byteLength || 0;
        }

        return { size: totalSize, count: allRecords.length };
    } catch (e) {
        console.warn('[Docucata:FileCache] Failed to get stats:', e);
        return { size: 0, count: 0 };
    }
}

/**
 * Enforce the max cache size by evicting oldest entries (LRU by cachedAt).
 * Uses getAll() to read everything in one request, avoiding transaction auto-commit.
 */
async function enforceMaxSize() {
    try {
        const db = await getDB();

        // Read all records and keys in one burst
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);

        const [allKeys, allRecords] = await Promise.all([
            new Promise((resolve, reject) => {
                const req = store.getAllKeys();
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            }),
            new Promise((resolve, reject) => {
                const req = store.getAll();
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            }),
        ]);

        const entries = allKeys.map((key, i) => ({
            key,
            size: allRecords[i]?.size || allRecords[i]?.buffer?.byteLength || 0,
            cachedAt: allRecords[i]?.cachedAt || 0,
        }));

        let totalSize = entries.reduce((sum, e) => sum + e.size, 0);
        if (totalSize <= MAX_CACHE_BYTES) return;

        // Sort oldest first for eviction
        entries.sort((a, b) => a.cachedAt - b.cachedAt);

        const deleteTx = db.transaction(STORE_NAME, 'readwrite');
        const deleteStore = deleteTx.objectStore(STORE_NAME);
        let evicted = 0;

        for (const entry of entries) {
            if (totalSize <= MAX_CACHE_BYTES) break;
            deleteStore.delete(entry.key);
            totalSize -= entry.size;
            evicted++;
        }

        await txComplete(deleteTx);
        if (evicted > 0) {
            console.log(`[Docucata:FileCache] Evicted ${evicted} files to stay under ${formatSize(MAX_CACHE_BYTES)} cap`);
        }
    } catch (e) {
        console.warn('[Docucata:FileCache] Failed to enforce size limit:', e);
    }
}

/**
 * Clear all cached files from IndexedDB.
 */
export async function clearFiles() {
    try {
        const db = await getDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        await txComplete(tx);
        console.log('[Docucata:FileCache] Cleared all cached files');
    } catch (e) {
        console.warn('[Docucata:FileCache] Failed to clear files:', e);
    }
}

// --- Helpers ---

function getRecord(store, key) {
    return new Promise((resolve, reject) => {
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function txComplete(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}
