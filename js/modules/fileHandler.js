/**
 * Initialize a drop zone element for drag-and-drop file handling.
 * Supports recursive folder traversal via webkitGetAsEntry.
 */
export function initDropZone(dropZoneEl, onFilesReceived) {
    dropZoneEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZoneEl.classList.add('dragover');
    });

    dropZoneEl.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dropZoneEl.classList.remove('dragover');
    });

    dropZoneEl.addEventListener('drop', async (e) => {
        e.preventDefault();
        dropZoneEl.classList.remove('dragover');

        const items = e.dataTransfer.items;
        if (!items || items.length === 0) return;

        const files = await collectFiles(items);
        if (files.length > 0) {
            onFilesReceived(files);
        }
    });
}

/**
 * Initialize a file picker input element.
 */
export function initFilePicker(inputEl, onFilesReceived) {
    inputEl.addEventListener('change', () => {
        if (inputEl.files.length > 0) {
            const files = Array.from(inputEl.files).map(f => ({
                file: f,
                path: f.webkitRelativePath || f.name
            }));
            onFilesReceived(files);
            inputEl.value = '';
        }
    });
}

/**
 * Recursively collect all files from dropped items (handles folders).
 * Returns an array of { file: File, path: string } objects.
 */
async function collectFiles(dataTransferItems) {
    const fileEntries = [];

    const entries = [];
    for (const item of dataTransferItems) {
        const entry = item.webkitGetAsEntry?.();
        if (entry) {
            entries.push(entry);
        }
    }

    await traverseEntries(entries, '', fileEntries);
    return fileEntries;
}

async function traverseEntries(entries, basePath, results) {
    const promises = entries.map(entry => {
        if (entry.isFile) {
            return new Promise((resolve) => {
                entry.file((file) => {
                    const path = basePath ? `${basePath}/${file.name}` : file.name;
                    console.log(`[Docucata:FileHandler] Entry: ${entry.fullPath} | isFile: ${entry.isFile} | filesystem: ${entry.filesystem?.name || '(none)'}`);
                    results.push({ file, path });
                    resolve();
                }, () => resolve());
            });
        } else if (entry.isDirectory) {
            console.log(`[Docucata:FileHandler] Directory: ${entry.fullPath} | name: ${entry.name} | filesystem: ${entry.filesystem?.name || '(none)'}`);
            return readDirectory(entry).then(children => {
                console.log(`[Docucata:FileHandler] Directory "${entry.name}" contains ${children.length} entries`);
                const dirPath = basePath ? `${basePath}/${entry.name}` : entry.name;
                return traverseEntries(children, dirPath, results);
            });
        }
        return Promise.resolve();
    });
    await Promise.all(promises);
}

function readDirectory(dirEntry) {
    return new Promise((resolve) => {
        const reader = dirEntry.createReader();
        const allEntries = [];

        function readBatch() {
            reader.readEntries((entries) => {
                if (entries.length === 0) {
                    resolve(allEntries);
                } else {
                    allEntries.push(...entries);
                    readBatch();
                }
            }, () => resolve(allEntries));
        }

        readBatch();
    });
}
