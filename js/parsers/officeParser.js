/**
 * Extract metadata from Office Open XML files (DOCX, XLSX, PPTX).
 * These are ZIP archives containing docProps/core.xml and docProps/app.xml.
 * @param {File} file
 * @returns {Promise<Object|null>} Parsed metadata or null
 */
export async function parseOfficeMetadata(file) {
    try {
        const ext = file.name.split('.').pop()?.toLowerCase();
        const supported = ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'];
        if (!supported.includes(ext)) return null;

        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        // Verify ZIP signature (PK\x03\x04)
        if (bytes[0] !== 0x50 || bytes[1] !== 0x4B || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
            return null;
        }

        const info = {};

        // Extract and parse docProps/core.xml (Dublin Core metadata)
        const coreXml = await extractFileFromZip(bytes, 'docProps/core.xml');
        if (coreXml) {
            const core = parseXmlFields(coreXml, {
                'dc:title': 'title',
                'dc:subject': 'subject',
                'dc:creator': 'creator',
                'dc:description': 'description',
                'cp:lastModifiedBy': 'lastModifiedBy',
                'cp:revision': 'revision',
                'dcterms:created': 'created',
                'dcterms:modified': 'modified',
                'cp:keywords': 'keywords',
                'cp:category': 'category',
                'cp:contentStatus': 'contentStatus',
                'dc:language': 'language',
            });
            Object.assign(info, core);
        }

        // Extract and parse docProps/app.xml (application-specific metadata)
        const appXml = await extractFileFromZip(bytes, 'docProps/app.xml');
        if (appXml) {
            const app = parseXmlFields(appXml, {
                'Application': 'application',
                'AppVersion': 'appVersion',
                'Template': 'template',
                'TotalTime': 'totalEditingMinutes',
                'Pages': 'pages',
                'Words': 'words',
                'Characters': 'characters',
                'CharactersWithSpaces': 'charactersWithSpaces',
                'Paragraphs': 'paragraphs',
                'Lines': 'lines',
                'Slides': 'slides',
                'Notes': 'notes',
                'Company': 'company',
                'Manager': 'manager',
                'HiddenSlides': 'hiddenSlides',
                'PresentationFormat': 'presentationFormat',
                'SharedDoc': 'sharedDoc',
                'HyperlinksChanged': 'hyperlinksChanged',
                'LinksUpToDate': 'linksUpToDate',
                'ScaleCrop': 'scaleCrop',
                'DocSecurity': 'docSecurity',
            });
            Object.assign(info, app);
        }

        // Extract and parse docProps/custom.xml (user-defined custom properties)
        const customXml = await extractFileFromZip(bytes, 'docProps/custom.xml');
        if (customXml) {
            const custom = parseCustomProperties(customXml);
            if (Object.keys(custom).length > 0) {
                info.customProperties = custom;
            }
        }

        // For ODF formats, try meta.xml
        if (['odt', 'ods', 'odp'].includes(ext)) {
            const metaXml = await extractFileFromZip(bytes, 'meta.xml');
            if (metaXml) {
                const meta = parseXmlFields(metaXml, {
                    'dc:title': 'title',
                    'dc:subject': 'subject',
                    'dc:creator': 'creator',
                    'dc:description': 'description',
                    'dc:language': 'language',
                    'meta:creation-date': 'created',
                    'dc:date': 'modified',
                    'meta:editing-cycles': 'revision',
                    'meta:editing-duration': 'totalEditingTime',
                    'meta:generator': 'application',
                    'meta:keyword': 'keywords',
                    'meta:initial-creator': 'initialCreator',
                });
                Object.assign(info, meta);
            }
        }

        if (Object.keys(info).length === 0) return null;

        console.group(`[Docucata:Office] ${file.name}`);
        console.log('Office metadata:', info);
        console.groupEnd();

        return info;
    } catch (e) {
        console.warn(`[Docucata:Office] Failed to parse ${file.name}:`, e);
        return null;
    }
}

/**
 * Minimal ZIP file extractor — finds and decompresses a specific file.
 * Uses the Central Directory for reliable size lookups (handles data descriptors).
 * Supports Store (0) and Deflate (8) compression methods.
 */
async function extractFileFromZip(zipBytes, targetName) {
    const targetLower = targetName.toLowerCase();

    // Locate the End of Central Directory record (scan backwards from end)
    // EOCD signature: PK\x05\x06
    let eocdOffset = -1;
    for (let i = zipBytes.length - 22; i >= 0 && i >= zipBytes.length - 65557; i--) {
        if (zipBytes[i] === 0x50 && zipBytes[i + 1] === 0x4B &&
            zipBytes[i + 2] === 0x05 && zipBytes[i + 3] === 0x06) {
            eocdOffset = i;
            break;
        }
    }

    if (eocdOffset === -1) return null;

    const cdOffset = readU32(zipBytes, eocdOffset + 16);  // offset of start of central directory
    const cdEntries = zipBytes[eocdOffset + 8] | (zipBytes[eocdOffset + 9] << 8);  // total entries

    // Walk the Central Directory to find the target file
    let pos = cdOffset;
    for (let e = 0; e < cdEntries && pos < zipBytes.length - 46; e++) {
        // Central directory file header signature: PK\x01\x02
        if (zipBytes[pos] !== 0x50 || zipBytes[pos + 1] !== 0x4B ||
            zipBytes[pos + 2] !== 0x01 || zipBytes[pos + 3] !== 0x02) break;

        const method = zipBytes[pos + 10] | (zipBytes[pos + 11] << 8);
        const compressedSize = readU32(zipBytes, pos + 20);
        const nameLen = zipBytes[pos + 28] | (zipBytes[pos + 29] << 8);
        const extraLen = zipBytes[pos + 30] | (zipBytes[pos + 31] << 8);
        const commentLen = zipBytes[pos + 32] | (zipBytes[pos + 33] << 8);
        const localHeaderOffset = readU32(zipBytes, pos + 42);

        const nameBytes = zipBytes.slice(pos + 46, pos + 46 + nameLen);
        const fileName = new TextDecoder().decode(nameBytes).toLowerCase();

        pos += 46 + nameLen + extraLen + commentLen;

        if (fileName !== targetLower) continue;

        // Read local file header to find the actual data start
        const lh = localHeaderOffset;
        if (lh + 30 > zipBytes.length) return null;
        const lhNameLen = zipBytes[lh + 26] | (zipBytes[lh + 27] << 8);
        const lhExtraLen = zipBytes[lh + 28] | (zipBytes[lh + 29] << 8);
        const dataStart = lh + 30 + lhNameLen + lhExtraLen;

        const compressedData = zipBytes.slice(dataStart, dataStart + compressedSize);

        if (method === 0) {
            return new TextDecoder('utf-8').decode(compressedData);
        } else if (method === 8) {
            return await decompressDeflate(compressedData);
        }
        return null;
    }

    return null;
}

function readU32(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

/**
 * Decompress raw deflate data using the browser's DecompressionStream.
 * Falls back to manual scanning if DecompressionStream isn't available.
 */
async function decompressDeflate(compressedBytes) {
    // Use synchronous fallback: try to parse XML directly from compressed data
    // by scanning for readable XML fragments
    if (typeof DecompressionStream === 'undefined') {
        return scanForXml(compressedBytes);
    }

    // DecompressionStream expects raw deflate, which is what ZIP stores
    try {
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        const reader = ds.readable.getReader();

        writer.write(compressedBytes);
        writer.close();

        return await readAll(reader);
    } catch {
        return scanForXml(compressedBytes);
    }
}

async function readAll(reader) {
    const chunks = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLen);
    let pos = 0;
    for (const chunk of chunks) {
        result.set(chunk, pos);
        pos += chunk.length;
    }
    return new TextDecoder('utf-8').decode(result);
}

function scanForXml(bytes) {
    // Last resort: try to find XML-like content in the raw bytes
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (text.includes('<?xml') || text.includes('<cp:') || text.includes('<dc:')) {
        return text;
    }
    return null;
}

function parseXmlFields(xml, fieldMap) {
    if (!xml) return {};
    const result = {};
    for (const [xmlTag, fieldName] of Object.entries(fieldMap)) {
        // Handle both <ns:tag>value</ns:tag> and <tag>value</tag>
        const regex = new RegExp(`<${escapeRegex(xmlTag)}[^>]*>([\\s\\S]*?)</${escapeRegex(xmlTag)}>`, 'i');
        const match = xml.match(regex);
        if (match) {
            let val = match[1].trim();
            // Strip any inner XML tags
            val = val.replace(/<[^>]+>/g, '').trim();
            if (val) result[fieldName] = val;
        }
    }
    return result;
}

/**
 * Parse docProps/custom.xml — user-defined key-value properties.
 * Format: <property name="Key"><vt:lpwstr>Value</vt:lpwstr></property>
 */
function parseCustomProperties(xml) {
    const props = {};
    const propRegex = /<property[^>]*\bname\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/property>/gi;
    let match;
    while ((match = propRegex.exec(xml)) !== null) {
        const name = match[1].trim();
        const body = match[2];
        // Extract the value from any vt: typed element
        const valMatch = body.match(/<vt:[^>]+>([^<]*)<\/vt:[^>]+>/i);
        if (valMatch && valMatch[1].trim()) {
            props[name] = valMatch[1].trim();
        }
    }
    return props;
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
