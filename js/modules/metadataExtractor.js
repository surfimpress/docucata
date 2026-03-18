/**
 * Metadata extraction dispatcher.
 *
 * This module provides backward-compatible sequential extraction
 * using the refactored localProvider shared source. It will be
 * replaced by pipelineManager.js (two-tier worker pipeline).
 */

import { dispatchParsers, normalizeFields } from '../providers/localProvider.js';
import { generateFileId, getFileExtension, classifyFile, detectFileTypeFromBuffer } from './utils.js';

/**
 * Extract metadata from files using the appropriate provider.
 * Sequential processing — each file is read, parsed, and normalized in order.
 * @param {Array<{file: File, path: string}>} fileEntries
 * @param {string} source - "local" or "sharepoint"
 * @param {Function} [onProgress] — progress callback
 * @returns {Promise<Array>} Array of normalized metadata objects
 */
export async function extractMetadata(fileEntries, source = 'local', onProgress) {
    if (source !== 'local') {
        console.warn(`Unknown source: ${source}`);
        return [];
    }

    console.group(`[Docucata] Processing ${fileEntries.length} item(s)`);

    const totalBytes = fileEntries.reduce((sum, e) => sum + (e.file.size || 0), 0);
    let bytesProcessed = 0;
    const results = [];

    for (let i = 0; i < fileEntries.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 0));

        const { file, path } = fileEntries[i];
        const lastModified = new Date(file.lastModified).toISOString();
        let extension = getFileExtension(file.name);
        let category = classifyFile(extension);
        let detectedMime = file.type || '';

        // Read file into buffer
        const buffer = await file.arrayBuffer();

        // Magic byte detection for extensionless or unrecognised files
        if (!extension || category === 'Other') {
            const detected = detectFileTypeFromBuffer(buffer);
            if (detected) {
                console.log(`[Docucata] Magic bytes detected: ${file.name} → .${detected.extension} (${detected.mime})`);
                extension = detected.extension;
                category = detected.category;
                detectedMime = detected.mime;
            }
        }

        // Deep parse + excerpt extraction via shared source
        const { deepMeta, excerpt } = await dispatchParsers(buffer, extension, category, file.size);

        // Normalize fields
        const { createdDate, author, title, language, extent } = normalizeFields(deepMeta);

        // Log
        console.group(`File: ${file.name}`);
        console.log('extension:', extension || '(none)', 'category:', category);
        if (deepMeta) console.log('Deep metadata:', deepMeta);
        console.groupEnd();

        results.push({
            id: generateFileId(path, file.size, file.lastModified),
            name: file.name,
            path,
            size: file.size,
            type: file.type || detectedMime || 'application/octet-stream',
            extension,
            category,
            lastModified,
            createdDate,
            author,
            title,
            description: '',
            levelOfDescription: 'File',
            language: language || '',
            extent: extent || '',
            referenceCode: '',
            source: 'local',
            url: null,
            notes: '',
            excerpt: excerpt || '',
            deepMeta,
            _file: file
        });

        bytesProcessed += file.size;
        if (onProgress) {
            onProgress({
                done: i + 1,
                total: fileEntries.length,
                bytesProcessed,
                totalBytes,
                fileName: file.name,
            });
        }
    }

    console.groupEnd();
    return results;
}
