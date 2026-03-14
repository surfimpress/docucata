/**
 * Mapping Editor — modal for editing export field mappings.
 * Uses Grid.js for the field table, matching the app's table UI.
 */

import { getMapping, updateMapping, DEEP_META_CATALOG } from './mappingManager.js';

let modalEl = null;
let editorGrid = null;
let currentMapping = null;
let onSaveCallback = null;
let onApplyCallback = null;

function getModal() {
    if (!modalEl) {
        modalEl = document.getElementById('mappingModal');
    }
    return modalEl;
}

/**
 * Open the mapping editor for a given mapping ID.
 * @param {string} mappingId
 * @param {Function} onSave — called after user saves changes
 */
export function openMappingEditor(mappingId, onSave) {
    currentMapping = getMapping(mappingId);
    if (!currentMapping) return;

    onSaveCallback = onSave || null;

    const modal = getModal();
    const titleEl = modal.querySelector('.mapping-editor-title');
    const bodyEl = modal.querySelector('.mapping-editor-body');

    titleEl.textContent = `Edit Mapping: ${currentMapping.name}`;
    bodyEl.innerHTML = '';

    // Build the editable table
    renderEditorGrid(bodyEl);

    modal.classList.add('open');
}

/**
 * Close the mapping editor.
 */
export function closeMappingEditor() {
    const modal = getModal();
    modal.classList.remove('open');

    // Clean up Grid.js instance
    if (editorGrid) {
        const bodyEl = modal.querySelector('.mapping-editor-body');
        bodyEl.innerHTML = '';
        editorGrid = null;
    }
    currentMapping = null;
}

/**
 * Initialize modal close handlers.
 */
export function initMappingEditor() {
    const modal = getModal();
    if (!modal) return;

    modal.querySelector('.mapping-editor-close').addEventListener('click', closeMappingEditor);
    modal.querySelector('.mapping-editor-backdrop').addEventListener('click', closeMappingEditor);
    modal.querySelector('.mapping-editor-cancel').addEventListener('click', closeMappingEditor);

    modal.querySelector('.mapping-editor-save').addEventListener('click', () => {
        saveCurrentMapping();
        closeMappingEditor();
    });

    modal.querySelector('.mapping-editor-apply').addEventListener('click', () => {
        if (!currentMapping) return;
        // Save first so the mapping is persisted, then trigger the apply callback
        saveCurrentMapping();
        if (onApplyCallback) onApplyCallback(currentMapping);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('open')) {
            closeMappingEditor();
        }
    });
}

/**
 * Register a callback for the "Apply to batch" action.
 * @param {Function} fn — called with (mapping) after the user confirms
 */
export function onApplyToBatch(fn) {
    onApplyCallback = fn;
}

/**
 * Render the editor table with include, default label, mode dropdown, and export label.
 */
function renderEditorGrid(container) {
    const fields = currentMapping.fields;

    const wrapper = document.createElement('div');
    wrapper.className = 'mapping-editor-grid';

    const table = document.createElement('table');
    table.className = 'mapping-field-table';

    // Header
    const thead = document.createElement('thead');
    thead.innerHTML = `<tr>
        <th class="mf-col-include">Include</th>
        <th class="mf-col-default">Default Label</th>
        <th class="mf-col-mode">Action</th>
        <th class="mf-col-custom">Export Label</th>
        <th class="mf-col-prepend">Prepend</th>
        <th class="mf-col-append">Append</th>
        <th class="mf-col-mapfrom">Map From</th>
    </tr>`;
    table.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');

    fields.forEach((field) => {
        const tr = document.createElement('tr');

        // Derive initial mode if not set (backwards compat with pre-mode mappings)
        if (!field.mode) {
            field.mode = (field.customLabel === field.defaultLabel) ? 'no change' : 'name change';
        }

        // Update row styling
        function updateRowState() {
            tr.className = '';
            if (field.key === 'deepMeta') tr.classList.add('mf-locked');
            if (field.custom) tr.classList.add('mf-custom-row');
            if (!field.included) tr.classList.add('mf-excluded');
            if (field.mode === 'map metadata') tr.classList.add('mf-metamap');
            if (field.mode === 'fixed value') tr.classList.add('mf-fixedval');
        }
        updateRowState();

        // ── Include checkbox ──
        const tdCheck = document.createElement('td');
        tdCheck.className = 'mf-col-include';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = field.included;
        cb.className = 'mf-checkbox';
        cb.addEventListener('change', () => {
            field.included = cb.checked;
            updateRowState();
        });
        tdCheck.appendChild(cb);
        tr.appendChild(tdCheck);

        // ── Default label (read-only) ──
        const tdDefault = document.createElement('td');
        tdDefault.className = 'mf-col-default';
        tdDefault.textContent = field.defaultLabel;
        tr.appendChild(tdDefault);

        // ── Mode dropdown ──
        const tdMode = document.createElement('td');
        tdMode.className = 'mf-col-mode';
        const select = document.createElement('select');
        select.className = 'mf-select';

        // deepMeta field is locked — include/exclude only, no mode changes
        const isLocked = (field.key === 'deepMeta');

        const modes = ['no change', 'name change', 'map metadata', 'fixed value'];
        for (const m of modes) {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            if (m === field.mode) opt.selected = true;
            select.appendChild(opt);
        }

        if (isLocked) {
            select.disabled = true;
            field.mode = 'no change';
            select.value = 'no change';
        }

        select.addEventListener('change', () => {
            field.mode = select.value;
            updateRowState();

            if (field.mode === 'no change') {
                // Reset custom label to match default
                input.value = field.defaultLabel;
                field.customLabel = field.defaultLabel;
                input.disabled = true;
            } else if (field.mode === 'name change') {
                input.disabled = false;
                input.focus();
            } else if (field.mode === 'map metadata') {
                input.disabled = false;
            } else if (field.mode === 'fixed value') {
                input.disabled = false;
            }
        });

        tdMode.appendChild(select);
        tr.appendChild(tdMode);

        // ── Export label (editable) ──
        const tdCustom = document.createElement('td');
        tdCustom.className = 'mf-col-custom';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'mf-input';
        input.value = field.customLabel;
        input.disabled = (field.mode === 'no change') || isLocked;

        input.addEventListener('input', () => {
            field.customLabel = input.value;
            // Auto-update mode when user types
            if (field.mode !== 'map metadata' && field.mode !== 'fixed value') {
                const newMode = (input.value === field.defaultLabel) ? 'no change' : 'name change';
                if (newMode !== field.mode) {
                    field.mode = newMode;
                    select.value = newMode;
                    updateRowState();
                }
            }
        });

        // Reset to default on double-click
        input.addEventListener('dblclick', () => {
            if (field.mode === 'no change') return;
            input.value = field.defaultLabel;
            field.customLabel = field.defaultLabel;
            if (field.mode !== 'map metadata' && field.mode !== 'fixed value') {
                field.mode = 'no change';
                select.value = 'no change';
                input.disabled = true;
                updateRowState();
            }
        });

        tdCustom.appendChild(input);
        tr.appendChild(tdCustom);

        // ── Backwards compat for prepend/append ──
        if (field.prepend === undefined) field.prepend = false;
        if (field.prependValue === undefined) field.prependValue = '';
        if (field.append === undefined) field.append = false;
        if (field.appendValue === undefined) field.appendValue = '';

        // ── Prepend cell ──
        const tdPrepend = document.createElement('td');
        tdPrepend.className = 'mf-col-prepend';

        const prependCb = document.createElement('input');
        prependCb.type = 'checkbox';
        prependCb.checked = field.prepend;
        prependCb.className = 'mf-checkbox';
        if (isLocked) prependCb.disabled = true;
        tdPrepend.appendChild(prependCb);

        const prependInput = document.createElement('input');
        prependInput.type = 'text';
        prependInput.className = 'mf-input mf-prepend-input';
        prependInput.placeholder = 'prefix…';
        prependInput.value = field.prependValue;
        prependInput.style.display = field.prepend ? 'block' : 'none';
        if (isLocked) prependInput.disabled = true;
        prependInput.addEventListener('input', () => {
            field.prependValue = prependInput.value;
        });
        tdPrepend.appendChild(prependInput);

        prependCb.addEventListener('change', () => {
            field.prepend = prependCb.checked;
            prependInput.style.display = prependCb.checked ? 'block' : 'none';
            if (prependCb.checked) prependInput.focus();
        });

        tr.appendChild(tdPrepend);

        // ── Append cell ──
        const tdAppend = document.createElement('td');
        tdAppend.className = 'mf-col-append';

        const appendCb = document.createElement('input');
        appendCb.type = 'checkbox';
        appendCb.checked = field.append;
        appendCb.className = 'mf-checkbox';
        if (isLocked) appendCb.disabled = true;
        tdAppend.appendChild(appendCb);

        const appendInput = document.createElement('input');
        appendInput.type = 'text';
        appendInput.className = 'mf-input mf-append-input';
        appendInput.placeholder = 'suffix…';
        appendInput.value = field.appendValue;
        appendInput.style.display = field.append ? 'block' : 'none';
        if (isLocked) appendInput.disabled = true;
        appendInput.addEventListener('input', () => {
            field.appendValue = appendInput.value;
        });
        tdAppend.appendChild(appendInput);

        appendCb.addEventListener('change', () => {
            field.append = appendCb.checked;
            appendInput.style.display = appendCb.checked ? 'block' : 'none';
            if (appendCb.checked) appendInput.focus();
        });

        tr.appendChild(tdAppend);

        // ── Map from (deep metadata key picker) ──
        const tdMapFrom = document.createElement('td');
        tdMapFrom.className = 'mf-col-mapfrom';

        const mapFromContainer = document.createElement('div');
        mapFromContainer.className = 'mf-mapfrom-container';

        // Ensure fallbacks array exists (backwards compat)
        if (!field.metadataFallbacks) field.metadataFallbacks = [];

        // Build a grouped options template for reuse across dropdowns
        const groupedOptions = buildGroupedOptions();

        // ── All rows live in a single sortable list ──
        const rowList = document.createElement('div');
        rowList.className = 'mf-mapfrom-list';

        // ── "+" button to add more fallbacks (sits outside the list) ──
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'mf-mapfrom-add';
        addBtn.textContent = '+';
        addBtn.title = 'Add fallback field';

        // Build all rows: primary first, then fallbacks
        const allKeys = [field.metadataKey, ...field.metadataFallbacks];
        allKeys.forEach((key, i) => {
            appendMapFromRow(key, i > 0);
        });

        addBtn.addEventListener('click', () => {
            field.metadataFallbacks.push(null);
            appendMapFromRow(null, true);
        });

        mapFromContainer.appendChild(rowList);
        mapFromContainer.appendChild(addBtn);
        tdMapFrom.appendChild(mapFromContainer);

        // ── Fixed value input (shown when mode = 'fixed value') ──
        const fixedWrap = document.createElement('div');
        fixedWrap.className = 'mf-fixed-wrap';

        const fixedLabel = document.createElement('span');
        fixedLabel.className = 'mf-mapfrom-label';
        fixedLabel.textContent = 'value';

        const fixedInput = document.createElement('input');
        fixedInput.type = 'text';
        fixedInput.className = 'mf-input mf-fixed-input';
        fixedInput.placeholder = 'Enter fixed value…';
        fixedInput.value = field.fixedValue || '';
        fixedInput.addEventListener('input', () => {
            field.fixedValue = fixedInput.value;
        });

        fixedWrap.appendChild(fixedLabel);
        fixedWrap.appendChild(fixedInput);
        tdMapFrom.appendChild(fixedWrap);

        // ── Delete button for custom fields ──
        if (field.custom) {
            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'mf-custom-delete';
            deleteBtn.textContent = '✕';
            deleteBtn.title = 'Remove custom field';
            deleteBtn.addEventListener('click', () => {
                const idx = currentMapping.fields.indexOf(field);
                if (idx !== -1) currentMapping.fields.splice(idx, 1);
                tr.remove();
            });
            tdDefault.appendChild(deleteBtn);
        }

        // Show/hide map-from vs fixed-value based on mode
        function updateMapFromVisibility() {
            mapFromContainer.style.display = (field.mode === 'map metadata') ? 'block' : 'none';
            fixedWrap.style.display = (field.mode === 'fixed value') ? 'flex' : 'none';
        }
        updateMapFromVisibility();

        /**
         * Sync field.metadataKey and field.metadataFallbacks from current DOM order.
         * Called after drag-reorder or removal.
         */
        function syncFieldFromDom() {
            const rows = rowList.querySelectorAll('.mf-mapfrom-wrap');
            const keys = Array.from(rows).map(r => r.querySelector('.mf-meta-select').value || null);
            field.metadataKey = keys[0] || null;
            field.metadataFallbacks = keys.slice(1);
            // Update labels: first row = "map from", rest = "or"
            rows.forEach((r, i) => {
                r.querySelector('.mf-mapfrom-label').textContent = i === 0 ? 'map from' : 'or';
                // Show/hide remove button: first row has none, rest have one
                const removeBtn = r.querySelector('.mf-mapfrom-remove');
                if (i === 0 && removeBtn) removeBtn.style.display = 'none';
                if (i > 0 && removeBtn) removeBtn.style.display = '';
            });
        }

        /**
         * Append a map-from row to the list.
         */
        function appendMapFromRow(selectedKey, isFallback) {
            const wrap = document.createElement('div');
            wrap.className = 'mf-mapfrom-wrap';
            wrap.draggable = true;

            // Drag handle
            const handle = document.createElement('span');
            handle.className = 'mf-drag-handle';
            handle.textContent = '⠿';
            handle.title = 'Drag to reorder';

            const label = document.createElement('span');
            label.className = 'mf-mapfrom-label';
            label.textContent = isFallback ? 'or' : 'map from';

            const sel = document.createElement('select');
            sel.className = 'mf-select mf-meta-select';

            // Empty option
            const emptyOpt = document.createElement('option');
            emptyOpt.value = '';
            emptyOpt.textContent = '— select field —';
            sel.appendChild(emptyOpt);

            // Populate grouped options
            for (const [source, entries] of groupedOptions) {
                const optgroup = document.createElement('optgroup');
                optgroup.label = source;
                for (const entry of entries) {
                    const opt = document.createElement('option');
                    opt.value = entry.key;
                    opt.textContent = entry.key;
                    if (selectedKey === entry.key) opt.selected = true;
                    optgroup.appendChild(opt);
                }
                sel.appendChild(optgroup);
            }

            sel.addEventListener('change', () => syncFieldFromDom());

            // Remove button (hidden on first/primary row)
            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'mf-mapfrom-remove';
            removeBtn.textContent = '−';
            removeBtn.title = 'Remove fallback';
            if (!isFallback) removeBtn.style.display = 'none';
            removeBtn.addEventListener('click', () => {
                wrap.remove();
                syncFieldFromDom();
            });

            wrap.appendChild(handle);
            wrap.appendChild(label);
            wrap.appendChild(sel);
            wrap.appendChild(removeBtn);

            // ── Drag-and-drop reordering ──
            wrap.addEventListener('dragstart', (e) => {
                wrap.classList.add('mf-dragging');
                e.dataTransfer.effectAllowed = 'move';
            });
            wrap.addEventListener('dragend', () => {
                wrap.classList.remove('mf-dragging');
                syncFieldFromDom();
            });
            wrap.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const dragging = rowList.querySelector('.mf-dragging');
                if (!dragging || dragging === wrap) return;
                // Determine whether to insert before or after this row
                const rect = wrap.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                if (e.clientY < midY) {
                    rowList.insertBefore(dragging, wrap);
                } else {
                    rowList.insertBefore(dragging, wrap.nextSibling);
                }
            });

            rowList.appendChild(wrap);
        }

        /**
         * Build grouped options from DEEP_META_CATALOG (computed once per field row).
         */
        function buildGroupedOptions() {
            const groups = new Map();
            for (const entry of DEEP_META_CATALOG) {
                if (!groups.has(entry.source)) groups.set(entry.source, []);
                groups.get(entry.source).push(entry);
            }
            return groups;
        }

        tr.appendChild(tdMapFrom);

        // Also toggle map-from visibility when mode changes
        select.addEventListener('change', updateMapFromVisibility);

        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrapper.appendChild(table);

    // ── "Add custom field" button below the table ──
    const addFieldBtn = document.createElement('button');
    addFieldBtn.type = 'button';
    addFieldBtn.className = 'btn btn-ghost mf-add-field-btn';
    addFieldBtn.textContent = '+ Add custom field';
    addFieldBtn.addEventListener('click', () => {
        const customNum = getNextCustomNumber();
        const newField = {
            key: `custom_${customNum}`,
            defaultLabel: `custom_${customNum}`,
            customLabel: `custom_${customNum}`,
            included: true,
            mode: 'no change',
            metadataKey: null,
            metadataFallbacks: [],
            fixedValue: null,
            custom: true,
        };
        currentMapping.fields.push(newField);
        // Re-render the entire editor to pick up the new row
        container.innerHTML = '';
        renderEditorGrid(container);
    });
    wrapper.appendChild(addFieldBtn);

    // Hint text
    const hint = document.createElement('p');
    hint.className = 'mapping-editor-hint';
    hint.textContent = 'Double-click an export label to reset it. Use "map metadata" to pull a deep metadata field into an export column. Press + to add fallback fields — if the first is empty, the next is tried. "Fixed value" fills all rows with constant text. Check Prepend or Append to add fixed text before or after exported values (only applied when the value is non-empty).';
    wrapper.appendChild(hint);

    container.appendChild(wrapper);

    /**
     * Find the next custom_NN number by scanning existing fields.
     */
    function getNextCustomNumber() {
        let max = 0;
        for (const f of currentMapping.fields) {
            const m = f.key.match(/^custom_(\d+)$/);
            if (m) max = Math.max(max, parseInt(m[1], 10));
        }
        return String(max + 1).padStart(2, '0');
    }
}

/**
 * Save the current mapping state back to storage.
 */
function saveCurrentMapping() {
    if (!currentMapping) return;
    updateMapping(currentMapping);
    if (onSaveCallback) onSaveCallback(currentMapping);
}
