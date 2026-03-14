/**
 * File Viewer — renders files in a modal overlay.
 * Supports: PDFs (via pdf.js), images (native), text/code (plain text).
 */

import { stripRtf } from './excerptExtractor.js';
import { extractDocText } from '../parsers/docTextExtractor.js';

const TEXT_EXTS = [
    'txt', 'csv', 'json', 'xml', 'html', 'css', 'js', 'ts', 'md',
    'log', 'ini', 'cfg', 'yaml', 'yml', 'toml', 'sh', 'bat', 'py',
    'rb', 'java', 'c', 'cpp', 'h', 'rs', 'go', 'php', 'sql',
];

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'];
const SPREADSHEET_EXTS = ['xlsx', 'xls', 'ods', 'csv'];
const AUDIO_EXTS = ['mp3', 'wav', 'wave', 'flac', 'ogg', 'oga', 'aif', 'aiff', 'm4a', 'aac', 'opus'];

let modalEl = null;

function getModal() {
    if (!modalEl) {
        modalEl = document.getElementById('viewerModal');
    }
    return modalEl;
}

/**
 * Open the viewer modal for a metadata item.
 * Requires item._file to be a File reference.
 */
export async function openViewer(item) {
    if (!item._file) {
        console.warn('[Docucata:Viewer] No File reference available — file was loaded from storage');
        return;
    }

    const modal = getModal();
    const titleEl = modal.querySelector('.viewer-title');
    const bodyEl = modal.querySelector('.viewer-body');
    const loader = modal.querySelector('.viewer-loading');

    titleEl.textContent = item.name;
    bodyEl.innerHTML = '';
    loader.classList.remove('hidden');
    modal.classList.add('open');

    const ext = item.extension?.toLowerCase();

    try {
        if (ext === 'pdf') {
            await renderPdf(bodyEl, item._file);
        } else if (SPREADSHEET_EXTS.includes(ext)) {
            await renderSpreadsheet(bodyEl, item._file);
        } else if (ext === 'docx') {
            await renderDocx(bodyEl, item._file);
        } else if (ext === 'doc' || ext === 'dot') {
            await renderDoc(bodyEl, item._file);
        } else if (ext === 'rtf') {
            await renderRtf(bodyEl, item._file);
        } else if (AUDIO_EXTS.includes(ext)) {
            renderAudio(bodyEl, item._file, item.deepMeta);
        } else if (IMAGE_EXTS.includes(ext)) {
            renderImage(bodyEl, item._file);
        } else if (TEXT_EXTS.includes(ext)) {
            await renderText(bodyEl, item._file);
        } else {
            bodyEl.innerHTML = '<p class="viewer-unsupported">Preview not available for this file type.</p>';
        }
    } catch (e) {
        console.error('[Docucata:Viewer] Error rendering file:', e);
        bodyEl.innerHTML = `<p class="viewer-error">Error loading file: ${e.message}</p>`;
    }

    loader.classList.add('hidden');
}

/**
 * Close the viewer modal.
 */
export function closeViewer() {
    const modal = getModal();
    modal.classList.remove('open');
    const bodyEl = modal.querySelector('.viewer-body');
    // Clean up object URLs
    const imgs = bodyEl.querySelectorAll('img[src^="blob:"]');
    imgs.forEach(img => URL.revokeObjectURL(img.src));
    const audios = bodyEl.querySelectorAll('audio[src^="blob:"]');
    audios.forEach(a => { a.pause(); URL.revokeObjectURL(a.src); });
    bodyEl.innerHTML = '';
    // Reset spinner to visible state for next open
    modal.querySelector('.viewer-loading').classList.remove('hidden');
}

/**
 * Initialize modal close handlers.
 */
export function initViewer() {
    const modal = getModal();
    if (!modal) return;

    modal.querySelector('.viewer-close').addEventListener('click', closeViewer);
    modal.querySelector('.viewer-backdrop').addEventListener('click', closeViewer);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('open')) {
            closeViewer();
        }
    });
}

/**
 * Render a PDF using pdf.js.
 */
async function renderPdf(container, file) {
    if (typeof pdfjsLib === 'undefined') {
        container.innerHTML = '<p class="viewer-error">PDF.js library not loaded.</p>';
        return;
    }

    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

    container.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'viewer-pdf-wrapper';

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const scale = 1.5;
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement('canvas');
        canvas.className = 'viewer-pdf-page';
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;

        wrapper.appendChild(canvas);
    }

    container.appendChild(wrapper);
}

/**
 * Render a DOCX file using mammoth.js.
 * Converts DOCX to semantic HTML (headings, lists, tables, bold/italic).
 */
async function renderDocx(container, file) {
    if (typeof mammoth === 'undefined') {
        container.innerHTML = '<p class="viewer-error">mammoth.js library not loaded.</p>';
        return;
    }

    let result;
    try {
        const buffer = await file.arrayBuffer();
        result = await mammoth.convertToHtml({ arrayBuffer: buffer });
    } catch (e) {
        container.innerHTML = `<p class="viewer-error">Failed to render DOCX: ${e.message}</p>`;
        console.error('[Docucata:Viewer] mammoth.js error:', e);
        return;
    }

    container.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'viewer-docx';
    wrapper.innerHTML = result.value;

    // Log any conversion warnings
    if (result.messages?.length > 0) {
        console.warn('[Docucata:Viewer] mammoth.js warnings:', result.messages);
    }

    container.appendChild(wrapper);
}

/**
 * Render a legacy .doc file by extracting its text content.
 * Shows plain text since full formatting would require a full Word parser.
 */
async function renderDoc(container, file) {
    const text = await extractDocText(file);
    container.innerHTML = '';
    if (text) {
        const wrapper = document.createElement('div');
        wrapper.className = 'viewer-docx';
        const pre = document.createElement('pre');
        pre.className = 'viewer-text';
        pre.textContent = text;
        wrapper.appendChild(pre);
        container.appendChild(wrapper);
    } else {
        container.innerHTML = '<p class="viewer-unsupported">Could not extract text from this .doc file.</p>';
    }
}

/**
 * Render an image file.
 */
function renderImage(container, file) {
    const url = URL.createObjectURL(file);
    container.innerHTML = '';
    const img = document.createElement('img');
    img.className = 'viewer-image';
    img.src = url;
    img.alt = file.name;
    container.appendChild(img);
}

/**
 * Render a spreadsheet using SheetJS.
 * Shows sheet tabs and renders the active sheet as an HTML table.
 */
async function renderSpreadsheet(container, file) {
    if (typeof XLSX === 'undefined') {
        container.innerHTML = '<p class="viewer-error">SheetJS library not loaded. Check that the CDN script loaded successfully.</p>';
        console.error('[Docucata:Viewer] XLSX global not found — SheetJS CDN may have failed to load');
        return;
    }

    let wb;
    try {
        const buffer = await file.arrayBuffer();
        wb = XLSX.read(buffer, { type: 'array' });
    } catch (e) {
        container.innerHTML = `<p class="viewer-error">Failed to parse spreadsheet: ${e.message}</p>`;
        console.error('[Docucata:Viewer] SheetJS parse error:', e);
        return;
    }

    if (!wb.SheetNames || wb.SheetNames.length === 0) {
        container.innerHTML = '<p class="viewer-unsupported">No sheets found in workbook.</p>';
        return;
    }

    container.innerHTML = '';

    // Sheet tab bar
    if (wb.SheetNames.length > 1) {
        const tabBar = document.createElement('div');
        tabBar.className = 'viewer-sheet-tabs';

        wb.SheetNames.forEach((name, i) => {
            const tab = document.createElement('button');
            tab.className = 'viewer-sheet-tab' + (i === 0 ? ' active' : '');
            tab.textContent = name;
            tab.addEventListener('click', () => {
                tabBar.querySelectorAll('.viewer-sheet-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                renderSheet(tableWrap, wb.Sheets[name]);
            });

            // Indicate hidden sheets
            if (wb.Workbook?.Sheets?.[i]?.Hidden) {
                tab.classList.add('hidden-sheet');
                tab.title = 'Hidden sheet';
            }

            tabBar.appendChild(tab);
        });

        container.appendChild(tabBar);
    }

    // Table container
    const tableWrap = document.createElement('div');
    tableWrap.className = 'viewer-sheet-wrap';
    container.appendChild(tableWrap);

    // Render first sheet
    renderSheet(tableWrap, wb.Sheets[wb.SheetNames[0]]);
}

/**
 * Render a single worksheet as an HTML table.
 */
function renderSheet(container, ws) {
    if (!ws || !ws['!ref']) {
        container.innerHTML = '<p class="viewer-unsupported">Sheet is empty.</p>';
        return;
    }

    const html = XLSX.utils.sheet_to_html(ws, { editable: false });
    container.innerHTML = html;

    // Style the generated table
    const table = container.querySelector('table');
    if (table) {
        table.className = 'viewer-sheet-table';
    }
}

/**
 * Render an RTF file by stripping control words and showing plain text.
 * Handles: groups, control words with parameters, hex escapes, Unicode.
 */
async function renderRtf(container, file) {
    const raw = await file.text();
    const text = stripRtf(raw);

    container.innerHTML = '';
    const pre = document.createElement('pre');
    pre.className = 'viewer-text';
    pre.textContent = text;
    container.appendChild(pre);
}

// stripRtf is imported from excerptExtractor.js

/**
 * Render an audio file with native player and metadata summary.
 */
function renderAudio(container, file, deepMeta) {
    const url = URL.createObjectURL(file);
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'viewer-audio-wrapper';

    // Native audio player
    const audio = document.createElement('audio');
    audio.className = 'viewer-audio-player';
    audio.controls = true;
    audio.src = url;
    wrapper.appendChild(audio);

    // Metadata summary card
    if (deepMeta) {
        const card = document.createElement('div');
        card.className = 'viewer-audio-meta';

        const displayFields = ['title', 'artist', 'album', 'year', 'genre', 'track',
            'composer', 'albumArtist', 'duration', 'bitrate', 'sampleRate', 'channels',
            'format', 'encoder', 'copyright', 'bpm'];

        const rows = displayFields
            .filter(f => deepMeta[f] !== undefined && deepMeta[f] !== null)
            .map(f => {
                let val = deepMeta[f];
                if (f === 'sampleRate') val = `${val} Hz`;
                if (f === 'channels') val = val === 1 ? 'Mono' : val === 2 ? 'Stereo' : `${val}ch`;
                const label = f.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
                return `<tr><td class="audio-meta-label">${label}</td><td>${escapeHtml(String(val))}</td></tr>`;
            }).join('');

        if (rows) {
            card.innerHTML = `<table class="audio-meta-table">${rows}</table>`;
            wrapper.appendChild(card);
        }
    }

    container.appendChild(wrapper);
}

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render a text/code file.
 */
async function renderText(container, file) {
    const text = await file.text();
    container.innerHTML = '';
    const pre = document.createElement('pre');
    pre.className = 'viewer-text';
    pre.textContent = text;
    container.appendChild(pre);
}
