/**
 * Local file provider — shared source for both main thread and worker.
 *
 * Exports:
 *   - dispatchParsers(buffer, extension, category, fileSize)
 *       Runs the correct parser(s) + excerpt extraction on an ArrayBuffer.
 *       Worker-safe — no DOM or File APIs.
 *
 *   - normalizeFields(deepMeta)
 *       Extracts canonical fields (createdDate, author, title, language, extent)
 *       from a deepMeta object.
 *
 * The old extractLocalMetadata() sequential loop has been removed.
 * That role is now handled by pipelineManager.js.
 */

import { parsePdfMetadata } from '../parsers/pdfParser.js';
import { parseImageMetadataFromBuffer } from '../parsers/imageParser.js';
import { parseOfficeMetadata } from '../parsers/officeParser.js';
import { parseOle2Metadata } from '../parsers/ole2Parser.js';
import { parseRtfMetadata } from '../parsers/rtfParser.js';
import { parseSpreadsheetMetadata } from '../parsers/spreadsheetParser.js';
import { parseAudioMetadataFromBuffer } from '../parsers/audioParser.js';
import { parseTextMetadata } from '../parsers/textParser.js';
import { extractExcerptFromBuffer } from '../modules/excerptExtractor.js';

const IMAGE_EXTS = ['jpg', 'jpeg', 'tiff', 'tif', 'heic', 'heif', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'];
const OFFICE_EXTS = ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'];
const OLE2_EXTS = ['doc', 'xls', 'ppt', 'dot', 'xlt', 'pps'];
const AUDIO_EXTS = ['mp3', 'wav', 'wave', 'flac', 'ogg', 'oga', 'aif', 'aiff', 'm4a', 'aac', 'wma', 'opus'];
const TEXT_EXTS = ['txt', 'md', 'log', 'csv', 'ini', 'cfg', 'yaml', 'yml', 'toml'];
const SPREADSHEET_EXTS = ['xlsx', 'xls', 'ods', 'csv'];

/**
 * Run the correct parser(s) and excerpt extraction on an ArrayBuffer.
 * Worker-safe — no DOM, no File APIs.
 *
 * @param {ArrayBuffer} buffer — full file content
 * @param {string} extension — lowercase file extension
 * @param {string} category — file category (Document, Image, etc.)
 * @param {number} fileSize — original file size in bytes
 * @returns {Promise<{deepMeta: Object|null, excerpt: string|null}>}
 */
export async function dispatchParsers(buffer, extension, category, fileSize) {
    let deepMeta = null;

    if (extension === 'pdf') {
        deepMeta = await parsePdfMetadata(buffer);
    } else if (IMAGE_EXTS.includes(extension)) {
        deepMeta = await parseImageMetadataFromBuffer(buffer, extension);
    } else if (OFFICE_EXTS.includes(extension)) {
        deepMeta = await parseOfficeMetadata(buffer, extension);
    } else if (OLE2_EXTS.includes(extension)) {
        deepMeta = await parseOle2Metadata(buffer);
    } else if (extension === 'rtf') {
        deepMeta = await parseRtfMetadata(buffer);
    } else if (AUDIO_EXTS.includes(extension)) {
        deepMeta = await parseAudioMetadataFromBuffer(buffer, extension, fileSize);
    }

    // Text file analysis — encoding, line endings, word/line counts
    if (!deepMeta && TEXT_EXTS.includes(extension)) {
        deepMeta = await parseTextMetadata(buffer);
    }

    // Spreadsheet deep parse — adds sheet-level structure on top of docProps
    if (SPREADSHEET_EXTS.includes(extension)) {
        const sheetMeta = await parseSpreadsheetMetadata(buffer);
        if (sheetMeta) {
            deepMeta = deepMeta ? { ...deepMeta, ...sheetMeta } : sheetMeta;
        }
    }

    // Extract text excerpt
    const excerpt = await extractExcerptFromBuffer(buffer, extension);

    return { deepMeta, excerpt };
}

/**
 * Extract canonical fields from a deepMeta object.
 * Pure function — no side effects, no dependencies.
 *
 * @param {Object|null} deepMeta
 * @returns {{createdDate: string|null, author: string|null, title: string|null, language: string|null, extent: string|null}}
 */
export function normalizeFields(deepMeta) {
    let createdDate = null;
    if (deepMeta?.CreationDate) createdDate = deepMeta.CreationDate;
    else if (deepMeta?.DateTimeOriginal) createdDate = deepMeta.DateTimeOriginal;
    else if (deepMeta?.created) createdDate = deepMeta.created;

    let author = null;
    if (deepMeta?.Author) author = deepMeta.Author;
    else if (deepMeta?.Artist) author = deepMeta.Artist;
    else if (deepMeta?.creator) author = deepMeta.creator;
    else if (deepMeta?.author) author = deepMeta.author;

    let title = null;
    if (deepMeta?.Title) title = deepMeta.Title;
    else if (deepMeta?.title) title = deepMeta.title;

    let language = null;
    if (deepMeta?.language) language = deepMeta.language;
    else if (deepMeta?.defaultLanguage) language = deepMeta.defaultLanguage;

    let extent = null;
    if (deepMeta?.pageCount) extent = String(deepMeta.pageCount);
    else if (deepMeta?.pages) extent = String(deepMeta.pages);
    else if (deepMeta?.slideCount) extent = String(deepMeta.slideCount);
    else if (deepMeta?.slides) extent = String(deepMeta.slides);
    else if (deepMeta?.sheetCount) extent = String(deepMeta.sheetCount);

    return { createdDate, author, title, language, extent };
}
