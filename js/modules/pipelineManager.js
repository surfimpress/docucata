/**
 * Pipeline Manager — two-tier processing orchestrator.
 *
 * Tier 1 (capture): Read file binaries, build skeleton metadata, persist to IDB.
 *   Runs on main thread. Fast — keeps pace with upload rate.
 *
 * Tier 2 (deep processing): Full metadata extraction + excerpts via worker pool.
 *   Streams results back via callbacks. Can lag, pause, survive reload.
 *
 * Status transitions: (none) → captured → processing → complete | error
 */

import { generateFileId, getFileExtension, classifyFile, detectFileTypeFromBuffer } from './utils.js';
import { initPool, enqueueTask, isInitialized } from './workerPool.js';
import { TIER1_CONCURRENCY } from './config.js';

// Fallback: main-thread processing when workers unavailable
import { dispatchParsers, normalizeFields } from '../providers/localProvider.js';

let poolAvailable = false;

/**
 * Initialize the worker pool. Call once at startup.
 * If workers are not supported, falls back to main-thread processing.
 * @returns {Promise<boolean>} Whether the worker pool is available
 */
export async function initPipeline() {
    try {
        const count = await initPool();
        poolAvailable = count > 0;
        console.log(`[Pipeline] ${poolAvailable ? `Worker pool ready (${count} workers)` : 'Falling back to main-thread processing'}`);
    } catch (e) {
        console.warn('[Pipeline] Worker pool init failed, using main-thread fallback:', e);
        poolAvailable = false;
    }
    return poolAvailable;
}

/**
 * Tier 1 — Capture files: read binaries, detect types, build skeleton records.
 * Files appear in the table immediately with _status: 'captured'.
 * Processes in parallel batches of TIER1_CONCURRENCY.
 *
 * @param {Array<{file: File, path: string}>} fileEntries
 * @param {Function} [onProgress] — called after each file: ({ done, total, fileName })
 * @returns {Promise<Array>} Array of skeleton metadata objects with _status: 'captured'
 */
export async function captureBatch(fileEntries, onProgress) {
    const results = [];
    const total = fileEntries.length;

    for (let start = 0; start < total; start += TIER1_CONCURRENCY) {
        const batch = fileEntries.slice(start, start + TIER1_CONCURRENCY);

        const batchResults = await Promise.all(batch.map(async ({ file, path }) => {
            const buffer = await file.arrayBuffer();
            const lastModified = new Date(file.lastModified).toISOString();
            let extension = getFileExtension(file.name);
            let category = classifyFile(extension);
            let detectedMime = file.type || '';

            // Magic byte detection for extensionless or unrecognised files
            if (!extension || category === 'Other') {
                const detected = detectFileTypeFromBuffer(buffer);
                if (detected) {
                    extension = detected.extension;
                    category = detected.category;
                    detectedMime = detected.mime;
                }
            }

            return {
                id: generateFileId(path, file.size, file.lastModified),
                name: file.name,
                path,
                size: file.size,
                type: file.type || detectedMime || 'application/octet-stream',
                extension,
                category,
                lastModified,
                createdDate: null,
                author: null,
                title: null,
                description: '',
                levelOfDescription: 'File',
                language: '',
                extent: '',
                referenceCode: '',
                source: 'local',
                url: null,
                notes: '',
                excerpt: '',
                deepMeta: null,
                _file: file,
                _buffer: buffer,  // Held temporarily for Tier 2, not persisted
                _status: 'captured',
            };
        }));

        results.push(...batchResults);

        // Report progress
        if (onProgress) {
            const done = Math.min(start + batch.length, total);
            const last = batch[batch.length - 1];
            onProgress({ done, total, fileName: last.file.name });
        }
    }

    return results;
}

/**
 * Tier 2 — Deep processing: dispatch to worker pool (or main thread fallback).
 * Results stream back via callbacks as each file completes.
 *
 * @param {Array} items — metadata records with _status: 'captured' and _buffer
 * @param {Object} callbacks
 * @param {Function} callbacks.onFileComplete — (fileId, result) where result has deepMeta, excerpt, etc.
 * @param {Function} [callbacks.onProgress] — (done, total)
 * @param {Function} [callbacks.onAllComplete] — ()
 * @param {Function} [callbacks.onError] — (fileId, errorMessage)
 */
export function processDeep(items, { onFileComplete, onProgress, onAllComplete, onError }) {
    const total = items.length;
    let done = 0;

    if (total === 0) {
        if (onAllComplete) onAllComplete();
        return;
    }

    const promises = items.map(async (item) => {
        const buffer = item._buffer;
        if (!buffer) {
            done++;
            if (onError) onError(item.id, 'No buffer available');
            if (onProgress) onProgress(done, total);
            return;
        }

        item._status = 'processing';

        try {
            let result;

            if (poolAvailable) {
                // Worker pool path
                result = await enqueueTask({
                    fileId: item.id,
                    fileName: item.name,
                    extension: item.extension,
                    category: item.category,
                    mime: item.type,
                    fileSize: item.size,
                    buffer: buffer,
                });
                // Buffer has been transferred — clear reference
                delete item._buffer;
            } else {
                // Main-thread fallback
                const { deepMeta, excerpt } = await dispatchParsers(buffer, item.extension, item.category, item.size);
                const { createdDate, author, title, language, extent } = normalizeFields(deepMeta);
                result = { deepMeta, excerpt, createdDate, author, title, language, extent };
                delete item._buffer;
            }

            if (onFileComplete) onFileComplete(item.id, result);
        } catch (err) {
            delete item._buffer;
            if (onError) onError(item.id, err.message || String(err));
        }

        done++;
        if (onProgress) onProgress(done, total);
    });

    Promise.all(promises).then(() => {
        if (onAllComplete) onAllComplete();
    });
}

/**
 * Resume incomplete processing after page reload.
 * Finds records with _status 'captured' or 'processing', loads their buffers from IDB,
 * and re-queues them to Tier 2.
 *
 * @param {Array} metadata — full metadata array
 * @param {Function} loadFileFn — async (id, name, type) => File|null (from fileCache)
 * @param {Object} callbacks — same as processDeep callbacks
 * @returns {Promise<number>} Number of files re-queued
 */
export async function resumeIncomplete(metadata, loadFileFn, callbacks) {
    const incomplete = metadata.filter(m =>
        m._status === 'captured' || m._status === 'processing'
    );

    if (incomplete.length === 0) return 0;

    // Reset stuck 'processing' back to 'captured'
    for (const item of incomplete) {
        item._status = 'captured';
    }

    // Load buffers from IDB cache
    let ready = 0;
    for (const item of incomplete) {
        if (!item._buffer) {
            const file = await loadFileFn(item.id, item.name, item.type);
            if (file) {
                item._buffer = await file.arrayBuffer();
                ready++;
            } else {
                item._status = 'error';
                item.notes = (item.notes ? item.notes + '\n' : '') + 'File cache evicted — re-drop to process';
            }
        } else {
            ready++;
        }
    }

    const toProcess = incomplete.filter(m => m._status === 'captured');
    if (toProcess.length > 0) {
        processDeep(toProcess, callbacks);
    }

    return toProcess.length;
}
