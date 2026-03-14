/**
 * Detect if a file is a ZIP archive (but not an Office document) and extract its contents.
 * Returns an array of { file: File, path: string } for each contained file.
 * @param {File} file
 * @param {string} basePath - The path prefix for extracted files
 * @returns {Promise<Array<{file: File, path: string}>|null>} Extracted files or null if not a ZIP
 */
export async function extractZipContents(file, basePath) {
    const ext = file.name.split('.').pop()?.toLowerCase();

    // Don't unpack Office documents — they're ZIPs but should be treated as single files
    const officeExts = ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'jar', 'apk', 'ipa'];
    if (officeExts.includes(ext)) return null;

    try {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        // Verify ZIP signature (PK\x03\x04)
        if (bytes[0] !== 0x50 || bytes[1] !== 0x4B || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
            console.warn(`[Docucata:ZIP] ${file.name}: Not a valid ZIP (bad signature)`);
            return null;
        }

        console.group(`[Docucata:ZIP] Unpacking ${file.name} (${bytes.length} bytes)`);

        // Detect which DecompressionStream formats are available
        await detectDecompressionSupport();

        const entries = parseCentralDirectory(bytes);
        console.log(`[Docucata:ZIP] Found ${entries.length} entries in central directory`);

        const results = [];

        for (const entry of entries) {
            if (entry.isDirectory) {
                console.log(`  [skip] Directory: ${entry.name}`);
                continue;
            }

            // Skip macOS filesystem artifacts
            if (isOsArtifact(entry.name)) {
                console.log(`  [skip] OS artifact: ${entry.name}`);
                continue;
            }

            console.log(`  [entry] ${entry.name} | method=${entry.method} | compressed=${entry.compressedSize} | uncompressed=${entry.uncompressedSize} | localOffset=${entry.localHeaderOffset}`);

            try {
                const data = await extractEntry(bytes, entry);
                if (data) {
                    const innerFile = new File([data], entry.fileName, {
                        type: guessMimeType(entry.fileName),
                        lastModified: entry.lastModified?.getTime() || Date.now()
                    });
                    const path = basePath ? `${basePath}/${entry.name}` : `${file.name}/${entry.name}`;
                    results.push({ file: innerFile, path });
                    console.log(`  [ok] Extracted: ${entry.name} (${data.byteLength} bytes)`);
                } else {
                    console.warn(`  [fail] extractEntry returned null for: ${entry.name}`);
                }
            } catch (e) {
                console.warn(`  [fail] Exception extracting: ${entry.name}`, e);
            }
        }

        console.log(`[Docucata:ZIP] Total: ${results.length} / ${entries.length} files extracted`);
        console.groupEnd();

        return results.length > 0 ? results : null;
    } catch (e) {
        console.error(`[Docucata:ZIP] Fatal error processing ${file.name}:`, e);
        return null;
    }
}

/**
 * Log which DecompressionStream formats are supported by this browser.
 */
let _detectedFormats = null;
async function detectDecompressionSupport() {
    if (_detectedFormats) return;
    _detectedFormats = {};

    const formats = ['deflate-raw', 'deflate', 'gzip', 'raw'];
    for (const fmt of formats) {
        try {
            const ds = new DecompressionStream(fmt);
            _detectedFormats[fmt] = true;
            // Clean up
            ds.writable.getWriter().close();
        } catch {
            _detectedFormats[fmt] = false;
        }
    }
    console.log('[Docucata:ZIP] DecompressionStream support:', _detectedFormats);
}

/**
 * Parse the Central Directory at the end of the ZIP.
 */
function parseCentralDirectory(bytes) {
    let eocdOffset = -1;
    const searchStart = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= searchStart; i--) {
        if (bytes[i] === 0x50 && bytes[i + 1] === 0x4B &&
            bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
            eocdOffset = i;
            break;
        }
    }

    if (eocdOffset === -1) {
        console.warn('[Docucata:ZIP] Could not find End of Central Directory');
        return [];
    }

    const cdEntryCount = read16(bytes, eocdOffset + 10);
    const cdSize = read32(bytes, eocdOffset + 12);
    const cdOffset = read32(bytes, eocdOffset + 16);

    console.log(`[Docucata:ZIP] EOCD at ${eocdOffset} | CD entries=${cdEntryCount} | CD size=${cdSize} | CD offset=${cdOffset}`);

    const entries = [];
    let offset = cdOffset;

    for (let i = 0; i < cdEntryCount; i++) {
        if (offset + 46 > bytes.length) {
            console.warn(`[Docucata:ZIP] CD entry ${i}: offset ${offset} exceeds file length ${bytes.length}`);
            break;
        }
        if (bytes[offset] !== 0x50 || bytes[offset + 1] !== 0x4B ||
            bytes[offset + 2] !== 0x01 || bytes[offset + 3] !== 0x02) {
            console.warn(`[Docucata:ZIP] CD entry ${i}: bad signature at offset ${offset}`);
            break;
        }

        const method = read16(bytes, offset + 10);
        const dosTime = read16(bytes, offset + 12);
        const dosDate = read16(bytes, offset + 14);
        const compressedSize = read32(bytes, offset + 20);
        const uncompressedSize = read32(bytes, offset + 24);
        const nameLen = read16(bytes, offset + 28);
        const extraLen = read16(bytes, offset + 30);
        const commentLen = read16(bytes, offset + 32);
        const localHeaderOffset = read32(bytes, offset + 42);

        const nameBytes = bytes.slice(offset + 46, offset + 46 + nameLen);
        const name = new TextDecoder().decode(nameBytes);
        const fileName = name.split('/').pop() || name;
        const isDirectory = name.endsWith('/');

        entries.push({
            name,
            fileName,
            method,
            compressedSize,
            uncompressedSize,
            localHeaderOffset,
            isDirectory,
            lastModified: dosDateTimeToDate(dosDate, dosTime)
        });

        offset += 46 + nameLen + extraLen + commentLen;
    }

    return entries;
}

/**
 * Extract a single entry's data using its local header offset from the Central Directory.
 */
async function extractEntry(bytes, entry) {
    const lhOffset = entry.localHeaderOffset;
    if (lhOffset + 30 > bytes.length) {
        console.warn(`  [extractEntry] Local header offset ${lhOffset} out of bounds`);
        return null;
    }

    if (bytes[lhOffset] !== 0x50 || bytes[lhOffset + 1] !== 0x4B ||
        bytes[lhOffset + 2] !== 0x03 || bytes[lhOffset + 3] !== 0x04) {
        console.warn(`  [extractEntry] Bad local header signature at ${lhOffset}`);
        return null;
    }

    const localNameLen = read16(bytes, lhOffset + 26);
    const localExtraLen = read16(bytes, lhOffset + 28);
    const dataStart = lhOffset + 30 + localNameLen + localExtraLen;

    if (dataStart + entry.compressedSize > bytes.length) {
        console.warn(`  [extractEntry] Data range ${dataStart}..${dataStart + entry.compressedSize} exceeds file length ${bytes.length}`);
        return null;
    }

    const compressedData = bytes.slice(dataStart, dataStart + entry.compressedSize);

    if (entry.method === 0) {
        return compressedData.buffer;
    } else if (entry.method === 8) {
        return await decompressDeflate(compressedData, entry.name);
    }

    console.warn(`  [extractEntry] Unsupported method ${entry.method} for ${entry.name}`);
    return null;
}

/**
 * Decompress raw deflate data. Tries multiple format names for browser compatibility.
 */
async function decompressDeflate(compressedData, entryName) {
    if (typeof DecompressionStream === 'undefined') {
        console.warn('  [decompress] DecompressionStream API not available');
        return null;
    }

    // Try formats in order of correctness for ZIP raw deflate
    const formats = ['deflate-raw', 'deflate'];

    for (const fmt of formats) {
        const result = await tryDecompress(compressedData, fmt, entryName);
        if (result) return result;
    }

    console.warn(`  [decompress] All format attempts failed for ${entryName}`);
    return null;
}

/**
 * Attempt decompression with a specific format, fully catching all stream errors.
 */
function tryDecompress(compressedData, fmt, entryName) {
    return new Promise((resolve) => {
        try {
            const ds = new DecompressionStream(fmt);
            const writer = ds.writable.getWriter();
            const reader = ds.readable.getReader();
            const chunks = [];

            // Write data and close — catch write errors
            writer.write(compressedData).catch(() => {});
            writer.close().catch(() => {});

            function pump() {
                reader.read().then(({ done, value }) => {
                    if (done) {
                        if (chunks.length === 0) {
                            resolve(null);
                            return;
                        }
                        const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
                        const result = new Uint8Array(totalLen);
                        let pos = 0;
                        for (const chunk of chunks) {
                            result.set(chunk, pos);
                            pos += chunk.length;
                        }
                        resolve(result.buffer);
                        return;
                    }
                    chunks.push(value);
                    pump();
                }).catch((err) => {
                    // Stream error (truncated, corrupt, etc.)
                    // If we got partial data, return what we have
                    if (chunks.length > 0) {
                        console.warn(`  [decompress] ${entryName}: stream error with '${fmt}', returning partial data`);
                        const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
                        const result = new Uint8Array(totalLen);
                        let pos = 0;
                        for (const chunk of chunks) {
                            result.set(chunk, pos);
                            pos += chunk.length;
                        }
                        resolve(result.buffer);
                    } else {
                        resolve(null);
                    }
                });
            }

            pump();
        } catch {
            resolve(null);
        }
    });
}

function dosDateTimeToDate(dosDate, dosTime) {
    const day = dosDate & 0x1F;
    const month = ((dosDate >> 5) & 0x0F) - 1;
    const year = ((dosDate >> 9) & 0x7F) + 1980;
    const second = (dosTime & 0x1F) * 2;
    const minute = (dosTime >> 5) & 0x3F;
    const hour = (dosTime >> 11) & 0x1F;
    return new Date(year, month, day, hour, minute, second);
}

function read16(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
}

function read32(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

/**
 * Detect OS-generated junk files that should be skipped during extraction.
 */
function isOsArtifact(name) {
    const basename = name.split('/').pop();
    if (!basename) return true;

    // macOS: resource forks (._*), Finder metadata, Spotlight, Trash
    if (name.includes('__MACOSX/')) return true;
    if (basename.startsWith('._')) return true;
    if (basename === '.DS_Store') return true;
    if (basename === '.Spotlight-V100' || basename === '.Trashes' || basename === '.fseventsd') return true;

    // Windows: Thumbs.db, desktop.ini
    if (basename === 'Thumbs.db' || basename === 'desktop.ini') return true;

    return false;
}

const MIME_MAP = {
    pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp',
    mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', txt: 'text/plain',
    html: 'text/html', css: 'text/css', js: 'text/javascript', json: 'application/json',
    xml: 'application/xml', csv: 'text/csv', zip: 'application/zip',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function guessMimeType(filename) {
    const ext = filename.split('.').pop()?.toLowerCase();
    return MIME_MAP[ext] || 'application/octet-stream';
}
