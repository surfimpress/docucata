import { formatBytes } from './utils.js';
import { resolveExportMapping } from './mappingManager.js';

/**
 * Export metadata array to a CSV file and trigger download.
 * Uses the active mapping to determine headers and field order.
 * @returns {number} The number of files exported.
 */
export function exportToCsv(metadataArray, filename) {
    if (metadataArray.length === 0) return 0;

    const now = new Date().toISOString().slice(0, 10);
    const fname = filename || `docucata-export-${now}.csv`;

    const { headers, rowBuilder } = resolveExportMapping();
    const rows = metadataArray.map(item => rowBuilder(item, formatBytes));

    const csv = [headers, ...rows]
        .map(row => row.map(escapeCsvField).join(','))
        .join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    triggerDownload(blob, fname);
    return metadataArray.length;
}

/**
 * Export metadata array to a JSON file and trigger download.
 * Uses the active mapping to determine which fields and labels to include.
 * @returns {number} The number of files exported.
 */
export function exportToJson(metadataArray, filename) {
    if (metadataArray.length === 0) return 0;

    const now = new Date().toISOString().slice(0, 10);
    const fname = filename || `docucata-export-${now}.json`;

    const { headers, rowBuilder } = resolveExportMapping();

    const clean = metadataArray.map(item => {
        const values = rowBuilder(item, formatBytes);
        const out = {};
        headers.forEach((label, i) => {
            out[label] = values[i];
        });
        return out;
    });

    const json = JSON.stringify(clean, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
    triggerDownload(blob, fname);
    return metadataArray.length;
}

/**
 * Trigger a file download from a Blob.
 */
function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/**
 * Escape a CSV field per RFC 4180.
 */
function escapeCsvField(value) {
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}
