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
