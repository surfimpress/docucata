/**
 * Batch Manager — manages named batches of files.
 *
 * Hybrid storage strategy:
 *   - Batch registry (list, active ID) → localStorage  (tiny, synchronous)
 *   - Per-batch metadata arrays        → IndexedDB     (large, async)
 *
 * Batch record shape:
 * {
 *   id: string,            // 'batch_' + timestamp
 *   name: string,          // User-chosen or default "batch-YYYY-MM-DD"
 *   createdAt: string,     // ISO 8601
 *   fileCount: number,     // Current number of files
 *   exports: [             // CSV download history
 *     { date: string, fileCount: number }
 *   ]
 * }
 */

const BATCHES_KEY = 'docucata_batches';
const ACTIVE_KEY  = 'docucata_active_batch';

// ── IndexedDB setup ────────────────────────────────────

const DB_NAME = 'docucata_db';
const DB_VERSION = 1;
const META_STORE = 'batch_metadata';

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(META_STORE)) {
                db.createObjectStore(META_STORE);
            }
        };

        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });

    return dbPromise;
}

// ── Batch CRUD (localStorage — synchronous) ────────────

export function listBatches() {
    try {
        const raw = localStorage.getItem(BATCHES_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function saveBatchList(batches) {
    localStorage.setItem(BATCHES_KEY, JSON.stringify(batches));
}

export function createBatch(name) {
    const batches = listBatches();
    const id = 'batch_' + Date.now();
    const batch = {
        id,
        name: name || defaultBatchName(),
        createdAt: new Date().toISOString(),
        fileCount: 0,
        exports: [],
    };
    batches.push(batch);
    saveBatchList(batches);
    setActiveBatchId(id);
    return batch;
}

export function renameBatch(batchId, newName) {
    const batches = listBatches();
    const b = batches.find(x => x.id === batchId);
    if (b) {
        b.name = newName;
        saveBatchList(batches);
    }
    return b;
}

/**
 * Delete a batch — removes its metadata from IndexedDB.
 * Returns { deleted: true } or { deleted: false, reason: string }.
 */
export async function deleteBatch(batchId) {
    const batches = listBatches();
    const idx = batches.findIndex(x => x.id === batchId);
    if (idx === -1) return { deleted: false, reason: 'Not found' };

    batches.splice(idx, 1);
    saveBatchList(batches);

    // Remove metadata from IndexedDB
    try {
        const db = await openDB();
        await idbDelete(db, META_STORE, batchId);
    } catch (e) {
        console.warn('[Docucata:Batch] Failed to delete IndexedDB entry:', e);
    }

    // If we deleted the active batch, switch to another or clear
    if (getActiveBatchId() === batchId) {
        setActiveBatchId(batches.length > 0 ? batches[batches.length - 1].id : null);
    }

    return { deleted: true };
}

export function getBatch(batchId) {
    return listBatches().find(x => x.id === batchId) || null;
}

// ── Active batch (localStorage — synchronous) ──────────

export function getActiveBatchId() {
    return localStorage.getItem(ACTIVE_KEY) || null;
}

export function setActiveBatchId(id) {
    if (id) {
        localStorage.setItem(ACTIVE_KEY, id);
    } else {
        localStorage.removeItem(ACTIVE_KEY);
    }
}

// ── Per-batch metadata persistence (IndexedDB — async) ─

export async function saveBatchMetadata(batchId, metadataArray) {
    const serializable = metadataArray.map(({ _file, ...rest }) => rest);

    try {
        const db = await openDB();
        await idbPut(db, META_STORE, batchId, serializable);
    } catch (e) {
        console.error('[Docucata:Batch] Failed to save metadata to IndexedDB:', e);
    }

    // Update fileCount on the batch record
    const batches = listBatches();
    const b = batches.find(x => x.id === batchId);
    if (b) {
        b.fileCount = metadataArray.length;
        saveBatchList(batches);
    }
}

export async function loadBatchMetadata(batchId) {
    try {
        const db = await openDB();
        const data = await idbGet(db, META_STORE, batchId);
        return Array.isArray(data) ? data : [];
    } catch (e) {
        console.error('[Docucata:Batch] Failed to load metadata from IndexedDB:', e);
        return [];
    }
}

export async function clearBatchMetadata(batchId) {
    try {
        const db = await openDB();
        await idbDelete(db, META_STORE, batchId);
    } catch (e) {
        console.warn('[Docucata:Batch] Failed to clear metadata from IndexedDB:', e);
    }

    const batches = listBatches();
    const b = batches.find(x => x.id === batchId);
    if (b) {
        b.fileCount = 0;
        saveBatchList(batches);
    }
}

// ── Export tracking (localStorage — synchronous) ───────

export function recordExport(batchId, fileCount) {
    const batches = listBatches();
    const b = batches.find(x => x.id === batchId);
    if (b) {
        b.exports.push({
            date: new Date().toISOString(),
            fileCount,
        });
        saveBatchList(batches);
    }
}

/**
 * Check deletion safety for a batch.
 * Returns { safe: true } or { safe: false, reason: string }.
 */
export function checkDeleteSafety(batchId) {
    const batch = getBatch(batchId);
    if (!batch) return { safe: true };

    if (batch.exports.length === 0 && batch.fileCount > 0) {
        return {
            safe: false,
            reason: `This batch has ${batch.fileCount} file${batch.fileCount !== 1 ? 's' : ''} and has never been exported to CSV. Export first?`,
        };
    }

    if (batch.exports.length > 0) {
        const lastExport = batch.exports[batch.exports.length - 1];
        if (lastExport.fileCount < batch.fileCount) {
            const diff = batch.fileCount - lastExport.fileCount;
            return {
                safe: false,
                reason: `${diff} file${diff !== 1 ? 's have' : ' has'} been added since the last CSV export. Export first?`,
            };
        }
    }

    return { safe: true };
}

// ── Migration ───────────────────────────────────────────

/**
 * Migrate legacy docucata_metadata into a new batch (one-time).
 * Also migrates any per-batch data still in localStorage to IndexedDB.
 */
export async function migrateLegacyData() {
    let migratedBatch = null;

    // 1. Migrate old single-key metadata → new batch
    const legacy = localStorage.getItem('docucata_metadata');
    if (legacy) {
        try {
            const data = JSON.parse(legacy);
            if (Array.isArray(data) && data.length > 0) {
                const batch = createBatch('Imported');
                await saveBatchMetadata(batch.id, data);
                localStorage.removeItem('docucata_metadata');
                migratedBatch = batch;
            }
        } catch {
            // Ignore corrupt legacy data
        }
    }

    // 2. Migrate any per-batch data still in localStorage → IndexedDB
    const batches = listBatches();
    for (const batch of batches) {
        const lsKey = `docucata_meta_${batch.id}`;
        const raw = localStorage.getItem(lsKey);
        if (raw) {
            try {
                const data = JSON.parse(raw);
                if (Array.isArray(data)) {
                    await saveBatchMetadata(batch.id, data);
                }
            } catch {
                // Skip corrupt entries
            }
            localStorage.removeItem(lsKey);
        }
    }

    return migratedBatch;
}

// ── Storage usage ───────────────────────────────────────

/**
 * Calculate total storage usage.
 * Batch registry is in localStorage, metadata is in IndexedDB.
 */
export async function getStorageUsage() {
    // localStorage portion (batch registry only)
    const batchesRaw = localStorage.getItem(BATCHES_KEY) || '';
    const lsBytes = batchesRaw.length * 2; // JS strings are UTF-16

    // IndexedDB portion — estimate by serializing all metadata
    let idbBytes = 0;
    const batches = listBatches();
    try {
        const db = await openDB();
        for (const b of batches) {
            const data = await idbGet(db, META_STORE, b.id);
            if (data) {
                idbBytes += JSON.stringify(data).length * 2;
            }
        }
    } catch (e) {
        console.warn('[Docucata:Batch] Failed to measure IndexedDB usage:', e);
    }

    return {
        bytes: lsBytes + idbBytes,
        registryBytes: lsBytes,
        metadataBytes: idbBytes,
        batchCount: batches.length,
    };
}

// Keep old name as alias for callers that haven't updated
export { getStorageUsage as getLocalStorageUsage };

// ── Helpers ─────────────────────────────────────────────

export function defaultBatchName() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `batch-${yyyy}-${mm}-${dd}`;
}

// ── IndexedDB primitives ────────────────────────────────

function idbPut(db, storeName, key, value) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

function idbGet(db, storeName, key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idbDelete(db, storeName, key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
