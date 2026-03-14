/**
 * Excerpt Extractor — pulls readable text content from files.
 *
 * Supported formats:
 *   - Plain text / code files → file.text()
 *   - PDF → pdf.js page.getTextContent()
 *   - DOCX → mammoth.js extractRawText()
 *   - DOC → OLE2 piece table text extraction
 *   - RTF → strip control codes to plain text
 *   - Spreadsheets → SheetJS sheet_to_csv() per sheet
 *
 * Excerpt size cap is defined in config.js (MAX_EXCERPT_BYTES).
 */

import { extractDocText } from '../parsers/docTextExtractor.js';
import { MAX_EXCERPT_BYTES } from './config.js';

const TEXT_EXTS = [
    'txt', 'csv', 'json', 'xml', 'html', 'css', 'js', 'ts', 'md',
    'log', 'ini', 'cfg', 'yaml', 'yml', 'toml', 'sh', 'bat', 'py',
    'rb', 'java', 'c', 'cpp', 'h', 'rs', 'go', 'php', 'sql',
];

const SPREADSHEET_EXTS = ['xlsx', 'xls', 'ods', 'csv'];

/**
 * Extract a text excerpt from a file, capped at MAX_EXCERPT_BYTES.
 * @param {File} file
 * @param {string} extension - lowercase file extension
 * @returns {Promise<string|null>} Plain text excerpt or null
 */
export async function extractExcerpt(file, extension) {
    try {
        if (TEXT_EXTS.includes(extension)) {
            return await excerptText(file);
        }
        if (extension === 'pdf') {
            return await excerptPdf(file);
        }
        if (extension === 'docx') {
            return await excerptDocx(file);
        }
        if (extension === 'doc' || extension === 'dot') {
            return await excerptDoc(file);
        }
        if (extension === 'rtf') {
            return await excerptRtf(file);
        }
        if (SPREADSHEET_EXTS.includes(extension)) {
            return await excerptSpreadsheet(file);
        }
        return null;
    } catch (e) {
        console.warn(`[Docucata:Excerpt] Failed for ${file.name}:`, e);
        return null;
    }
}

// ── Plain text ──────────────────────────────────────────

async function excerptText(file) {
    // Read only what we need — slice the file to avoid loading huge files fully
    const slice = file.slice(0, MAX_EXCERPT_BYTES);
    let text = await slice.text();
    if (file.size > MAX_EXCERPT_BYTES) {
        text = text + '\n[…truncated]';
    }
    return text;
}

// ── PDF via pdf.js ──────────────────────────────────────

async function excerptPdf(file) {
    if (typeof pdfjsLib === 'undefined') return null;

    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        // Reconstruct text with proper line breaks.
        // pdf.js text items represent spans within a line. Items flagged
        // with hasEOL mark the end of a visual line. Items on different
        // Y-coordinates also represent separate lines. We use hasEOL as
        // the primary signal and fall back to Y-position changes.
        let prevY = null;
        let prevHeight = 12; // reasonable default line height
        let pageText = '';
        for (const item of content.items) {
            if (item.str === undefined) continue;
            const y = item.transform ? item.transform[5] : null;
            const h = item.height || prevHeight;
            if (prevY !== null && y !== null) {
                const gap = Math.abs(y - prevY);
                if (gap > 2) {
                    // Y changed — insert newline(s) before this item
                    // A gap larger than ~1.5x the line height suggests a paragraph break
                    if (!pageText.endsWith('\n')) {
                        pageText += (gap > h * 1.5) ? '\n\n' : '\n';
                    } else if (gap > h * 1.5 && !pageText.endsWith('\n\n')) {
                        pageText += '\n';
                    }
                }
            }
            pageText += item.str;
            if (item.hasEOL) {
                pageText += '\n';
            }
            if (y !== null) prevY = y;
            if (h > 0) prevHeight = h;
        }
        // Separate pages with double newline
        text += pageText.trimEnd() + '\n\n';
        if (text.length >= MAX_EXCERPT_BYTES) break;
    }

    return truncate(text.trim());
}

// ── DOCX via mammoth.js ─────────────────────────────────

async function excerptDocx(file) {
    if (typeof mammoth === 'undefined') return null;

    const buffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    return truncate(result.value);
}

// ── DOC via OLE2 piece table ────────────────────────────

async function excerptDoc(file) {
    const text = await extractDocText(file);
    return text ? truncate(text) : null;
}

// ── RTF — strip control codes ───────────────────────────

async function excerptRtf(file) {
    const raw = await file.text();
    const text = stripRtf(raw);
    return truncate(text);
}

// ── Spreadsheets via SheetJS → CSV ──────────────────────

async function excerptSpreadsheet(file) {
    if (typeof XLSX === 'undefined') return null;

    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: 'array' });

    let csv = '';
    for (const name of wb.SheetNames) {
        const ws = wb.Sheets[name];
        if (!ws || !ws['!ref']) continue;
        if (wb.SheetNames.length > 1) {
            csv += `--- ${name} ---\n`;
        }
        csv += XLSX.utils.sheet_to_csv(ws) + '\n';
        if (csv.length >= MAX_EXCERPT_BYTES) break;
    }

    return truncate(csv.trim());
}

// ── Helpers ─────────────────────────────────────────────

function truncate(text) {
    if (!text) return null;
    if (text.length <= MAX_EXCERPT_BYTES) return text;
    return text.substring(0, MAX_EXCERPT_BYTES) + '\n[…truncated]';
}

/**
 * Strip RTF control codes and return readable plain text.
 * (Shared logic — also used by fileViewer.js for rendering)
 */
export function stripRtf(rtf) {
    if (!rtf) return '';

    const skipGroups = ['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict',
        'header', 'footer', 'headerl', 'headerr', 'headerf',
        'footerl', 'footerr', 'footerf', 'object', 'shp'];

    let output = '';
    let depth = 0;
    let skipDepth = -1;
    let i = 0;

    while (i < rtf.length) {
        const ch = rtf[i];

        if (ch === '{') {
            depth++;
            if (skipDepth === -1) {
                for (const grp of skipGroups) {
                    if (rtf.substring(i + 1, i + 2 + grp.length) === '\\' + grp) {
                        skipDepth = depth;
                        break;
                    }
                }
            }
            i++;
            continue;
        }

        if (ch === '}') {
            if (depth === skipDepth) skipDepth = -1;
            depth--;
            i++;
            continue;
        }

        if (skipDepth !== -1) { i++; continue; }

        if (ch === '\\') {
            i++;
            if (i >= rtf.length) break;
            const next = rtf[i];

            if (next === '\\' || next === '{' || next === '}') {
                output += next; i++; continue;
            }

            // Paragraph / line break control words
            if (next === 'p' && rtf.substring(i, i + 3) === 'par' && !/[a-zA-Z]/.test(rtf[i + 3] || '')) {
                output += '\n';
            }
            if (next === 'l' && rtf.substring(i, i + 4) === 'line' && !/[a-zA-Z]/.test(rtf[i + 4] || '')) {
                output += '\n';
            }
            if (next === 't' && rtf.substring(i, i + 3) === 'tab' && !/[a-zA-Z]/.test(rtf[i + 3] || '')) {
                output += '\t';
            }

            if (next === "'") {
                const hex = rtf.substring(i + 1, i + 3);
                const code = parseInt(hex, 16);
                if (!isNaN(code)) output += String.fromCharCode(code);
                i += 3;
                continue;
            }

            if (next === 'u' && /\d/.test(rtf[i + 1])) {
                const match = rtf.substring(i).match(/^u(-?\d+)/);
                if (match) {
                    let code = parseInt(match[1]);
                    if (code < 0) code += 65536;
                    output += String.fromCharCode(code);
                    i += match[0].length;
                    if (rtf[i] === ' ') i++;
                    else if (rtf[i] === '\\' && rtf[i + 1] === "'") i += 4;
                    else if (rtf[i] !== '\\' && rtf[i] !== '{' && rtf[i] !== '}') i++;
                    continue;
                }
            }

            while (i < rtf.length && /[a-zA-Z]/.test(rtf[i])) i++;
            if (i < rtf.length && (rtf[i] === '-' || /\d/.test(rtf[i]))) {
                if (rtf[i] === '-') i++;
                while (i < rtf.length && /\d/.test(rtf[i])) i++;
            }
            if (i < rtf.length && rtf[i] === ' ') i++;
            continue;
        }

        output += ch;
        i++;
    }

    return output.replace(/\n{3,}/g, '\n\n').trim();
}
