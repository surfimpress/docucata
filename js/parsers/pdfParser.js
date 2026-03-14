/**
 * Extract metadata from a PDF file.
 * Primary method: uses pdf.js (if loaded) which properly decompresses object streams.
 * Fallback: raw byte scanning for uncompressed PDFs.
 * @param {File} file
 * @returns {Promise<Object|null>} Parsed metadata or null if not a PDF / parse failure
 */
export async function parsePdfMetadata(file) {
    try {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        // Verify PDF signature
        const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
        if (!head.startsWith('%PDF')) return null;

        // Try pdf.js first — it handles compressed object streams
        if (typeof pdfjsLib !== 'undefined') {
            const result = await parsePdfWithPdfjs(buffer, head);
            if (result && Object.keys(result).length > 0) {
                console.group(`[Docucata:PDF] ${file.name}`);
                console.log('PDF metadata (via pdf.js):', result);
                console.groupEnd();
                return result;
            }
        }

        // Fallback: regex scan of raw bytes (only works for uncompressed PDFs)
        const text = new TextDecoder('latin1').decode(bytes);
        const result = parsePdfWithRegex(text);

        console.group(`[Docucata:PDF] ${file.name}`);
        console.log('PDF metadata (regex fallback):', result);
        console.groupEnd();

        return result && Object.keys(result).length > 0 ? result : null;
    } catch (e) {
        console.warn(`[Docucata:PDF] Failed to parse ${file.name}:`, e);
        return null;
    }
}

/**
 * Extract metadata using pdf.js getMetadata() API.
 * This properly handles compressed object streams that regex scanning misses.
 */
async function parsePdfWithPdfjs(buffer, headText) {
    const info = {};

    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    const metadata = await pdf.getMetadata();

    // Info dictionary fields (the standard /Info dict)
    if (metadata.info) {
        const fieldMap = {
            Title: 'Title',
            Author: 'Author',
            Subject: 'Subject',
            Keywords: 'Keywords',
            Creator: 'Creator',
            Producer: 'Producer',
            CreationDate: 'CreationDate',
            ModDate: 'ModDate',
            Trapped: 'Trapped',
            PDFFormatVersion: 'pdfVersion',
            Language: 'language',
            IsLinearized: 'linearized',
            IsAcroFormPresent: 'hasAcroForm',
            IsXFAPresent: 'hasXFA',
            IsCollectionPresent: 'isCollection',
            IsSignaturesPresent: 'hasSignatures',
            Custom: '_custom',
        };

        for (const [pdjsKey, ourKey] of Object.entries(fieldMap)) {
            const val = metadata.info[pdjsKey];
            if (val !== undefined && val !== null && val !== '') {
                if (pdjsKey === 'CreationDate' || pdjsKey === 'ModDate') {
                    info[ourKey] = parsePdfDate(val);
                } else if (pdjsKey === 'Custom') {
                    // Custom is an object of additional info dict entries
                    if (typeof val === 'object') {
                        for (const [k, v] of Object.entries(val)) {
                            if (v !== undefined && v !== null && v !== '') {
                                info[`custom_${k}`] = typeof v === 'string' ? v : String(v);
                            }
                        }
                    }
                } else {
                    info[ourKey] = val;
                }
            }
        }
    }

    // Page count
    info.pageCount = pdf.numPages;

    // Check for encryption
    info.encrypted = !!metadata.info?.IsEncrypted;

    // Linearized from head text (pdf.js also reports it but let's be thorough)
    if (!info.linearized && /\/Linearized\s/.test(headText)) {
        info.linearized = true;
    }

    // XMP metadata — pdf.js parses XMP into a Metadata object
    if (metadata.metadata) {
        try {
            // pdf.js 4.x: getAll() returns a Map-like object
            const xmpEntries = metadata.metadata.getAll();
            if (xmpEntries) {
                const entries = xmpEntries instanceof Map ? xmpEntries.entries()
                    : typeof xmpEntries[Symbol.iterator] === 'function' ? xmpEntries
                    : Object.entries(xmpEntries);
                for (const [key, value] of entries) {
                    if (!value || (typeof value === 'string' && !value.trim())) continue;
                    const mapped = mapXmpKey(key);
                    const strVal = typeof value === 'string' ? value.trim() : String(value);
                    if (mapped && !info[mapped] && strVal) {
                        info[mapped] = strVal;
                    }
                }
            }
        } catch (xmpErr) {
            console.warn('[Docucata:PDF] XMP extraction via pdf.js failed:', xmpErr);
        }
    }

    // Combine PDF/A part + conformance
    if (info.pdfaPart) {
        const level = info.pdfaConformance || '';
        info.pdfaConformance = `PDF/A-${info.pdfaPart}${level.toLowerCase()}`;
        delete info.pdfaPart;
    }

    pdf.destroy();
    return info;
}

/**
 * Map XMP metadata keys to our field names.
 */
function mapXmpKey(key) {
    const map = {
        'dc:title': 'Title',
        'dc:creator': 'Author',
        'dc:subject': 'Subject',
        'dc:description': 'Description',
        'dc:rights': 'rights',
        'dc:language': 'language',
        'dc:format': 'format',
        'xmp:creatortool': 'Creator',
        'xmp:createdate': 'CreationDate',
        'xmp:modifydate': 'ModDate',
        'xmp:metadatadate': 'metadataDate',
        'xmp:label': 'label',
        'xmp:rating': 'rating',
        'pdf:producer': 'Producer',
        'pdf:keywords': 'Keywords',
        'pdf:trapped': 'Trapped',
        'pdf:pdfversion': 'pdfVersion',
        'pdfaid:part': 'pdfaPart',
        'pdfaid:conformance': 'pdfaConformance',
        'pdfaid:amd': 'pdfaAmendment',
        'pdfuaid:part': 'pdfuaPart',
        'xmprights:webstatement': 'rightsWebStatement',
        'xmprights:marked': 'rightsMarked',
        'xmpmm:documentid': 'documentId',
        'xmpmm:instanceid': 'instanceId',
        'xmpmm:versionid': 'versionId',
        'xmpmm:renditionclass': 'renditionClass',
        'photoshop:colormode': 'colorMode',
        'photoshop:iccprofile': 'iccProfile',
        'prism:aggregationtype': 'aggregationType',
        'prism:copyright': 'copyright',
    };
    // XMP keys from pdf.js can vary in case
    const lower = key.toLowerCase();
    return map[lower] || null;
}

/**
 * Fallback: regex-based extraction for uncompressed PDFs.
 */
function parsePdfWithRegex(text) {
    const info = {};

    const fields = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate', 'Trapped'];
    for (const field of fields) {
        const value = extractPdfField(text, field);
        if (value) {
            info[field] = field.endsWith('Date') ? parsePdfDate(value) : value;
        }
    }

    const versionMatch = text.match(/%PDF-(\d+\.\d+)/);
    if (versionMatch) {
        info.pdfVersion = versionMatch[1];
    }

    const pageMatches = text.match(/\/Type\s*\/Page(?!\s*s)/g);
    if (pageMatches) {
        info.pageCount = pageMatches.length;
    }

    info.encrypted = /\/Encrypt\s/.test(text);

    const head = text.substring(0, 1024);
    if (/\/Linearized\s/.test(head)) {
        info.linearized = true;
    }

    const trappedMatch = text.match(/\/Trapped\s*\/(\w+)/);
    if (trappedMatch) {
        info.trapped = trappedMatch[1];
    }

    // XMP block
    const xmpStart = text.indexOf('<?xpacket begin');
    const xmpEnd = text.indexOf('<?xpacket end');
    if (xmpStart !== -1 && xmpEnd !== -1) {
        const xmp = text.substring(xmpStart, xmpEnd);
        const xmpFields = extractXmpFieldsRegex(xmp);
        for (const [key, value] of Object.entries(xmpFields)) {
            if (!info[key]) info[key] = value;
        }
    }

    if (info.pdfaPart) {
        const level = info.pdfaConformance || '';
        info.pdfaConformance = `PDF/A-${info.pdfaPart}${level.toLowerCase()}`;
        delete info.pdfaPart;
    }

    return info;
}

function extractPdfField(text, fieldName) {
    const parenRegex = new RegExp(`\\/${fieldName}\\s*\\(([^)]*(?:\\\\.[^)]*)*)\\)`, 's');
    const match = text.match(parenRegex);
    if (match) {
        return match[1]
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\\(/g, '(')
            .replace(/\\\)/g, ')')
            .replace(/\\\\/g, '\\');
    }

    const hexRegex = new RegExp(`\\/${fieldName}\\s*<([0-9a-fA-F]+)>`);
    const hexMatch = text.match(hexRegex);
    if (hexMatch) {
        return hexToString(hexMatch[1]);
    }

    return null;
}

function hexToString(hex) {
    let str = '';
    if (hex.startsWith('FEFF') || hex.startsWith('feff')) {
        for (let i = 4; i < hex.length; i += 4) {
            const code = parseInt(hex.substr(i, 4), 16);
            str += String.fromCharCode(code);
        }
    } else {
        for (let i = 0; i < hex.length; i += 2) {
            str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
        }
    }
    return str;
}

/**
 * Parse PDF date format: D:YYYYMMDDHHmmSSOHH'mm'
 */
function parsePdfDate(dateStr) {
    if (!dateStr) return null;
    const clean = String(dateStr).replace(/^D:/, '');
    const m = clean.match(/^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
    if (!m) return dateStr;

    const year = m[1];
    const month = m[2] || '01';
    const day = m[3] || '01';
    const hour = m[4] || '00';
    const min = m[5] || '00';
    const sec = m[6] || '00';

    try {
        return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}`).toISOString();
    } catch {
        return dateStr;
    }
}

function extractXmpFieldsRegex(xmp) {
    const fields = {};
    const tags = {
        'dc:title': 'Title',
        'dc:creator': 'Author',
        'dc:subject': 'Subject',
        'dc:description': 'Description',
        'dc:rights': 'rights',
        'dc:language': 'language',
        'dc:format': 'format',
        'xmp:CreatorTool': 'Creator',
        'xmp:CreateDate': 'CreationDate',
        'xmp:ModifyDate': 'ModDate',
        'pdf:Producer': 'Producer',
        'pdf:Keywords': 'Keywords',
        'pdf:Trapped': 'Trapped',
        'pdfaid:part': 'pdfaPart',
        'pdfaid:conformance': 'pdfaConformance',
        'xmpRights:WebStatement': 'rightsWebStatement',
        'xmpRights:Marked': 'rightsMarked',
        'xmpMM:DocumentID': 'documentId',
        'xmpMM:InstanceID': 'instanceId',
        'xmp:Label': 'label',
        'xmp:Rating': 'rating',
        'photoshop:ColorMode': 'colorMode',
    };

    for (const [xmlTag, fieldName] of Object.entries(tags)) {
        const regex = new RegExp(`<${xmlTag}>([\\s\\S]*?)</${xmlTag}>`);
        const match = xmp.match(regex);
        if (match) {
            let val = match[1].trim();
            const liMatch = val.match(/<rdf:li[^>]*>([^<]*)<\/rdf:li>/);
            if (liMatch) val = liMatch[1];
            if (val) fields[fieldName] = val;
        }
    }
    return fields;
}
