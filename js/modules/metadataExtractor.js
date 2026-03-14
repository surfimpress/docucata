import { extractLocalMetadata } from '../providers/localProvider.js';

/**
 * Extract metadata from files using the appropriate provider.
 * @param {Array<{file: File, path: string}>} fileEntries
 * @param {string} source - "local" or "sharepoint"
 * @param {Function} [onProgress] — progress callback passed to provider
 * @returns {Promise<Array>} Array of normalized metadata objects
 */
export async function extractMetadata(fileEntries, source = 'local', onProgress) {
    switch (source) {
        case 'local':
            return await extractLocalMetadata(fileEntries, onProgress);
        // Future: case 'sharepoint': return await extractSharePointMetadata(files);
        default:
            console.warn(`Unknown source: ${source}`);
            return [];
    }
}
