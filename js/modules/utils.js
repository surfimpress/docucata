/**
 * Generate a deterministic file ID from file properties for deduplication.
 */
export function generateFileId(name, size, lastModified) {
    const raw = `${name}-${size}-${lastModified}`;
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
        const char = raw.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return 'f_' + Math.abs(hash).toString(36);
}

/**
 * Format bytes into a human-readable string.
 */
export function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const value = bytes / Math.pow(1024, i);
    return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Format an ISO date string into a locale-friendly display string.
 */
export function formatDate(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    return date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/**
 * Extract the lowercase file extension from a filename.
 */
export function getFileExtension(name) {
    const parts = name.split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

/**
 * Detect file type from magic bytes. Worker-safe — accepts an ArrayBuffer.
 * For ZIP files, also peeks at internal paths to distinguish OOXML/ODF.
 * @param {ArrayBuffer} buffer — file content (at least first 2000 bytes for ZIP detection)
 * @returns {{extension: string, mime: string, category: string}|null}
 */
export function detectFileTypeFromBuffer(buffer) {
    if (buffer.byteLength < 4) return null;
    const b = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 16));

    const result = matchMagicBytes(b);
    if (!result) return null;

    // For ZIP, try to distinguish OOXML/ODF subtypes
    if (result.extension === 'zip' && buffer.byteLength >= 30) {
        const detected = detectZipSubtypeFromBuffer(buffer);
        if (detected) return detected;
    }

    return result;
}

/**
 * Detect file type from magic bytes when the extension is missing or unrecognised.
 * Reads the first 16 bytes to match known file signatures.
 * @param {File} file
 * @returns {Promise<{extension: string, mime: string, category: string}|null>}
 */
export async function detectFileType(file) {
    if (file.size < 4) return null;

    const slice = file.slice(0, 2000);
    const buf = await slice.arrayBuffer();
    return detectFileTypeFromBuffer(buf);
}

/**
 * Match magic bytes against known file signatures.
 * @param {Uint8Array} b — first 16 bytes
 * @returns {{extension: string, mime: string, category: string}|null}
 */
function matchMagicBytes(b) {
    // PDF: %PDF
    if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) {
        return { extension: 'pdf', mime: 'application/pdf', category: 'Document' };
    }

    // OLE2: D0 CF 11 E0
    if (b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0) {
        return { extension: 'doc', mime: 'application/msword', category: 'Document' };
    }

    // ZIP (PK\x03\x04)
    if (b[0] === 0x50 && b[1] === 0x4B && b[2] === 0x03 && b[3] === 0x04) {
        return { extension: 'zip', mime: 'application/zip', category: 'Archive' };
    }

    // JPEG: FF D8 FF
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) {
        return { extension: 'jpg', mime: 'image/jpeg', category: 'Image' };
    }

    // PNG: 89 50 4E 47
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) {
        return { extension: 'png', mime: 'image/png', category: 'Image' };
    }

    // GIF: GIF87a / GIF89a
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
        return { extension: 'gif', mime: 'image/gif', category: 'Image' };
    }

    // TIFF: II or MM
    if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A && b[3] === 0x00) ||
        (b[0] === 0x4D && b[1] === 0x4D && b[2] === 0x00 && b[3] === 0x2A)) {
        return { extension: 'tiff', mime: 'image/tiff', category: 'Image' };
    }

    // BMP: BM
    if (b[0] === 0x42 && b[1] === 0x4D) {
        return { extension: 'bmp', mime: 'image/bmp', category: 'Image' };
    }

    // WebP: RIFF....WEBP
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b.length >= 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
        return { extension: 'webp', mime: 'image/webp', category: 'Image' };
    }

    // WAV: RIFF....WAVE
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b.length >= 12 && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45) {
        return { extension: 'wav', mime: 'audio/wav', category: 'Audio' };
    }

    // AIFF: FORM....AIFF
    if (b[0] === 0x46 && b[1] === 0x4F && b[2] === 0x52 && b[3] === 0x4D &&
        b.length >= 12 && b[8] === 0x41 && b[9] === 0x49 && b[10] === 0x46 && b[11] === 0x46) {
        return { extension: 'aiff', mime: 'audio/aiff', category: 'Audio' };
    }

    // FLAC: fLaC
    if (b[0] === 0x66 && b[1] === 0x4C && b[2] === 0x61 && b[3] === 0x43) {
        return { extension: 'flac', mime: 'audio/flac', category: 'Audio' };
    }

    // OGG: OggS
    if (b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) {
        return { extension: 'ogg', mime: 'audio/ogg', category: 'Audio' };
    }

    // MP3: ID3v2 tag
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
        return { extension: 'mp3', mime: 'audio/mpeg', category: 'Audio' };
    }

    // MP3: frame sync (FF FB, FF FA, FF F3, FF F2)
    if (b[0] === 0xFF && (b[1] === 0xFB || b[1] === 0xFA || b[1] === 0xF3 || b[1] === 0xF2)) {
        return { extension: 'mp3', mime: 'audio/mpeg', category: 'Audio' };
    }

    // Word for Mac 4.0: FE 37 00 1C
    if (b[0] === 0xFE && b[1] === 0x37 && b[2] === 0x00 && b[3] === 0x1C) {
        return { extension: 'doc', mime: 'application/msword', category: 'Document' };
    }

    // RTF: {\rtf
    if (b[0] === 0x7B && b[1] === 0x5C && b[2] === 0x72 && b[3] === 0x74 && b[4] === 0x66) {
        return { extension: 'rtf', mime: 'application/rtf', category: 'Document' };
    }

    // If mostly printable text, treat as txt
    const sampleSize = Math.min(b.length, 16);
    let printable = 0;
    for (let i = 0; i < sampleSize; i++) {
        if ((b[i] >= 32 && b[i] <= 126) || b[i] === 9 || b[i] === 10 || b[i] === 13) printable++;
    }
    if (printable / sampleSize >= 0.8) {
        return { extension: 'txt', mime: 'text/plain', category: 'Document' };
    }

    return null;
}

/**
 * Peek inside a ZIP buffer to distinguish Office XML / ODF from plain ZIPs.
 * @param {ArrayBuffer} buffer — at least 2000 bytes of the ZIP file
 * @returns {{extension: string, mime: string, category: string}|null}
 */
function detectZipSubtypeFromBuffer(buffer) {
    const sample = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 2000));
    const text = new TextDecoder('ascii').decode(sample);

    if (text.includes('word/')) {
        return { extension: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', category: 'Document' };
    }
    if (text.includes('xl/')) {
        return { extension: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', category: 'Spreadsheet' };
    }
    if (text.includes('ppt/')) {
        return { extension: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', category: 'Presentation' };
    }
    if (text.includes('META-INF/manifest.xml') || text.includes('content.xml')) {
        if (text.includes('opendocument.text')) return { extension: 'odt', mime: 'application/vnd.oasis.opendocument.text', category: 'Document' };
        if (text.includes('opendocument.spreadsheet')) return { extension: 'ods', mime: 'application/vnd.oasis.opendocument.spreadsheet', category: 'Spreadsheet' };
        if (text.includes('opendocument.presentation')) return { extension: 'odp', mime: 'application/vnd.oasis.opendocument.presentation', category: 'Presentation' };
        return { extension: 'odt', mime: 'application/vnd.oasis.opendocument.text', category: 'Document' };
    }
    return null;
}

const CATEGORY_MAP = {
    // Documents
    pdf: 'Document', doc: 'Document', dot: 'Document', docx: 'Document',
    odt: 'Document', rtf: 'Document', txt: 'Document', md: 'Document',
    tex: 'Document', pages: 'Document',
    // Spreadsheets
    xls: 'Spreadsheet', xlsx: 'Spreadsheet', ods: 'Spreadsheet',
    csv: 'Spreadsheet', numbers: 'Spreadsheet', tsv: 'Spreadsheet',
    // Presentations
    ppt: 'Presentation', pptx: 'Presentation', odp: 'Presentation',
    key: 'Presentation',
    // Images
    jpg: 'Image', jpeg: 'Image', png: 'Image', gif: 'Image',
    bmp: 'Image', svg: 'Image', webp: 'Image', tiff: 'Image',
    tif: 'Image', ico: 'Image', heic: 'Image', heif: 'Image',
    raw: 'Image', cr2: 'Image', nef: 'Image', psd: 'Image',
    ai: 'Image', eps: 'Image',
    // Video
    mp4: 'Video', mov: 'Video', avi: 'Video', mkv: 'Video',
    wmv: 'Video', flv: 'Video', webm: 'Video', m4v: 'Video',
    // Audio
    mp3: 'Audio', wav: 'Audio', wave: 'Audio', flac: 'Audio', aac: 'Audio',
    ogg: 'Audio', oga: 'Audio', opus: 'Audio', wma: 'Audio', m4a: 'Audio', aiff: 'Audio', aif: 'Audio',
    // Archives
    zip: 'Archive', rar: 'Archive', '7z': 'Archive', tar: 'Archive',
    gz: 'Archive', bz2: 'Archive', xz: 'Archive', dmg: 'Archive',
    // Code
    js: 'Code', ts: 'Code', py: 'Code', java: 'Code',
    c: 'Code', cpp: 'Code', h: 'Code', cs: 'Code',
    rb: 'Code', go: 'Code', rs: 'Code', php: 'Code',
    swift: 'Code', kt: 'Code', html: 'Code', css: 'Code',
    json: 'Code', xml: 'Code', yaml: 'Code', yml: 'Code',
    sh: 'Code', sql: 'Code',
    // Fonts
    ttf: 'Font', otf: 'Font', woff: 'Font', woff2: 'Font', eot: 'Font',
    // Executables
    exe: 'Executable', msi: 'Executable', app: 'Executable',
    deb: 'Executable', rpm: 'Executable',
};

/**
 * Classify a file into a human-readable category based on extension.
 */
export function classifyFile(extension) {
    return CATEGORY_MAP[extension] || 'Other';
}
