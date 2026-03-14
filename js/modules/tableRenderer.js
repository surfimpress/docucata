import { formatBytes, formatDate } from './utils.js';
import { dialog } from './dialog.js';
import { TABLE_PAGE_SIZE, CELL_PREVIEW_LENGTH } from './config.js';

let gridInstance = null;
let gridWrapperEl = null;
let onCellEditCallback = null;
let onUnpackCallback = null;
let onViewCallback = null;
let onDeleteCallback = null;
let currentData = [];

const ARCHIVE_EXTS = ['zip', 'gz', 'tar', '7z', 'rar', 'bz2', 'xz'];
const VIEWABLE_EXTS = [
    'pdf', 'doc', 'dot', 'docx', 'rtf',
    'xlsx', 'xls', 'ods',
    'mp3', 'wav', 'wave', 'flac', 'ogg', 'oga', 'aif', 'aiff', 'm4a', 'aac', 'opus',
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico',
    'txt', 'csv', 'json', 'xml', 'html', 'css', 'js', 'ts', 'md',
    'log', 'ini', 'cfg', 'yaml', 'yml', 'toml', 'sh', 'bat', 'py',
    'rb', 'java', 'c', 'cpp', 'h', 'rs', 'go', 'php', 'sql',
];

// All available columns — id is used for toggle state, hidden controls default visibility
const ALL_COLUMNS = [
    { id: 'refCode', name: 'Ref Code', width: '10%', hidden: false },
    { id: 'name', name: 'Name', width: '18%', hidden: false },
    { id: 'path', name: 'Path', width: '10%', hidden: false },
    { id: 'category', name: 'Category', width: '6%', hidden: false },
    { id: 'ext', name: 'Ext', width: '4%', hidden: false },
    { id: 'mime', name: 'MIME Type', width: '9%', hidden: true },
    { id: 'size', name: 'Size', width: '5%', hidden: false },
    { id: 'modified', name: 'Modified', width: '10%', hidden: false },
    { id: 'created', name: 'Created', width: '10%', hidden: false },
    { id: 'author', name: 'Author', width: '7%', hidden: false },
    { id: 'title', name: 'Title', width: '7%', hidden: false },
    { id: 'description', name: 'Description', width: '10%', hidden: true },
    { id: 'level', name: 'Level', width: '5%', hidden: true },
    { id: 'language', name: 'Language', width: '5%', hidden: true },
    { id: 'extent', name: 'Extent', width: '5%', hidden: true },
    { id: 'source', name: 'Source', width: '5%', hidden: true },
    { id: 'notes', name: 'Notes', width: '10%', hidden: false },
    { id: 'excerpt', name: 'Excerpt', width: '15%', hidden: true },
    { id: 'actions', name: '', width: '52px', hidden: false, isActions: true },
    { id: 'delete', name: '', width: '32px', hidden: false, isDelete: true },
];

// Load saved column visibility from localStorage
const STORAGE_KEY = 'docucata_columns';
let columnVisibility = loadColumnVisibility();

function loadColumnVisibility() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) return JSON.parse(saved);
    } catch {}
    // Default: use the hidden flag from ALL_COLUMNS
    const vis = {};
    ALL_COLUMNS.forEach(c => { vis[c.id] = !c.hidden; });
    return vis;
}

function saveColumnVisibility() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(columnVisibility));
}

function getVisibleColumns() {
    return ALL_COLUMNS.filter(c => c.isActions || c.isDelete || columnVisibility[c.id] !== false);
}

function buildGridColumns() {
    return getVisibleColumns().map(col => {
        if (col.isActions) {
            return {
                id: 'actions',
                name: '',
                width: col.width,
                sort: false,
                formatter: (cell) => {
                    if (!cell) return '';
                    // cell is a comma-separated list of action flags
                    const flags = cell.split(',');
                    let html = '<span class="action-btns">';
                    if (flags.includes('view')) {
                        html += '<button class="btn-action btn-view" title="View file"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>';
                    }
                    if (flags.includes('meta')) {
                        html += '<button class="btn-action btn-detail" title="Deep metadata"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></button>';
                    }
                    if (flags.includes('unpack')) {
                        html += '<button class="btn-action btn-unpack" title="Unpack archive"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><polyline points="9 14 12 17 15 14"/></svg></button>';
                    }
                    if (flags.includes('unpacked')) {
                        html += '<button class="btn-action btn-unpack disabled" title="Already unpacked" disabled><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><polyline points="9 14 12 17 15 14"/></svg></button>';
                    }
                    html += '</span>';
                    return gridjs.html(html);
                }
            };
        }
        if (col.isDelete) {
            return {
                id: 'delete',
                name: '',
                width: col.width,
                sort: false,
                formatter: () => gridjs.html('<button class="btn-action btn-delete" title="Delete row"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>'),
            };
        }
        return { id: col.id, name: col.name, sort: true, width: col.width };
    });
}

/**
 * Set a callback for when the user edits a cell.
 */
export function onCellEdit(callback) {
    onCellEditCallback = callback;
}

/**
 * Set a callback for when the user clicks an Unpack button.
 */
export function onUnpack(callback) {
    onUnpackCallback = callback;
}

/**
 * Set a callback for when the user clicks the View button.
 */
export function onView(callback) {
    onViewCallback = callback;
}

/**
 * Set a callback for when the user clicks the Delete button.
 * Callback receives the item's id.
 */
export function onDelete(callback) {
    onDeleteCallback = callback;
}

/**
 * Initialize the column selector dropdown.
 * Returns the wrapper element so the caller can place it anywhere.
 */
export function createColumnSelector() {
    const btn = document.createElement('button');
    btn.className = 'btn btn-icon btn-secondary';
    btn.type = 'button';
    btn.title = 'Toggle columns';
    btn.setAttribute('aria-label', 'Toggle columns');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>';

    const dropdown = document.createElement('div');
    dropdown.className = 'col-selector-dropdown';
    dropdown.style.display = 'none';

    function buildItems() {
        dropdown.innerHTML = '';
        ALL_COLUMNS.forEach(col => {
            if (col.isActions || col.isDelete) return;
            const label = document.createElement('label');
            label.className = 'col-selector-item';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = columnVisibility[col.id] !== false;
            cb.addEventListener('change', () => {
                columnVisibility[col.id] = cb.checked;
                saveColumnVisibility();
                rebuildGrid();
            });
            label.appendChild(cb);
            label.appendChild(document.createTextNode(' ' + col.name));
            dropdown.appendChild(label);
        });
    }

    buildItems();

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = dropdown.style.display !== 'none';
        dropdown.style.display = isOpen ? 'none' : 'block';
    });

    document.addEventListener('click', (e) => {
        if (!dropdown.contains(e.target) && e.target !== btn) {
            dropdown.style.display = 'none';
        }
    });

    const wrapper = document.createElement('div');
    wrapper.className = 'col-selector-wrapper';
    wrapper.appendChild(btn);
    wrapper.appendChild(dropdown);
    return wrapper;
}

function rebuildGrid() {
    if (gridInstance && gridWrapperEl) {
        gridInstance.updateConfig({
            columns: buildGridColumns(),
            data: filterDataToVisibleColumns(currentData),
        }).forceRender();
    }
}

/**
 * Render the full metadata array using Grid.js.
 */
export function renderTable(wrapperEl, metadataArray) {
    gridWrapperEl = wrapperEl;
    currentData = metadataArray;
    const data = filterDataToVisibleColumns(metadataArray);

    if (gridInstance) {
        gridInstance.updateConfig({ columns: buildGridColumns(), data }).forceRender();
    } else {
        gridInstance = new gridjs.Grid({
            columns: buildGridColumns(),
            data,
            sort: true,
            search: true,
            pagination: {
                limit: TABLE_PAGE_SIZE,
                summary: true
            },
            fixedHeader: true,
            style: {
                table: { 'white-space': 'nowrap' },
                th: { 'text-align': 'left' },
            },
        });
        gridInstance.render(wrapperEl);

        // Handle action button clicks (view, detail, unpack)
        wrapperEl.addEventListener('click', (e) => {
            const actionBtn = e.target.closest('.btn-action');
            if (!actionBtn) return;
            e.stopPropagation();

            const tr = actionBtn.closest('tr');
            if (!tr) return;
            const item = findMetadataForRow(tr);
            if (!item) return;

            // View button
            if (actionBtn.classList.contains('btn-view') && onViewCallback) {
                onViewCallback(item);
                return;
            }

            // Detail toggle
            if (actionBtn.classList.contains('btn-detail')) {
                const existingDetail = tr.nextElementSibling;
                if (existingDetail && existingDetail.classList.contains('detail-row')) {
                    existingDetail.remove();
                    actionBtn.classList.remove('expanded');
                    return;
                }
                if (!item.deepMeta) return;
                const colCount = tr.children.length;
                const detailTr = document.createElement('tr');
                detailTr.className = 'detail-row';
                const detailTd = document.createElement('td');
                detailTd.setAttribute('colspan', colCount);
                detailTd.className = 'detail-cell';
                detailTd.innerHTML = buildDetailContent(item);
                detailTr.appendChild(detailTd);
                tr.after(detailTr);
                actionBtn.classList.add('expanded');
                return;
            }

            // Unpack button
            if (actionBtn.classList.contains('btn-unpack') && onUnpackCallback) {
                onUnpackCallback(item.name);
                return;
            }

            // Delete button
            if (actionBtn.classList.contains('btn-delete') && onDeleteCallback) {
                dialog.danger(`Delete "${item.name}"?`, {
                    title: 'Delete file',
                }).then(yes => {
                    if (yes) onDeleteCallback(item.id);
                });
                return;
            }
        });

        // Enable inline editing by making cells content-editable on double-click
        wrapperEl.addEventListener('dblclick', (e) => {
            const td = e.target.closest('td');
            if (!td || e.target.closest('.btn-action')) return;
            if (td.closest('.detail-row') || td.classList.contains('detail-cell')) return;
            // Resolve the field so we can populate the full (non-truncated) value
            const visibleColsForEdit = getVisibleColumns();
            const editColIndex = Array.from(td.parentElement.children).indexOf(td);
            const editCol = editColIndex >= 0 && editColIndex < visibleColsForEdit.length
                ? visibleColsForEdit[editColIndex] : null;
            const editItem = findMetadataForRow(td.closest('tr'));

            // Populate with full value from metadata (not the truncated display text)
            if (editItem && editCol) {
                const COL_TO_FIELD = {
                    refCode: 'referenceCode', name: 'name', path: 'path',
                    category: 'category', ext: 'extension', mime: 'type',
                    modified: 'lastModified', created: 'createdDate',
                    author: 'author', title: 'title', description: 'description',
                    level: 'levelOfDescription', language: 'language', extent: 'extent',
                    source: 'source', notes: 'notes', excerpt: 'excerpt',
                };
                const fieldName = COL_TO_FIELD[editCol.id];
                if (fieldName && editItem[fieldName] !== undefined) {
                    td.textContent = editItem[fieldName] || '';
                }
            }

            td.setAttribute('contenteditable', 'true');
            // Release truncation so full text is visible during editing
            td.style.whiteSpace = 'pre-wrap';
            td.style.overflow = 'visible';
            td.style.textOverflow = 'clip';
            td.style.maxWidth = 'none';
            td.focus();

            const finishEdit = () => {
                td.removeAttribute('contenteditable');
                // Restore truncation styles
                td.style.whiteSpace = '';
                td.style.overflow = '';
                td.style.textOverflow = '';
                td.style.maxWidth = '';
                td.removeEventListener('blur', finishEdit);
                td.removeEventListener('keydown', handleKey);

                if (onCellEditCallback) {
                    const tr = td.parentElement;
                    const tbody = tr.parentElement;
                    const rowIndex = Array.from(tbody.children).indexOf(tr);
                    const colIndex = Array.from(tr.children).indexOf(td);
                    // Resolve the field ID from the visible column list
                    const visibleCols = getVisibleColumns();
                    const col = colIndex >= 0 && colIndex < visibleCols.length ? visibleCols[colIndex] : null;
                    const fieldId = col ? col.id : null;
                    if (fieldId && !col.isActions && !col.isDelete) {
                        onCellEditCallback(rowIndex, fieldId, td.textContent.trim());
                    }
                }
            };

            const handleKey = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    td.blur();
                } else if (e.key === 'Escape') {
                    td.removeAttribute('contenteditable');
                    td.style.whiteSpace = '';
                    td.style.overflow = '';
                    td.style.textOverflow = '';
                    td.style.maxWidth = '';
                    td.removeEventListener('blur', finishEdit);
                    td.removeEventListener('keydown', handleKey);
                }
            };

            td.addEventListener('blur', finishEdit);
            td.addEventListener('keydown', handleKey);
        });
    }

    updateEmptyState(wrapperEl, metadataArray.length);
}

/**
 * Clear the grid.
 */
export function clearTable(wrapperEl) {
    currentData = [];
    if (gridInstance) {
        gridInstance.updateConfig({ data: [] }).forceRender();
    }
    updateEmptyState(wrapperEl, 0);
}

// Full row data for all columns (matches ALL_COLUMNS order)
function metadataToFullRows(metadataArray) {
    return metadataArray.map(item => {
        const ext = item.extension?.toLowerCase();
        const hasDeepMeta = item.deepMeta && Object.keys(item.deepMeta).length > 0;

        // Build comma-separated action flags
        const flags = [];
        if (item._file && VIEWABLE_EXTS.includes(ext)) flags.push('view');
        if (hasDeepMeta) flags.push('meta');
        if (item._file && ARCHIVE_EXTS.includes(ext)) {
            flags.push(item._unpacked ? 'unpacked' : 'unpack');
        }

        return {
            refCode: item.referenceCode || '',
            name: item.name,
            path: item.path !== item.name ? (item.path || '') : '',
            category: item.category || '',
            ext: item.extension ? item.extension.toUpperCase() : '',
            mime: item.type || '',
            size: formatBytes(item.size),
            modified: formatDate(item.lastModified),
            created: item.createdDate ? formatDate(item.createdDate) : '',
            author: item.author || '',
            title: item.title || '',
            description: item.description || '',
            level: item.levelOfDescription || '',
            language: item.language || '',
            extent: item.extent || '',
            source: item.source || '',
            notes: item.notes || '',
            excerpt: item.excerpt ? item.excerpt.substring(0, CELL_PREVIEW_LENGTH) + (item.excerpt.length > CELL_PREVIEW_LENGTH ? '…' : '') : '',
            actions: flags.join(','),
            delete: '',
        };
    });
}

function filterDataToVisibleColumns(metadataArray) {
    const visibleCols = getVisibleColumns();
    const fullRows = metadataToFullRows(metadataArray);
    return fullRows.map(row => visibleCols.map(col => row[col.id]));
}

/**
 * Find the metadata item corresponding to a grid <tr> by matching the file name.
 */
function findMetadataForRow(tr) {
    const cells = tr.querySelectorAll('td');
    const visibleCols = getVisibleColumns();
    const nameColIndex = visibleCols.findIndex(c => c.id === 'name');
    if (nameColIndex === -1 || nameColIndex >= cells.length) return null;
    const nameText = cells[nameColIndex]?.textContent?.trim();
    if (!nameText) return null;
    return currentData.find(item => item.name === nameText);
}

/**
 * Build HTML content for the expandable detail panel showing all deep metadata.
 */
function buildDetailContent(item) {
    const meta = item.deepMeta;
    if (!meta || Object.keys(meta).length === 0) return '<em>No deep metadata</em>';

    const rows = Object.entries(meta).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => {
        let displayValue = value;
        if (typeof value === 'object' && value !== null) {
            displayValue = JSON.stringify(value);
        }
        // Truncate very long values
        const strVal = String(displayValue);
        const truncated = strVal.length > CELL_PREVIEW_LENGTH ? strVal.substring(0, CELL_PREVIEW_LENGTH) + '...' : strVal;
        const escaped = truncated.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const keyEscaped = key.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<tr><td class="detail-key">${keyEscaped}</td><td class="detail-value">${escaped}</td></tr>`;
    }).join('');

    return `<div class="detail-panel">
        <table class="detail-table"><tbody>${rows}</tbody></table>
    </div>`;
}

function updateEmptyState(wrapperEl, count) {
    const emptyEl = document.getElementById('emptyState');
    if (emptyEl) {
        emptyEl.style.display = count === 0 ? 'block' : 'none';
    }
}
