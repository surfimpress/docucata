/**
 * Mapping Manager — manages named export field mappings.
 *
 * Each mapping defines custom labels for export columns and which fields to include.
 * Stored in localStorage (mappings are tiny JSON objects).
 *
 * Mapping record shape:
 * {
 *   id: string,           // 'map_' + timestamp
 *   name: string,         // User-chosen name
 *   createdAt: string,    // ISO 8601
 *   fields: [             // Ordered list of field configs
 *     { key: string, defaultLabel: string, customLabel: string, included: boolean,
 *       mode: string, metadataKey: string|null, metadataFallbacks: string[],
 *       fixedValue: string|null, custom: boolean|undefined }
 *   ]
 * }
 */

const MAPPINGS_KEY = 'docucata_mappings';
const ACTIVE_MAPPING_KEY = 'docucata_active_mapping';

/**
 * The canonical list of exportable fields.
 * Order here = default export column order.
 */
export const DEFAULT_FIELDS = [
    { key: 'referenceCode', defaultLabel: 'Reference Code' },
    { key: 'name',        defaultLabel: 'Name' },
    { key: 'path',        defaultLabel: 'Path' },
    { key: 'category',    defaultLabel: 'Category' },
    { key: 'extension',   defaultLabel: 'Extension' },
    { key: 'type',        defaultLabel: 'MIME Type' },
    { key: 'sizeRaw',     defaultLabel: 'Size (bytes)' },
    { key: 'sizeFormatted', defaultLabel: 'Size' },
    { key: 'lastModified', defaultLabel: 'Last Modified' },
    { key: 'createdDate', defaultLabel: 'Created' },
    { key: 'author',      defaultLabel: 'Author' },
    { key: 'title',       defaultLabel: 'Title' },
    { key: 'description', defaultLabel: 'Description' },
    { key: 'levelOfDescription', defaultLabel: 'Level' },
    { key: 'language',    defaultLabel: 'Language' },
    { key: 'extent',      defaultLabel: 'Extent' },
    { key: 'source',      defaultLabel: 'Source' },
    { key: 'url',         defaultLabel: 'URL' },
    { key: 'notes',       defaultLabel: 'Notes' },
    { key: 'excerpt',     defaultLabel: 'Excerpt' },
    { key: 'deepMeta',    defaultLabel: 'Deep Metadata' },
];

/**
 * Catalog of all deep metadata keys grouped by source format.
 * Each entry: { key, label, source }
 * where source is the file type abbreviation shown in the dropdown.
 */
export const DEEP_META_CATALOG = [
    // PDF
    { key: 'Title',            source: 'PDF' },
    { key: 'Author',           source: 'PDF' },
    { key: 'Subject',          source: 'PDF' },
    { key: 'Keywords',         source: 'PDF' },
    { key: 'Creator',          source: 'PDF' },
    { key: 'Producer',         source: 'PDF' },
    { key: 'CreationDate',     source: 'PDF' },
    { key: 'ModDate',          source: 'PDF' },
    { key: 'Trapped',          source: 'PDF' },
    { key: 'pdfVersion',       source: 'PDF' },
    { key: 'pageCount',        source: 'PDF' },
    { key: 'encrypted',        source: 'PDF' },
    { key: 'linearized',       source: 'PDF' },
    { key: 'pdfaPart',         source: 'PDF' },
    { key: 'pdfaConformance',  source: 'PDF' },
    { key: 'language',         source: 'PDF' },
    { key: 'Description',      source: 'PDF' },
    { key: 'rights',           source: 'PDF' },
    { key: 'copyright',        source: 'PDF' },
    { key: 'documentId',       source: 'PDF' },
    { key: 'instanceId',       source: 'PDF' },
    { key: 'colorMode',        source: 'PDF' },

    // Office (OOXML / ODF)
    { key: 'title',            source: 'Office' },
    { key: 'subject',          source: 'Office' },
    { key: 'creator',          source: 'Office' },
    { key: 'description',      source: 'Office' },
    { key: 'lastModifiedBy',   source: 'Office' },
    { key: 'revision',         source: 'Office' },
    { key: 'created',          source: 'Office' },
    { key: 'modified',         source: 'Office' },
    { key: 'keywords',         source: 'Office' },
    { key: 'category',         source: 'Office' },
    { key: 'language',         source: 'Office' },
    { key: 'application',      source: 'Office' },
    { key: 'appVersion',       source: 'Office' },
    { key: 'template',         source: 'Office' },
    { key: 'totalEditingMinutes', source: 'Office' },
    { key: 'pages',            source: 'Office' },
    { key: 'words',            source: 'Office' },
    { key: 'characters',       source: 'Office' },
    { key: 'paragraphs',       source: 'Office' },
    { key: 'lines',            source: 'Office' },
    { key: 'slides',           source: 'Office' },
    { key: 'company',          source: 'Office' },
    { key: 'manager',          source: 'Office' },
    { key: 'docSecurity',      source: 'Office' },

    // OLE2 (legacy DOC/XLS/PPT)
    { key: 'author',           source: 'DOC' },
    { key: 'lastAuthor',       source: 'DOC' },
    { key: 'comments',         source: 'DOC' },
    { key: 'editTime',         source: 'DOC' },
    { key: 'lastPrinted',      source: 'DOC' },
    { key: 'revisionNumber',   source: 'DOC' },
    { key: 'wordCount',        source: 'DOC' },
    { key: 'charCount',        source: 'DOC' },
    { key: 'security',         source: 'DOC' },
    { key: 'byteCount',        source: 'DOC' },
    { key: 'lineCount',        source: 'DOC' },
    { key: 'paragraphCount',   source: 'DOC' },
    { key: 'slideCount',       source: 'DOC' },
    { key: 'contentType',      source: 'DOC' },

    // Spreadsheet
    { key: 'sheetCount',       source: 'Sheet' },
    { key: 'sheetNames',       source: 'Sheet' },
    { key: 'totalPopulatedCells', source: 'Sheet' },
    { key: 'totalFormulas',    source: 'Sheet' },
    { key: 'totalMergedRegions', source: 'Sheet' },
    { key: 'namedRangeCount',  source: 'Sheet' },
    { key: 'hiddenSheets',     source: 'Sheet' },
    { key: 'dataTypes',        source: 'Sheet' },

    // Image / EXIF
    { key: 'Width',            source: 'Image' },
    { key: 'Height',           source: 'Image' },
    { key: 'BitDepth',         source: 'Image' },
    { key: 'ColorType',        source: 'Image' },
    { key: 'ColorSpace',       source: 'Image' },
    { key: 'DpiX',             source: 'Image' },
    { key: 'DpiY',             source: 'Image' },
    { key: 'AlphaChannel',     source: 'Image' },
    { key: 'Animated',         source: 'Image' },
    { key: 'Make',             source: 'EXIF' },
    { key: 'Model',            source: 'EXIF' },
    { key: 'DateTime',         source: 'EXIF' },
    { key: 'DateTimeOriginal', source: 'EXIF' },
    { key: 'Artist',           source: 'EXIF' },
    { key: 'Copyright',        source: 'EXIF' },
    { key: 'Software',         source: 'EXIF' },
    { key: 'Orientation',      source: 'EXIF' },
    { key: 'ExposureTime',     source: 'EXIF' },
    { key: 'FNumber',          source: 'EXIF' },
    { key: 'ISO',              source: 'EXIF' },
    { key: 'FocalLength',      source: 'EXIF' },
    { key: 'FocalLengthIn35mmFilm', source: 'EXIF' },
    { key: 'Flash',            source: 'EXIF' },
    { key: 'MeteringMode',     source: 'EXIF' },
    { key: 'WhiteBalance',     source: 'EXIF' },
    { key: 'ExposureMode',     source: 'EXIF' },
    { key: 'LensMake',         source: 'EXIF' },
    { key: 'LensModel',        source: 'EXIF' },
    { key: 'BodySerialNumber', source: 'EXIF' },
    { key: 'GPSLatitude',      source: 'GPS' },
    { key: 'GPSLongitude',     source: 'GPS' },
    { key: 'GPSAltitude',      source: 'GPS' },
    { key: 'GPSDateStamp',     source: 'GPS' },

    // Audio
    { key: 'title',            source: 'Audio' },
    { key: 'artist',           source: 'Audio' },
    { key: 'album',            source: 'Audio' },
    { key: 'track',            source: 'Audio' },
    { key: 'year',             source: 'Audio' },
    { key: 'genre',            source: 'Audio' },
    { key: 'composer',         source: 'Audio' },
    { key: 'albumArtist',      source: 'Audio' },
    { key: 'bpm',              source: 'Audio' },
    { key: 'isrc',             source: 'Audio' },
    { key: 'duration',         source: 'Audio' },
    { key: 'bitrate',          source: 'Audio' },
    { key: 'sampleRate',       source: 'Audio' },
    { key: 'channels',         source: 'Audio' },
    { key: 'format',           source: 'Audio' },
    { key: 'hasAlbumArt',      source: 'Audio' },

    // RTF
    { key: 'charCountWithSpaces', source: 'RTF' },
    { key: 'totalEditingTime', source: 'RTF' },
    { key: 'rtfVersion',       source: 'RTF' },

    // Text
    { key: 'encoding',         source: 'Text' },
    { key: 'lineEndings',      source: 'Text' },
    { key: 'lineCount',        source: 'Text' },
    { key: 'wordCount',        source: 'Text' },
    { key: 'charCount',        source: 'Text' },
    { key: 'longestLine',      source: 'Text' },
    { key: 'containsNullBytes', source: 'Text' },
];

// ── CRUD ─────────────────────────────────────────────────

export function listMappings() {
    try {
        const raw = localStorage.getItem(MAPPINGS_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function saveMappingList(mappings) {
    localStorage.setItem(MAPPINGS_KEY, JSON.stringify(mappings));
}

export function createMapping(name) {
    const mappings = listMappings();
    const id = 'map_' + Date.now();
    const mapping = {
        id,
        name: name || 'Untitled mapping',
        createdAt: new Date().toISOString(),
        fields: DEFAULT_FIELDS.map(f => ({
            key: f.key,
            defaultLabel: f.defaultLabel,
            customLabel: f.defaultLabel,
            included: true,
            mode: 'no change',       // 'no change' | 'name change' | 'map metadata'
            metadataKey: null,        // primary deep metadata key (used when mode = 'map metadata')
            metadataFallbacks: [],    // fallback keys tried in order if primary is empty
            prepend: false,           // boolean — is prepend active?
            prependValue: '',         // string — text to prepend to exported value
            append: false,            // boolean — is append active?
            appendValue: '',          // string — text to append to exported value
        })),
    };
    mappings.push(mapping);
    saveMappingList(mappings);
    return mapping;
}

export function getMapping(id) {
    return listMappings().find(m => m.id === id) || null;
}

export function updateMapping(mapping) {
    const mappings = listMappings();
    const idx = mappings.findIndex(m => m.id === mapping.id);
    if (idx !== -1) {
        mappings[idx] = mapping;
        saveMappingList(mappings);
    }
}

export function renameMapping(id, newName) {
    const mappings = listMappings();
    const m = mappings.find(m => m.id === id);
    if (m) {
        m.name = newName;
        saveMappingList(mappings);
    }
}

export function deleteMapping(id) {
    const mappings = listMappings().filter(m => m.id !== id);
    saveMappingList(mappings);
    if (getActiveMappingId() === id) {
        setActiveMappingId(null);
    }
}

export function duplicateMapping(id) {
    const source = getMapping(id);
    if (!source) return null;
    const mappings = listMappings();
    const newId = 'map_' + Date.now();
    const copy = {
        ...source,
        id: newId,
        name: source.name + ' (copy)',
        createdAt: new Date().toISOString(),
        fields: source.fields.map(f => ({ ...f, metadataFallbacks: [...(f.metadataFallbacks || [])] })),
    };
    mappings.push(copy);
    saveMappingList(mappings);
    return copy;
}

// ── Active mapping ───────────────────────────────────────

export function getActiveMappingId() {
    return localStorage.getItem(ACTIVE_MAPPING_KEY) || null;
}

export function setActiveMappingId(id) {
    if (id) {
        localStorage.setItem(ACTIVE_MAPPING_KEY, id);
    } else {
        localStorage.removeItem(ACTIVE_MAPPING_KEY);
    }
}

export function getActiveMapping() {
    const id = getActiveMappingId();
    return id ? getMapping(id) : null;
}

/**
 * Resolve the export headers and row-builder for the active mapping.
 * If no mapping is active, returns the default (all fields, default labels).
 * @returns {{ headers: string[], rowBuilder: (item: Object) => any[] }}
 */
export function resolveExportMapping() {
    const mapping = getActiveMapping();
    const fields = mapping
        ? mapping.fields.filter(f => f.included)
        : DEFAULT_FIELDS.map(f => ({ ...f, customLabel: f.defaultLabel, included: true }));

    const headers = fields.map(f => f.customLabel);

    const rowBuilder = (item, formatBytes) => {
        return fields.map(f => {
            let val;

            // "fixed value" mode — return the user-defined fixed text
            if (f.mode === 'fixed value') {
                val = f.fixedValue || '';
            }
            // "map metadata" mode — pull value from deepMeta with fallback chain
            else if (f.mode === 'map metadata' && f.metadataKey) {
                val = '';
                if (item.deepMeta) {
                    const keys = [f.metadataKey, ...(f.metadataFallbacks || [])];
                    for (const key of keys) {
                        if (!key) continue;
                        const v = item.deepMeta[key];
                        if (v !== undefined && v !== null && v !== '') {
                            val = (typeof v === 'object') ? JSON.stringify(v) : String(v);
                            break;
                        }
                    }
                }
            }
            // Custom fields with no special mode return empty
            else if (f.custom) {
                val = '';
            }
            else {
                switch (f.key) {
                    case 'referenceCode': val = item.referenceCode || ''; break;
                    case 'name':          val = item.name; break;
                    case 'path':          val = item.path || ''; break;
                    case 'category':      val = item.category || ''; break;
                    case 'extension':     val = item.extension; break;
                    case 'type':          val = item.type; break;
                    case 'sizeRaw':       val = item.size; break;
                    case 'sizeFormatted': val = formatBytes(item.size); break;
                    case 'lastModified':  val = item.lastModified; break;
                    case 'createdDate':   val = item.createdDate || ''; break;
                    case 'author':        val = item.author || ''; break;
                    case 'title':         val = item.title || ''; break;
                    case 'description':   val = item.description || ''; break;
                    case 'levelOfDescription': val = item.levelOfDescription || ''; break;
                    case 'language':      val = item.language || ''; break;
                    case 'extent':        val = item.extent || ''; break;
                    case 'source':        val = item.source; break;
                    case 'url':           val = item.url || ''; break;
                    case 'notes':         val = item.notes || ''; break;
                    case 'excerpt':       val = item.excerpt || ''; break;
                    case 'deepMeta':      val = item.deepMeta ? JSON.stringify(item.deepMeta) : ''; break;
                    default:              val = ''; break;
                }
            }

            // Apply prepend/append — only when value is non-empty
            val = String(val);
            if (val !== '' && f.prepend && f.prependValue) val = f.prependValue + val;
            if (val !== '' && f.append && f.appendValue) val = val + f.appendValue;

            return val;
        });
    };

    return { headers, rowBuilder };
}

/**
 * Map from field key to the property name on a metadata record.
 * Returns null for keys that should not be written back (derived/complex).
 */
const FIELD_TO_PROP = {
    referenceCode: 'referenceCode', name: 'name', path: 'path',
    category: 'category', extension: 'extension',
    type: 'type', sizeRaw: 'size', lastModified: 'lastModified',
    createdDate: 'createdDate', author: 'author', title: 'title',
    description: 'description', levelOfDescription: 'levelOfDescription',
    language: 'language', extent: 'extent',
    source: 'source', url: 'url', notes: 'notes', excerpt: 'excerpt',
    // sizeFormatted and deepMeta are excluded — derived/complex
};

/**
 * Apply a mapping's transformations permanently to a set of records.
 * Mutates records in place. Only writes to standard field properties;
 * skips deepMeta, sizeFormatted, and custom fields (no backing property).
 *
 * @param {Object} mapping — the mapping object (with .fields[])
 * @param {Object[]} records — the metadata records to mutate
 * @param {Function} formatBytes — the byte formatter (for sizeFormatted, though rarely written)
 * @returns {number} The number of records modified
 */
export function applyMappingToRecords(mapping, records, formatBytes) {
    if (!mapping || !records || records.length === 0) return 0;

    const fields = mapping.fields.filter(f => f.included);

    for (const item of records) {
        for (const f of fields) {
            // Skip fields with no writable property
            const prop = FIELD_TO_PROP[f.key];
            if (!prop && !f.custom) {
                // deepMeta or sizeFormatted — skip
                if (f.key === 'deepMeta' || f.key === 'sizeFormatted') continue;
            }
            if (f.custom) continue; // custom fields have no backing property

            if (!prop) continue;

            let val;

            // Compute value using same logic as rowBuilder
            if (f.mode === 'fixed value') {
                val = f.fixedValue || '';
            } else if (f.mode === 'map metadata' && f.metadataKey) {
                val = '';
                if (item.deepMeta) {
                    const keys = [f.metadataKey, ...(f.metadataFallbacks || [])];
                    for (const key of keys) {
                        if (!key) continue;
                        const v = item.deepMeta[key];
                        if (v !== undefined && v !== null && v !== '') {
                            val = (typeof v === 'object') ? JSON.stringify(v) : String(v);
                            break;
                        }
                    }
                }
            } else {
                // "no change" or "name change" — read current value
                switch (f.key) {
                    case 'referenceCode': val = item.referenceCode || ''; break;
                    case 'name':          val = item.name; break;
                    case 'path':          val = item.path || ''; break;
                    case 'category':      val = item.category || ''; break;
                    case 'extension':     val = item.extension; break;
                    case 'type':          val = item.type; break;
                    case 'sizeRaw':       val = item.size; break;
                    case 'lastModified':  val = item.lastModified; break;
                    case 'createdDate':   val = item.createdDate || ''; break;
                    case 'author':        val = item.author || ''; break;
                    case 'title':         val = item.title || ''; break;
                    case 'description':   val = item.description || ''; break;
                    case 'levelOfDescription': val = item.levelOfDescription || ''; break;
                    case 'language':      val = item.language || ''; break;
                    case 'extent':        val = item.extent || ''; break;
                    case 'source':        val = item.source; break;
                    case 'url':           val = item.url || ''; break;
                    case 'notes':         val = item.notes || ''; break;
                    case 'excerpt':       val = item.excerpt || ''; break;
                    default:              val = ''; break;
                }
            }

            // Apply prepend/append
            val = String(val);
            if (val !== '' && f.prepend && f.prependValue) val = f.prependValue + val;
            if (val !== '' && f.append && f.appendValue) val = val + f.appendValue;

            item[prop] = val;
        }
    }

    return records.length;
}
