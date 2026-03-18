/**
 * Worker Pool Manager — manages a pool of parser workers for Tier 2 processing.
 *
 * Features:
 *   - Pool sized to navigator.hardwareConcurrency (clamped to 2–6)
 *   - Backpressure: main-thread queue, feeds workers one task at a time
 *   - Transferable ArrayBuffers (zero-copy)
 *   - Crash recovery: onerror → respawn worker, re-queue task (1 retry)
 *   - Promise-based API: enqueueTask() returns a Promise that resolves with the result
 */

import {
    WORKER_POOL_MIN, WORKER_POOL_MAX, WORKER_SCRIPT,
    PDFJS_CDN, PDFJS_WORKER_CDN, SHEETJS_CDN,
} from './config.js';

let workers = [];          // { worker, busy, taskId }
let queue = [];            // pending tasks
let pending = new Map();   // taskId → { resolve, reject, task }
let taskCounter = 0;
let initialized = false;

/**
 * Spawn workers and wait for all to signal 'ready'.
 * Call once at app startup.
 * @returns {Promise<number>} Number of workers spawned
 */
export async function initPool() {
    if (initialized) return workers.length;

    // Feature detection: module workers
    if (typeof Worker === 'undefined') {
        console.warn('[WorkerPool] Web Workers not supported — falling back to main thread');
        return 0;
    }

    const poolSize = Math.min(
        Math.max(navigator.hardwareConcurrency || WORKER_POOL_MIN, WORKER_POOL_MIN),
        WORKER_POOL_MAX
    );

    console.log(`[WorkerPool] Spawning ${poolSize} workers`);

    const readyPromises = [];

    for (let i = 0; i < poolSize; i++) {
        const entry = spawnWorker(i);
        if (entry) {
            workers.push(entry);
            readyPromises.push(entry.readyPromise);
        }
    }

    // Wait for all workers to initialize (with timeout)
    try {
        await Promise.race([
            Promise.all(readyPromises),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Worker init timeout')), 15000)),
        ]);
    } catch (e) {
        console.warn('[WorkerPool] Some workers failed to initialize:', e.message);
    }

    initialized = true;
    console.log(`[WorkerPool] ${workers.length} workers ready`);
    return workers.length;
}

/**
 * Spawn a single worker and set up message handling.
 */
function spawnWorker(index) {
    let readyResolve;
    const readyPromise = new Promise(resolve => { readyResolve = resolve; });

    try {
        const worker = new Worker(WORKER_SCRIPT, { type: 'module' });
        const entry = { worker, busy: false, taskId: null, index, readyPromise };

        worker.onmessage = (e) => {
            const msg = e.data;

            if (msg.type === 'ready') {
                readyResolve();
                return;
            }

            if (msg.type === 'result' || msg.type === 'error') {
                const p = pending.get(msg.taskId);
                if (p) {
                    pending.delete(msg.taskId);
                    if (msg.type === 'result') {
                        p.resolve(msg);
                    } else {
                        p.reject(new Error(msg.error));
                    }
                }

                entry.busy = false;
                entry.taskId = null;
                dispatchNext();
            }
        };

        worker.onerror = (event) => {
            console.error(`[WorkerPool] Worker ${index} crashed:`, event.message);
            event.preventDefault();

            // Handle the in-flight task
            if (entry.taskId) {
                const p = pending.get(entry.taskId);
                if (p) {
                    const task = p.task;
                    if (!task._retried) {
                        // Re-queue with retry flag
                        task._retried = true;
                        pending.delete(entry.taskId);
                        queue.unshift(task);
                        console.log(`[WorkerPool] Re-queuing task ${entry.taskId} after crash`);
                    } else {
                        // Already retried once — reject
                        pending.delete(entry.taskId);
                        p.reject(new Error('Worker crashed twice'));
                    }
                }
            }

            // Replace the dead worker
            entry.busy = false;
            entry.taskId = null;
            try {
                entry.worker.terminate();
            } catch (_) {}

            const replacement = spawnWorker(index);
            if (replacement) {
                Object.assign(entry, {
                    worker: replacement.worker,
                    readyPromise: replacement.readyPromise,
                });
                // Re-init the replacement worker, then try dispatching
                replacement.readyPromise.then(() => dispatchNext());
            }
        };

        // Send init message with CDN config
        worker.postMessage({
            type: 'init',
            config: {
                pdfjsCdn: PDFJS_CDN,
                pdfjsWorkerCdn: PDFJS_WORKER_CDN,
                sheetjsCdn: SHEETJS_CDN,
            },
        });

        return entry;
    } catch (e) {
        console.error(`[WorkerPool] Failed to spawn worker ${index}:`, e);
        readyResolve(); // don't block init
        return null;
    }
}

/**
 * Enqueue a task for worker processing.
 * Returns a Promise that resolves with the worker's result message.
 *
 * @param {{fileId: string, fileName: string, extension: string, category: string, mime: string, fileSize: number, buffer: ArrayBuffer}} task
 * @returns {Promise<{type: string, taskId: string, fileId: string, deepMeta: Object|null, excerpt: string|null, createdDate: string|null, author: string|null, title: string|null, language: string|null, extent: string|null}>}
 */
export function enqueueTask(task) {
    const taskId = 't_' + (++taskCounter);
    task._taskId = taskId;

    return new Promise((resolve, reject) => {
        pending.set(taskId, { resolve, reject, task });
        queue.push(task);
        dispatchNext();
    });
}

/**
 * Try to dispatch queued tasks to idle workers.
 */
function dispatchNext() {
    while (queue.length > 0) {
        const idle = workers.find(w => w && !w.busy);
        if (!idle) break;

        const task = queue.shift();
        const taskId = task._taskId;

        idle.busy = true;
        idle.taskId = taskId;

        const msg = {
            type: 'parse',
            taskId,
            fileId: task.fileId,
            fileName: task.fileName,
            extension: task.extension,
            category: task.category,
            mime: task.mime,
            fileSize: task.fileSize,
            buffer: task.buffer,
        };

        // Transfer the ArrayBuffer (zero-copy)
        try {
            idle.worker.postMessage(msg, [task.buffer]);
        } catch (e) {
            // Buffer may have already been transferred — reject
            idle.busy = false;
            idle.taskId = null;
            const p = pending.get(taskId);
            if (p) {
                pending.delete(taskId);
                p.reject(new Error('Failed to transfer buffer: ' + e.message));
            }
        }
    }
}

/** Number of tasks waiting in queue. */
export function getQueueDepth() {
    return queue.length;
}

/** Number of workers currently processing a task. */
export function getActiveCount() {
    return workers.filter(w => w && w.busy).length;
}

/** Total number of workers in the pool. */
export function getPoolSize() {
    return workers.length;
}

/** Whether the pool has been initialized. */
export function isInitialized() {
    return initialized;
}

/**
 * Gracefully drain the queue and terminate all workers.
 * Pending tasks are rejected.
 */
export function drainAndTerminate() {
    // Reject all pending
    for (const [taskId, p] of pending) {
        p.reject(new Error('Pool terminated'));
    }
    pending.clear();
    queue = [];

    // Terminate workers
    for (const entry of workers) {
        if (entry?.worker) {
            try { entry.worker.terminate(); } catch (_) {}
        }
    }
    workers = [];
    initialized = false;
}
