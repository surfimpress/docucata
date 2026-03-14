const STORAGE_KEY = 'docucata_metadata';

/**
 * Save metadata array to localStorage.
 */
export function saveMetadata(metadataArray) {
    // Strip _file references — File objects can't be serialized
    const serializable = metadataArray.map(({ _file, ...rest }) => rest);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
}

/**
 * Load metadata array from localStorage.
 * @returns {Array}
 */
export function loadMetadata() {
    try {
        const data = localStorage.getItem(STORAGE_KEY);
        return data ? JSON.parse(data) : [];
    } catch {
        return [];
    }
}

/**
 * Remove all metadata from localStorage.
 */
export function clearMetadata() {
    localStorage.removeItem(STORAGE_KEY);
}

/**
 * Merge incoming metadata into an existing array, deduplicating by ID.
 * Incoming items with matching IDs replace existing ones, but user-edited
 * fields (like notes) are preserved from the existing item if not set on incoming.
 * @returns {Array} Merged array
 */
export function mergeMetadata(existing, incoming) {
    const map = new Map();
    for (const item of existing) {
        map.set(item.id, item);
    }
    for (const item of incoming) {
        const prev = map.get(item.id);
        if (prev) {
            // Preserve user-edited fields from existing record
            if (prev.notes && !item.notes) item.notes = prev.notes;
            if (prev.description && !item.description) item.description = prev.description;
            if (prev.referenceCode && !item.referenceCode) item.referenceCode = prev.referenceCode;
            if (prev.levelOfDescription && prev.levelOfDescription !== 'File') {
                item.levelOfDescription = prev.levelOfDescription;
            }
        }
        map.set(item.id, item);
    }
    return Array.from(map.values());
}
