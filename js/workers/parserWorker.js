/**
 * Parser Worker — module worker entry point for Tier 2 deep processing.
 *
 * Imports shared source from localProvider.js (dispatchParsers + normalizeFields)
 * which in turn imports all parsers. Libraries (pdf.js, SheetJS) are loaded
 * dynamically on first use.
 *
 * Message protocol:
 *   Main → Worker:
 *     { type: 'init', config: { pdfjsCdn, pdfjsWorkerCdn, sheetjsCdn, excerptCap } }
 *     { type: 'parse', taskId, fileId, fileName, extension, category, mime, fileSize, buffer (transferred) }
 *
 *   Worker → Main:
 *     { type: 'ready' }
 *     { type: 'result', taskId, fileId, deepMeta, excerpt, createdDate, author, title, language, extent }
 *     { type: 'error', taskId, fileId, error }
 */

import { dispatchParsers, normalizeFields } from '../providers/localProvider.js';

let config = {};
let librariesLoaded = false;

/**
 * Load CDN libraries into worker scope.
 * pdf.js: dynamic ES module import.
 * SheetJS: fetch + eval (UMD bundle, standard pattern for module workers).
 */
async function loadLibraries() {
    if (librariesLoaded) return;

    // pdf.js
    if (config.pdfjsCdn) {
        try {
            const pdfjsModule = await import(config.pdfjsCdn);
            self.pdfjsLib = pdfjsModule;
            if (config.pdfjsWorkerCdn) {
                pdfjsModule.GlobalWorkerOptions.workerSrc = config.pdfjsWorkerCdn;
            }
            console.log('[ParserWorker] pdf.js loaded');
        } catch (e) {
            console.warn('[ParserWorker] Failed to load pdf.js:', e.message);
        }
    }

    // SheetJS (UMD — fetch + eval)
    if (config.sheetjsCdn) {
        try {
            const resp = await fetch(config.sheetjsCdn);
            const text = await resp.text();
            (0, eval)(text);
            // UMD sets self.XLSX in worker scope
            console.log('[ParserWorker] SheetJS loaded');
        } catch (e) {
            console.warn('[ParserWorker] Failed to load SheetJS:', e.message);
        }
    }

    librariesLoaded = true;
}

self.onmessage = async function(e) {
    const msg = e.data;

    if (msg.type === 'init') {
        config = msg.config || {};
        try {
            await loadLibraries();
            self.postMessage({ type: 'ready' });
        } catch (err) {
            console.error('[ParserWorker] Init failed:', err);
            self.postMessage({ type: 'ready' }); // still ready, just without some libs
        }
        return;
    }

    if (msg.type === 'parse') {
        const { taskId, fileId, fileName, extension, category, mime, fileSize, buffer } = msg;

        try {
            const { deepMeta, excerpt } = await dispatchParsers(buffer, extension, category, fileSize);
            const { createdDate, author, title, language, extent } = normalizeFields(deepMeta);

            self.postMessage({
                type: 'result',
                taskId,
                fileId,
                deepMeta,
                excerpt,
                createdDate,
                author,
                title,
                language,
                extent,
            });
        } catch (err) {
            self.postMessage({
                type: 'error',
                taskId,
                fileId,
                error: err.message || String(err),
            });
        }
        return;
    }
};
