import { initDropZone, initFilePicker } from './modules/fileHandler.js';
import { extractMetadata } from './modules/metadataExtractor.js';
import { initPipeline, captureBatch, processDeep, resumeIncomplete } from './modules/pipelineManager.js';
import { renderTable, clearTable, onCellEdit, onUnpack, onView, onDelete, createColumnSelector } from './modules/tableRenderer.js';
import { mergeMetadata } from './modules/storage.js';
import { exportToCsv, exportToJson } from './modules/csvExport.js';
import { extractZipContents } from './parsers/zipHandler.js';
import { openViewer, initViewer } from './modules/fileViewer.js';
import { saveFiles, loadFiles, loadSingleFile, clearFiles, cleanOrphans, getCacheStats } from './modules/fileCache.js';
import { formatBytes } from './modules/utils.js';
import {
    listBatches, createBatch, renameBatch, deleteBatch, getBatch,
    getActiveBatchId, setActiveBatchId,
    saveBatchMetadata, loadBatchMetadata,
    recordExport, checkDeleteSafety,
    migrateLegacyData, defaultBatchName, getStorageUsage,
} from './modules/batchManager.js';
import { dialog } from './modules/dialog.js';
import { TABLE_PAGE_SIZE } from './modules/config.js';
import {
    listMappings, createMapping, renameMapping, deleteMapping, duplicateMapping,
    getActiveMappingId, setActiveMappingId, getMapping, applyMappingToRecords,
} from './modules/mappingManager.js';
import { openMappingEditor, initMappingEditor, onApplyToBatch } from './modules/mappingEditor.js';
import { initInfoPages, showAbout, showGuide } from './modules/infoPages.js';

let currentMetadata = [];
let nextSeq = 1; // Sequential counter for ordering (newest first)

// Map Grid.js column IDs back to metadata field names for editing
const COL_FIELD_MAP = {
    refCode: 'referenceCode', name: 'name', path: 'path', category: 'category',
    ext: 'extension', mime: 'type', size: 'size', modified: 'lastModified',
    created: 'createdDate', author: 'author', title: 'title',
    description: 'description', level: 'levelOfDescription',
    language: 'language', extent: 'extent',
    source: 'source', notes: 'notes', excerpt: 'excerpt',
};

document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('dropZone');
    const filePicker = document.getElementById('filePicker');
    const gridWrapper = document.getElementById('gridWrapper');
    const fileCount = document.getElementById('fileCount');
    const btnClear = document.getElementById('btnClear');
    const btnExport = document.getElementById('btnExport');
    const exportMenu = document.getElementById('exportMenu');
    const btnExportCsv = document.getElementById('btnExportCsv');
    const btnExportJson = document.getElementById('btnExportJson');
    const btnClearCache = document.getElementById('btnClearCache');
    const colSelectorSlot = document.getElementById('colSelectorSlot');
    const progressBar = document.getElementById('progressBar');
    const progressFill = document.getElementById('progressFill');
    const progressLabel = document.getElementById('progressLabel');
    const progressSublabel = document.getElementById('progressSublabel');

    // Initialize column selector — place in stable slot above the grid
    const colSelector = createColumnSelector();
    colSelectorSlot.appendChild(colSelector);

    // Initialize file viewer modal
    initViewer();

    // Initialize mapping editor modal + dropdown
    initMappingEditor();
    initMappingUI();

    // Handle "Apply to batch" from mapping editor
    onApplyToBatch(async (mapping) => {
        if (currentMetadata.length === 0) {
            showToast('No records in this batch');
            return;
        }
        const confirmed = await dialog.danger(
            'This will permanently change all records in this batch. There is no undo.',
            { title: 'Apply mapping to batch', confirmLabel: 'Apply', cancelLabel: 'Cancel' }
        );
        if (!confirmed) return;

        const count = applyMappingToRecords(mapping, currentMetadata, formatBytes);
        renderTable(gridWrapper, sortedMetadata());
        await autoSave();
        showToast(`Mapping applied to ${count} record${count !== 1 ? 's' : ''}`);
    });

    // Initialize info pages (About / Guide)
    initInfoPages();
    document.getElementById('btnAbout').addEventListener('click', showAbout);
    document.getElementById('btnGuide').addEventListener('click', showGuide);

    // Handle View button clicks — lazy-load from cache if needed
    onView(async (item) => {
        if (!item._file) {
            showToast('Loading from cache...');
            const file = await loadSingleFile(item.id, item.name, item.type);
            if (file) {
                item._file = file;
            } else {
                showToast('File not available — drop it again to re-cache');
                return;
            }
        }
        openViewer(item);
    });

    // Handle Delete button clicks
    onDelete((id) => {
        currentMetadata = currentMetadata.filter(m => m.id !== id);
        renderTable(gridWrapper, sortedMetadata());
        updateCount();
        autoSave();
        showToast('File removed');
    });

    // ── Batch UI ────────────────────────────────────────

    const batchToggle = document.getElementById('batchToggle');
    const batchDropdown = document.getElementById('batchDropdown');
    const batchLabel = document.getElementById('batchLabel');

    function renderBatchDropdown() {
        const batches = listBatches();
        batchDropdown.innerHTML = '';

        // "New batch..." button at top
        const newItem = document.createElement('div');
        newItem.className = 'batch-item batch-new';
        newItem.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> New batch\u2026';
        newItem.addEventListener('click', (e) => {
            e.stopPropagation();
            closeBatchDropdown();
            promptNewBatch();
        });
        batchDropdown.appendChild(newItem);

        if (batches.length > 0) {
            const sep = document.createElement('div');
            sep.className = 'batch-sep';
            batchDropdown.appendChild(sep);
        }

        const activeId = getActiveBatchId();
        for (const b of batches) {
            const item = document.createElement('div');
            item.className = 'batch-item' + (b.id === activeId ? ' active' : '');
            item.dataset.batchId = b.id;

            const label = document.createElement('span');
            label.className = 'batch-item-label';
            label.textContent = b.name;
            label.title = `${b.fileCount} file${b.fileCount !== 1 ? 's' : ''} · Created ${new Date(b.createdAt).toLocaleDateString()}`;
            item.appendChild(label);

            const actions = document.createElement('span');
            actions.className = 'batch-item-actions';

            // Rename
            const renameBtn = document.createElement('button');
            renameBtn.className = 'batch-action-btn';
            renameBtn.title = 'Rename batch';
            renameBtn.setAttribute('aria-label', 'Rename batch');
            renameBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
            renameBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closeBatchDropdown();
                promptRenameBatch(b);
            });
            actions.appendChild(renameBtn);

            // Delete
            const delBtn = document.createElement('button');
            delBtn.className = 'batch-action-btn batch-action-delete';
            delBtn.title = 'Delete batch';
            delBtn.setAttribute('aria-label', 'Delete batch');
            delBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closeBatchDropdown();
                confirmDeleteBatch(b);
            });
            actions.appendChild(delBtn);

            item.appendChild(actions);

            // Click to switch batch
            item.addEventListener('click', (e) => {
                if (e.target.closest('.batch-action-btn')) return;
                closeBatchDropdown();
                switchBatch(b.id);
            });

            batchDropdown.appendChild(item);
        }
    }

    function updateBatchLabel() {
        const activeId = getActiveBatchId();
        const batch = activeId ? getBatch(activeId) : null;
        batchLabel.textContent = batch ? batch.name : 'No batch';
    }

    function openBatchDropdown() {
        renderBatchDropdown();
        batchDropdown.classList.add('open');
        batchToggle.setAttribute('aria-expanded', 'true');
    }

    function closeBatchDropdown() {
        batchDropdown.classList.remove('open');
        batchToggle.setAttribute('aria-expanded', 'false');
    }

    batchToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        if (batchDropdown.classList.contains('open')) {
            closeBatchDropdown();
        } else {
            openBatchDropdown();
        }
    });

    document.addEventListener('click', (e) => {
        if (!batchDropdown.contains(e.target) && e.target !== batchToggle) {
            closeBatchDropdown();
        }
    });

    async function promptNewBatch() {
        const name = await dialog.prompt('Batch name:', defaultBatchName());
        if (name === null) return; // cancelled
        const batch = createBatch(name || undefined);
        currentMetadata = [];
        nextSeq = 1;
        renderTable(gridWrapper, currentMetadata);
        updateCount();
        updateBatchLabel();
        updateCacheStatus();
        showToast(`Created batch "${batch.name}"`);
    }

    async function promptRenameBatch(batch) {
        const name = await dialog.prompt('Rename batch:', batch.name);
        if (name === null || name.trim() === '') return;
        renameBatch(batch.id, name.trim());
        updateBatchLabel();
        showToast(`Renamed to "${name.trim()}"`);
    }

    async function confirmDeleteBatch(batch) {
        // Safety check — warn about unexported data
        const safety = checkDeleteSafety(batch.id);
        if (!safety.safe) {
            const exportFirst = await dialog.confirm(safety.reason, {
                title: 'Unexported data',
                confirmLabel: 'Export CSV first',
                cancelLabel: 'Skip',
            });
            if (exportFirst) {
                // Load that batch's data and export
                const data = await loadBatchMetadata(batch.id);
                if (data.length > 0) {
                    const count = exportToCsv(data);
                    recordExport(batch.id, count);
                    showToast('CSV exported');
                }
                return; // Don't delete — user chose to export instead
            }
        }

        const yes = await dialog.danger(`Delete batch "${batch.name}"? This cannot be undone.`, {
            title: 'Delete batch',
        });
        if (!yes) return;

        await deleteBatch(batch.id);

        // Switch to whatever is now active
        const activeId = getActiveBatchId();
        if (activeId) {
            switchBatch(activeId);
        } else {
            currentMetadata = [];
            nextSeq = 1;
            clearTable(gridWrapper);
            updateCount();
            updateBatchLabel();
            updateCacheStatus();
        }
        showToast(`Deleted batch "${batch.name}"`);
    }

    async function switchBatch(batchId) {
        // Save current batch first
        await autoSave();

        setActiveBatchId(batchId);
        const loaded = await loadBatchMetadata(batchId);
        currentMetadata = loaded;
        nextSeq = computeNextSeq(currentMetadata);
        renderTable(gridWrapper, sortedMetadata());
        updateCount();
        updateBatchLabel();

        // Restore File objects from IndexedDB
        await loadFiles(currentMetadata);
        await cleanOrphans(currentMetadata);
        renderTable(gridWrapper, sortedMetadata());
        updateCacheStatus();
    }

    /**
     * Ensure we have an active batch. Creates one if needed.
     * Called before adding files when no batch exists.
     */
    function ensureActiveBatch() {
        let activeId = getActiveBatchId();
        if (activeId && getBatch(activeId)) return activeId;
        const batch = createBatch();
        updateBatchLabel();
        showToast(`Created batch "${batch.name}"`);
        return batch.id;
    }

    // ── Ordering ────────────────────────────────────────

    function computeNextSeq(metadata) {
        let max = 0;
        for (const item of metadata) {
            if (item._seq && item._seq > max) max = item._seq;
        }
        return max + 1;
    }

    function assignSeq(metadataArray) {
        for (const item of metadataArray) {
            if (!item._seq) {
                item._seq = nextSeq++;
            }
        }
    }

    /**
     * Assign reference codes to items that don't have one yet.
     * Format: Temp/<batchName>/<0000001>
     */
    function assignReferenceCodes(metadataArray) {
        const activeId = getActiveBatchId();
        const batch = activeId ? getBatch(activeId) : null;
        const batchName = batch ? batch.name : 'Untitled';

        // Find the highest existing ref number in this batch
        let maxNum = 0;
        for (const item of currentMetadata) {
            if (item.referenceCode) {
                const match = item.referenceCode.match(/\/(\d+)$/);
                if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
            }
        }

        for (const item of metadataArray) {
            if (!item.referenceCode) {
                maxNum++;
                item.referenceCode = `Temp/${batchName}/${String(maxNum).padStart(7, '0')}`;
            }
        }
    }

    function sortedMetadata() {
        // Newest first — highest _seq first
        return [...currentMetadata].sort((a, b) => (b._seq || 0) - (a._seq || 0));
    }

    // ── Startup ─────────────────────────────────────────

    (async () => {
        // Initialize worker pool (non-blocking — falls back to main thread if unsupported)
        initPipeline();

        // Migrate legacy data if present (localStorage → IndexedDB)
        const migrated = await migrateLegacyData();
        if (migrated) {
            showToast(`Migrated existing data into batch "${migrated.name}"`);
        }

        // Load active batch
        const activeId = getActiveBatchId();
        if (activeId && getBatch(activeId)) {
            currentMetadata = await loadBatchMetadata(activeId);
            nextSeq = computeNextSeq(currentMetadata);

            // Backfill _status for records from before the pipeline was added
            for (const item of currentMetadata) {
                if (!item._status) item._status = 'complete';
            }

            renderTable(gridWrapper, sortedMetadata());
            updateCount();
            updateBatchLabel();

            await loadFiles(currentMetadata);
            await cleanOrphans(currentMetadata);
            renderTable(gridWrapper, sortedMetadata());
            updateCacheStatus();

            // Resume any incomplete processing from a prior session
            const resumed = await resumeIncomplete(
                currentMetadata,
                loadSingleFile,
                {
                    onFileComplete: (fileId, result) => {
                        const record = currentMetadata.find(m => m.id === fileId);
                        if (record) {
                            record.deepMeta = result.deepMeta;
                            record.excerpt = result.excerpt || '';
                            record.createdDate = result.createdDate;
                            record.author = result.author;
                            record.title = result.title;
                            record.language = result.language || '';
                            record.extent = result.extent || '';
                            record._status = 'complete';
                        }
                        scheduleTableRefresh();
                        scheduleAutoSave();
                    },
                    onProgress: (done, total) => {
                        showProgress(`Resuming analysis: ${done} of ${total}`, Math.round((done / total) * 100), '');
                    },
                    onAllComplete: () => {
                        hideProgress();
                        renderTable(gridWrapper, sortedMetadata());
                        autoSave();
                    },
                    onError: (fileId, errorMsg) => {
                        const record = currentMetadata.find(m => m.id === fileId);
                        if (record) record._status = 'error';
                        scheduleTableRefresh();
                    },
                }
            );
            if (resumed > 0) {
                showToast(`Resuming analysis of ${resumed} file${resumed !== 1 ? 's' : ''}`);
            }
        } else {
            updateBatchLabel();
            updateCacheStatus();
        }
    })();

    // ── Helpers ─────────────────────────────────────────

    function updateCount() {
        const n = currentMetadata.length;
        fileCount.textContent = `${n} file${n !== 1 ? 's' : ''}`;
    }

    async function updateCacheStatus() {
        const cacheStats = await getCacheStats();
        const el = document.getElementById('cacheStatus');
        if (el) {
            if (cacheStats.count > 0) {
                el.textContent = `Cache: ${cacheStats.count} file${cacheStats.count !== 1 ? 's' : ''}, ${formatBytes(cacheStats.size)}`;
                el.title = `${cacheStats.count} files cached in IndexedDB using ${formatBytes(cacheStats.size)}`;
            } else {
                el.textContent = '';
            }
        }
        updateStorageStats(cacheStats);
    }

    async function updateStorageStats(cacheStats) {
        const el = document.getElementById('storageStats');
        if (!el) return;
        const usage = await getStorageUsage();
        const cacheBytes = cacheStats ? cacheStats.size : 0;
        const totalBytes = usage.bytes + cacheBytes;
        const parts = [];
        parts.push(`${usage.batchCount} batch${usage.batchCount !== 1 ? 'es' : ''}`);
        parts.push(`${formatBytes(usage.bytes)} metadata`);
        if (cacheBytes > 0) {
            parts.push(`${formatBytes(cacheBytes)} file cache`);
        }
        el.textContent = `Storage: ${parts.join(' · ')} · ${formatBytes(totalBytes)} total`;
    }

    async function autoSave() {
        const activeId = getActiveBatchId();
        if (!activeId) return;
        await saveBatchMetadata(activeId, currentMetadata);
        saveFiles(currentMetadata).then(() => updateCacheStatus());
    }

    // Debounced variants for Tier 2 streaming (avoid thrashing during rapid results)
    let refreshTimer = null;
    function scheduleTableRefresh() {
        if (refreshTimer) return;
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            renderTable(gridWrapper, sortedMetadata());
        }, 200);
    }

    let saveTimer = null;
    function scheduleAutoSave() {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            autoSave();
        }, 1000);
    }

    // ── Cell editing ────────────────────────────────────

    onCellEdit((rowIndex, fieldId, newValue) => {
        const field = COL_FIELD_MAP[fieldId];
        if (!field || field === 'size') return;

        const pageSize = TABLE_PAGE_SIZE;
        const pageEl = document.querySelector('.gridjs-currentPage');
        const currentPage = pageEl ? parseInt(pageEl.textContent) - 1 : 0;
        const trueIndex = currentPage * pageSize + rowIndex;

        // We display in sorted order, so map back
        const sorted = sortedMetadata();
        if (trueIndex >= 0 && trueIndex < sorted.length) {
            const item = sorted[trueIndex];
            const real = currentMetadata.find(m => m.id === item.id);
            if (real) {
                real[field] = newValue;
                autoSave();
                showToast(`Updated ${field}`);
            }
        }
    });

    // ── Progress bar ────────────────────────────────────

    function showProgress(label, pct, sublabel) {
        progressBar.classList.remove('hidden');
        progressFill.style.width = `${pct}%`;
        progressLabel.textContent = label;
        progressSublabel.textContent = sublabel || '';
    }

    function hideProgress() {
        progressBar.classList.add('hidden');
        progressFill.style.width = '0%';
        progressLabel.textContent = '';
        progressSublabel.textContent = '';
    }

    // ── File handling ───────────────────────────────────

    async function handleFiles(fileEntries) {
        const totalFiles = fileEntries.length;
        const totalBytes = fileEntries.reduce((sum, e) => sum + (e.file.size || 0), 0);
        const isSingle = totalFiles === 1;

        showProgress(
            isSingle
                ? `Capturing ${fileEntries[0].file.name}`
                : `Capturing ${totalFiles} files (${formatBytes(totalBytes)})`,
            0,
            isSingle ? formatBytes(totalBytes) : 'Starting\u2026'
        );

        await new Promise(r => setTimeout(r, 0));

        try {
            ensureActiveBatch();

            // ── Tier 1: Capture — fast, files appear in table immediately ──
            const incoming = await captureBatch(fileEntries, (p) => {
                const pct = Math.round((p.done / p.total) * 100);
                showProgress(
                    `Captured ${p.done} of ${p.total} files`,
                    pct,
                    p.fileName
                );
            });

            assignSeq(incoming);
            assignReferenceCodes(incoming);
            currentMetadata = mergeMetadata(currentMetadata, incoming);
            renderTable(gridWrapper, sortedMetadata());
            updateCount();
            await autoSave();

            showToast(`${incoming.length} file${incoming.length !== 1 ? 's' : ''} captured`);

            // ── Tier 2: Deep processing — streamed results ──
            const tier2Total = incoming.length;
            showProgress(`Analyzing metadata\u2026`, 0, `0 of ${tier2Total} files`);

            processDeep(incoming, {
                onFileComplete: (fileId, result) => {
                    const record = currentMetadata.find(m => m.id === fileId);
                    if (record) {
                        record.deepMeta = result.deepMeta;
                        record.excerpt = result.excerpt || '';
                        record.createdDate = result.createdDate;
                        record.author = result.author;
                        record.title = result.title;
                        record.language = result.language || '';
                        record.extent = result.extent || '';
                        record._status = 'complete';
                    }
                    scheduleTableRefresh();
                    scheduleAutoSave();
                },
                onProgress: (done, total) => {
                    const pct = Math.round((done / total) * 100);
                    showProgress(
                        `Analyzed ${done} of ${total} files`,
                        pct,
                        `${total - done} remaining`
                    );
                },
                onAllComplete: () => {
                    hideProgress();
                    showToast('Metadata extraction complete');
                    renderTable(gridWrapper, sortedMetadata());
                    autoSave();
                },
                onError: (fileId, errorMsg) => {
                    const record = currentMetadata.find(m => m.id === fileId);
                    if (record) {
                        record._status = 'error';
                    }
                    console.warn(`[Docucata] Tier 2 error for ${fileId}:`, errorMsg);
                    scheduleTableRefresh();
                },
            });
        } catch (e) {
            hideProgress();
            console.error('[Docucata] Error processing files:', e);
            showToast('Error processing files');
        }
    }

    initDropZone(dropZone, handleFiles);
    initFilePicker(filePicker, handleFiles);

    dropZone.addEventListener('click', (e) => {
        if (e.target === filePicker || e.target.closest('.file-label')) return;
        filePicker.click();
    });

    // ── Unpack ──────────────────────────────────────────

    onUnpack(async (fileName) => {
        const entry = currentMetadata.find(m =>
            m.name === fileName && m._file && m.category === 'Archive'
        );
        if (!entry) {
            showToast('Archive file no longer available for unpacking');
            return;
        }

        showProgress(`Unpacking ${entry.name}`, 0, 'Extracting archive\u2026');
        await new Promise(r => setTimeout(r, 0));
        try {
            const basePath = entry.path.replace(/\.[^/.]+$/, '');
            const extracted = await extractZipContents(entry._file, basePath);
            if (extracted && extracted.length > 0) {
                const incoming = await extractMetadata(extracted, 'local', (p) => {
                    const pct = Math.round((p.done / p.total) * 100);
                    showProgress(
                        `Unpacking ${entry.name} — ${p.done} of ${p.total} files`,
                        pct,
                        p.fileName
                    );
                });
                // Replicate notes from archive to extracted files
                if (entry.notes) {
                    for (const item of incoming) {
                        if (!item.notes) item.notes = entry.notes;
                    }
                }
                assignSeq(incoming);
                assignReferenceCodes(incoming);
                entry._unpacked = true;
                currentMetadata = mergeMetadata(currentMetadata, incoming);
                renderTable(gridWrapper, sortedMetadata());
                updateCount();
                autoSave();
                hideProgress();
                showToast(`Unpacked ${incoming.length} file${incoming.length !== 1 ? 's' : ''} from ${entry.name}`);
            } else {
                hideProgress();
                showToast(`Could not unpack ${entry.name} — check console for details`);
            }
        } catch (e) {
            hideProgress();
            console.error(`[Docucata] Failed to unpack ${entry.name}:`, e);
            showToast(`Error unpacking ${entry.name}`);
        }
    });

    // ── Clear All ───────────────────────────────────────

    btnClear.addEventListener('click', async () => {
        const activeId = getActiveBatchId();
        if (!activeId) {
            showToast('No active batch');
            return;
        }
        const yes = await dialog.danger('Clear all files from this batch?', {
            title: 'Clear batch',
            confirmLabel: 'Clear all',
        });
        if (!yes) return;
        await saveBatchMetadata(activeId, []);
        await clearFiles();
        currentMetadata = [];
        nextSeq = 1;
        clearTable(gridWrapper);
        updateCount();
        updateCacheStatus();
        showToast('Batch cleared');
    });

    // ── Clear Previews ──────────────────────────────────

    btnClearCache.addEventListener('click', async () => {
        await clearFiles();
        for (const item of currentMetadata) {
            delete item._file;
        }
        renderTable(gridWrapper, sortedMetadata());
        updateCacheStatus();
        showToast('Previews cleared — view/unpack buttons hidden until files are re-dropped');
    });

    // ── Export menu ──────────────────────────────────────

    btnExport.addEventListener('click', (e) => {
        e.stopPropagation();
        exportMenu.classList.toggle('open');
    });

    // Close export menu on outside click
    document.addEventListener('click', () => {
        exportMenu.classList.remove('open');
    });

    function doExport(exportFn, label) {
        exportMenu.classList.remove('open');
        if (currentMetadata.length === 0) {
            showToast('No data to export');
            return;
        }
        const count = exportFn(currentMetadata);
        const activeId = getActiveBatchId();
        if (activeId && count) {
            recordExport(activeId, count);
        }
        showToast(`${label} exported`);
    }

    btnExportCsv.addEventListener('click', (e) => {
        e.stopPropagation();
        doExport(exportToCsv, 'CSV');
    });

    btnExportJson.addEventListener('click', (e) => {
        e.stopPropagation();
        doExport(exportToJson, 'JSON');
    });

});

let toastTimeout;
function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
        toast.classList.remove('visible');
    }, 2500);
}

// ── Mapping selector UI ─────────────────────────────────

function initMappingUI() {
    const selector = document.getElementById('mappingSelector');
    const toggle = document.getElementById('mappingToggle');
    const dropdown = document.getElementById('mappingDropdown');
    const label = document.getElementById('mappingLabel');

    // Render current label
    function updateLabel() {
        const id = getActiveMappingId();
        if (id) {
            const m = getMapping(id);
            label.textContent = m ? m.name : 'Default';
        } else {
            label.textContent = 'Default';
        }
    }

    // Render dropdown contents
    function renderDropdown() {
        dropdown.innerHTML = '';
        const mappings = listMappings();
        const activeId = getActiveMappingId();

        // "Default (no mapping)" option
        const defaultItem = document.createElement('button');
        defaultItem.className = 'mapping-dropdown-item' + (!activeId ? ' active' : '');
        defaultItem.innerHTML = '<span class="mapping-item-name">Default (all fields)</span>';
        defaultItem.addEventListener('click', () => {
            setActiveMappingId(null);
            updateLabel();
            selector.classList.remove('open');
        });
        dropdown.appendChild(defaultItem);

        if (mappings.length > 0) {
            const divider = document.createElement('div');
            divider.className = 'mapping-dropdown-divider';
            dropdown.appendChild(divider);
        }

        // Existing mappings
        for (const m of mappings) {
            const item = document.createElement('div');
            item.className = 'mapping-dropdown-item' + (m.id === activeId ? ' active' : '');

            const nameSpan = document.createElement('span');
            nameSpan.className = 'mapping-item-name';
            nameSpan.textContent = m.name;
            nameSpan.style.cursor = 'pointer';
            nameSpan.addEventListener('click', () => {
                setActiveMappingId(m.id);
                updateLabel();
                selector.classList.remove('open');
            });
            item.appendChild(nameSpan);

            // Action buttons (edit, rename, duplicate, delete)
            const actions = document.createElement('div');
            actions.className = 'mapping-dropdown-actions';

            // Edit
            const editBtn = document.createElement('button');
            editBtn.className = 'mapping-action-btn';
            editBtn.title = 'Edit fields';
            editBtn.textContent = '\u270E'; // pencil
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                selector.classList.remove('open');
                openMappingEditor(m.id, () => updateLabel());
            });
            actions.appendChild(editBtn);

            // Rename
            const renameBtn = document.createElement('button');
            renameBtn.className = 'mapping-action-btn';
            renameBtn.title = 'Rename';
            renameBtn.textContent = 'Aa';
            renameBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const newName = await dialog.prompt('Rename mapping:', m.name, {
                    title: 'Rename mapping',
                });
                if (newName && newName.trim()) {
                    renameMapping(m.id, newName.trim());
                    updateLabel();
                    renderDropdown();
                }
            });
            actions.appendChild(renameBtn);

            // Duplicate
            const dupeBtn = document.createElement('button');
            dupeBtn.className = 'mapping-action-btn';
            dupeBtn.title = 'Duplicate';
            dupeBtn.textContent = '\u2750'; // copy icon
            dupeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const copy = duplicateMapping(m.id);
                if (copy) {
                    setActiveMappingId(copy.id);
                    updateLabel();
                    renderDropdown();
                    showToast(`Duplicated as "${copy.name}"`);
                }
            });
            actions.appendChild(dupeBtn);

            // Delete
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'mapping-action-btn danger';
            deleteBtn.title = 'Delete';
            deleteBtn.textContent = '\u2715'; // X
            deleteBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const yes = await dialog.danger(`Delete mapping "${m.name}"?`, {
                    title: 'Delete mapping',
                });
                if (yes) {
                    deleteMapping(m.id);
                    updateLabel();
                    renderDropdown();
                    showToast('Mapping deleted');
                }
            });
            actions.appendChild(deleteBtn);

            item.appendChild(actions);
            dropdown.appendChild(item);
        }

        // "New mapping..." button
        const divider2 = document.createElement('div');
        divider2.className = 'mapping-dropdown-divider';
        dropdown.appendChild(divider2);

        const newBtn = document.createElement('button');
        newBtn.className = 'mapping-dropdown-new';
        newBtn.textContent = '+ New mapping...';
        newBtn.addEventListener('click', async () => {
            selector.classList.remove('open');
            const name = await dialog.prompt('New mapping name:', '', {
                title: 'Create mapping',
            });
            if (name && name.trim()) {
                const m = createMapping(name.trim());
                setActiveMappingId(m.id);
                updateLabel();
                // Open editor immediately
                openMappingEditor(m.id, () => updateLabel());
            }
        });
        dropdown.appendChild(newBtn);
    }

    // Toggle dropdown
    toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = selector.classList.toggle('open');
        if (isOpen) renderDropdown();
    });

    // Close on outside click
    document.addEventListener('click', () => {
        selector.classList.remove('open');
    });

    // Prevent dropdown clicks from closing
    dropdown.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    updateLabel();
}
