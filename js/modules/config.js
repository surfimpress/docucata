/**
 * Centralised configuration constants.
 * Change values here rather than hunting through individual modules.
 */

// ── Excerpt extraction ──────────────────────────────────
export const MAX_EXCERPT_BYTES = 100 * 1024;        // 100 KB — max text extracted per file

// ── Table display ───────────────────────────────────────
export const TABLE_PAGE_SIZE = 50;                   // Rows per page in Grid.js
export const CELL_PREVIEW_LENGTH = 200;              // Max chars shown in table cells (excerpt, deep meta)

// ── File cache (IndexedDB) ──────────────────────────────
export const MAX_CACHE_BYTES = 500 * 1024 * 1024;   // 500 MB — LRU eviction cap for binary file cache

// ── Worker pool ────────────────────────────────────────
export const WORKER_POOL_MIN = 2;                    // Minimum workers regardless of hardwareConcurrency
export const WORKER_POOL_MAX = 6;                    // Maximum workers to avoid thread saturation
export const WORKER_SCRIPT = '/docucata/js/workers/parserWorker.js';
export const TIER1_CONCURRENCY = 10;                 // Parallel file.arrayBuffer() calls during Tier 1 capture

// ── CDN library URLs (for worker dynamic loading) ──────
export const PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.2.67/pdf.min.mjs';
export const PDFJS_WORKER_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.2.67/pdf.worker.min.mjs';
export const SHEETJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
