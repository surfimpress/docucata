import { generateFileId, getFileExtension, classifyFile, detectFileType } from '../modules/utils.js';
import { parsePdfMetadata } from '../parsers/pdfParser.js';
import { parseImageMetadata } from '../parsers/imageParser.js';
import { parseOfficeMetadata } from '../parsers/officeParser.js';
import { parseOle2Metadata } from '../parsers/ole2Parser.js';
import { parseRtfMetadata } from '../parsers/rtfParser.js';
import { parseSpreadsheetMetadata } from '../parsers/spreadsheetParser.js';
import { parseAudioMetadata } from '../parsers/audioParser.js';
import { parseTextMetadata } from '../parsers/textParser.js';
import { extractExcerpt } from '../modules/excerptExtractor.js';

/**
 * Extract normalized metadata from an array of { file, path } objects.
 * Parses deep metadata from PDFs, images, and Office docs.
 * ZIP files are added as regular entries (unpacked on demand by the user).
 * @param {Array<{file: File, path: string}>} fileEntries
 * @param {Function} [onProgress] — called after each file: ({ done, total, bytesProcessed, totalBytes, fileName })
 * @returns {Promise<Array>} Array of metadata objects
 */
export async function extractLocalMetadata(fileEntries, onProgress) {
    console.group(`[Docucata] Processing ${fileEntries.length} item(s)`);

    const totalBytes = fileEntries.reduce((sum, e) => sum + (e.file.size || 0), 0);
    let bytesProcessed = 0;

    const results = [];
    for (let _i = 0; _i < fileEntries.length; _i++) {
        // Yield before processing so the browser can repaint with the current file name
        if (_i > 0) {
            await new Promise(r => setTimeout(r, 0));
        }

        const { file, path } = fileEntries[_i];
        const lastModified = new Date(file.lastModified).toISOString();
        let extension = getFileExtension(file.name);
        let category = classifyFile(extension);
        let detectedMime = file.type || '';

        // Magic byte detection for extensionless or unrecognised files
        if (!extension || category === 'Other') {
            const detected = await detectFileType(file);
            if (detected) {
                console.log(`[Docucata] Magic bytes detected: ${file.name} → .${detected.extension} (${detected.mime})`);
                extension = detected.extension;
                category = detected.category;
                detectedMime = detected.mime;
            }
        }

        // Deep parse based on file type
        let deepMeta = null;

        if (extension === 'pdf') {
            deepMeta = await parsePdfMetadata(file);
        } else if (['jpg', 'jpeg', 'tiff', 'tif', 'heic', 'heif', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(extension)) {
            deepMeta = await parseImageMetadata(file);
        } else if (['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'].includes(extension)) {
            deepMeta = await parseOfficeMetadata(file);
        } else if (['doc', 'xls', 'ppt', 'dot', 'xlt', 'pps'].includes(extension)) {
            deepMeta = await parseOle2Metadata(file);
        } else if (extension === 'rtf') {
            deepMeta = await parseRtfMetadata(file);
        } else if (['mp3', 'wav', 'wave', 'flac', 'ogg', 'oga', 'aif', 'aiff', 'm4a', 'aac', 'wma', 'opus'].includes(extension)) {
            deepMeta = await parseAudioMetadata(file);
        }

        // Text file analysis — encoding, line endings, word/line counts
        if (!deepMeta && ['txt', 'md', 'log', 'csv', 'ini', 'cfg', 'yaml', 'yml', 'toml'].includes(extension)) {
            deepMeta = await parseTextMetadata(file);
        }

        // Spreadsheet deep parse — adds sheet-level structure on top of docProps
        if (['xlsx', 'xls', 'ods', 'csv'].includes(extension)) {
            const sheetMeta = await parseSpreadsheetMetadata(file);
            if (sheetMeta) {
                deepMeta = deepMeta ? { ...deepMeta, ...sheetMeta } : sheetMeta;
            }
        }

        // Extract text excerpt
        const excerpt = await extractExcerpt(file, extension);

        // Extract created date from deep metadata
        let createdDate = null;
        if (deepMeta?.CreationDate) createdDate = deepMeta.CreationDate;
        else if (deepMeta?.DateTimeOriginal) createdDate = deepMeta.DateTimeOriginal;
        else if (deepMeta?.created) createdDate = deepMeta.created;

        // Extract author/creator
        let author = null;
        if (deepMeta?.Author) author = deepMeta.Author;
        else if (deepMeta?.Artist) author = deepMeta.Artist;
        else if (deepMeta?.creator) author = deepMeta.creator;
        else if (deepMeta?.author) author = deepMeta.author;

        // Extract title
        let title = null;
        if (deepMeta?.Title) title = deepMeta.Title;
        else if (deepMeta?.title) title = deepMeta.title;

        // Extract language from deep metadata
        let language = null;
        if (deepMeta?.language) language = deepMeta.language;
        else if (deepMeta?.defaultLanguage) language = deepMeta.defaultLanguage;

        // Extract extent (page/sheet/slide count)
        let extent = null;
        if (deepMeta?.pageCount) extent = String(deepMeta.pageCount);
        else if (deepMeta?.pages) extent = String(deepMeta.pages);
        else if (deepMeta?.slideCount) extent = String(deepMeta.slideCount);
        else if (deepMeta?.slides) extent = String(deepMeta.slides);
        else if (deepMeta?.sheetCount) extent = String(deepMeta.sheetCount);

        // Log everything
        console.group(`File: ${file.name}`);
        console.log('--- File API ---');
        console.log('name:', file.name);
        console.log('size:', file.size, `(${(file.size / 1024).toFixed(2)} KB)`);
        console.log('type (MIME):', file.type || '(empty)');
        console.log('lastModified (timestamp):', file.lastModified);
        console.log('lastModified (ISO):', lastModified);
        console.log('lastModified (local):', new Date(file.lastModified).toLocaleString());
        console.log('webkitRelativePath:', file.webkitRelativePath || '(empty)');
        console.log('--- Derived ---');
        console.log('path:', path);
        console.log('extension:', extension || '(none)');
        console.log('category:', category);
        console.log('--- Deep Metadata ---');
        console.log('createdDate:', createdDate);
        console.log('author:', author);
        console.log('title:', title);
        if (deepMeta) {
            console.log('All parsed fields:', deepMeta);
        } else {
            console.log('(no deep metadata available for this file type)');
        }
        console.log('--- Raw File Object ---');
        console.dir(file);
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
            _file: file  // Keep raw File reference for on-demand operations (ZIP unpack, etc.)
        });

        // Report progress after each file completes
        bytesProcessed += file.size;
        if (onProgress) {
            onProgress({
                done: _i + 1,
                total: fileEntries.length,
                bytesProcessed,
                totalBytes,
                fileName: file.name,
            });
        }
    }

    console.log('--- Summary ---');
    console.table(results.map(r => ({
        name: r.name,
        path: r.path,
        size: r.size,
        type: r.type,
        category: r.category,
        created: r.createdDate,
        author: r.author,
        title: r.title,
    })));
    console.groupEnd();

    return results;
}
