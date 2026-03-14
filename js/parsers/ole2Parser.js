/**
 * Extract metadata from legacy OLE2/Compound Binary files (.doc, .xls, .ppt, .dot).
 * These files store metadata in the SummaryInformation and DocumentSummaryInformation streams.
 * Properly follows the FAT chain to read fragmented streams.
 * @param {File} file
 * @returns {Promise<Object|null>}
 */
export async function parseOle2Metadata(file) {
    try {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        // OLE2 signature: D0 CF 11 E0 A1 B1 1A E1
        if (bytes[0] !== 0xD0 || bytes[1] !== 0xCF || bytes[2] !== 0x11 || bytes[3] !== 0xE0) {
            return null;
        }

        const info = {};

        // Parse the OLE2 header
        const header = parseOle2Header(bytes);
        if (!header) return null;

        // Build the FAT (sector allocation table)
        const fat = buildFAT(bytes, header);
        if (!fat) return null;

        // Read the directory entries
        const dirEntries = readDirectoryEntries(bytes, header, fat);

        // Build mini stream context for small streams
        const miniCtx = buildMiniStreamContext(bytes, header, fat, dirEntries);

        console.group(`[Docucata:OLE2] ${file.name}`);
        console.log(`Sector size: ${header.sectorSize}, FAT sectors: ${header.fatSectorCount}, Directory entries: ${dirEntries.length}`);

        // Find and parse SummaryInformation
        const summaryEntry = dirEntries.find(e => e.name === '\x05SummaryInformation');
        if (summaryEntry) {
            const streamData = readStream(bytes, header, fat, summaryEntry, miniCtx);
            if (streamData) {
                const props = parseSummaryProperties(streamData, SUMMARY_PROP_NAMES);
                console.log('SummaryInformation:', props);
                Object.assign(info, props);
            }
        }

        // Find and parse DocumentSummaryInformation
        const docSummaryEntry = dirEntries.find(e => e.name === '\x05DocumentSummaryInformation');
        if (docSummaryEntry) {
            const streamData = readStream(bytes, header, fat, docSummaryEntry, miniCtx);
            if (streamData) {
                const props = parseSummaryProperties(streamData, DOCSUMMARY_PROP_NAMES);
                console.log('DocumentSummaryInformation:', props);
                Object.assign(info, props);
            }
        }

        // Fallback: scan for readable strings that look like metadata
        if (Object.keys(info).length === 0) {
            const fallback = scanForMetadataStrings(bytes);
            Object.assign(info, fallback);
        }

        if (Object.keys(info).length === 0) {
            console.log('No metadata found');
            console.groupEnd();
            return null;
        }

        console.log('Combined metadata:', info);
        console.groupEnd();

        return info;
    } catch (e) {
        console.warn(`[Docucata:OLE2] Failed to parse ${file.name}:`, e);
        return null;
    }
}

/**
 * Parse the OLE2 file header (first 512 bytes).
 */
function parseOle2Header(bytes) {
    if (bytes.length < 512) return null;

    const sectorSizePow = readU16(bytes, 30);
    const sectorSize = 1 << sectorSizePow;
    const miniSectorSizePow = readU16(bytes, 32);
    const miniSectorSize = 1 << miniSectorSizePow;
    const fatSectorCount = readU32(bytes, 44);
    const firstDirSector = readU32(bytes, 48);
    const miniStreamCutoff = readU32(bytes, 56);
    const firstMiniFatSector = readU32(bytes, 60);
    const miniFatSectorCount = readU32(bytes, 64);
    const firstDifatSector = readU32(bytes, 68);
    const difatSectorCount = readU32(bytes, 72);

    // First 109 DIFAT entries are in the header at offset 76
    const difatEntries = [];
    for (let i = 0; i < 109; i++) {
        const sector = readU32(bytes, 76 + i * 4);
        if (sector === 0xFFFFFFFE || sector === 0xFFFFFFFF) break;
        difatEntries.push(sector);
    }

    return {
        sectorSize,
        miniSectorSize,
        fatSectorCount,
        firstDirSector,
        miniStreamCutoff,
        firstMiniFatSector,
        miniFatSectorCount,
        firstDifatSector,
        difatSectorCount,
        difatEntries,
    };
}

/**
 * Convert a sector number to a byte offset in the file.
 */
function sectorOffset(sectorNum, sectorSize) {
    return (sectorNum + 1) * sectorSize;
}

/**
 * Build the FAT from DIFAT entries. The FAT maps each sector to the next
 * sector in its chain (like a linked list of sectors).
 */
function buildFAT(bytes, header) {
    const fat = [];
    const entriesPerSector = header.sectorSize / 4;

    // Read FAT sectors listed in DIFAT
    for (const fatSector of header.difatEntries) {
        const offset = sectorOffset(fatSector, header.sectorSize);
        if (offset + header.sectorSize > bytes.length) break;
        for (let i = 0; i < entriesPerSector; i++) {
            fat.push(readU32(bytes, offset + i * 4));
        }
    }

    // Follow DIFAT chain for files with > 109 FAT sectors
    if (header.difatSectorCount > 0 && header.firstDifatSector !== 0xFFFFFFFE) {
        let difatSector = header.firstDifatSector;
        for (let d = 0; d < header.difatSectorCount && difatSector !== 0xFFFFFFFE; d++) {
            const offset = sectorOffset(difatSector, header.sectorSize);
            if (offset + header.sectorSize > bytes.length) break;
            // Last 4 bytes of each DIFAT sector point to next DIFAT sector
            for (let i = 0; i < entriesPerSector - 1; i++) {
                const sector = readU32(bytes, offset + i * 4);
                if (sector === 0xFFFFFFFE || sector === 0xFFFFFFFF) break;
                const fatOffset = sectorOffset(sector, header.sectorSize);
                if (fatOffset + header.sectorSize > bytes.length) break;
                for (let j = 0; j < entriesPerSector; j++) {
                    fat.push(readU32(bytes, fatOffset + j * 4));
                }
            }
            difatSector = readU32(bytes, offset + (entriesPerSector - 1) * 4);
        }
    }

    return fat;
}

/**
 * Follow a FAT chain starting from a sector, collecting all sector numbers.
 */
function followChain(fat, startSector, maxSectors) {
    const chain = [];
    let sector = startSector;
    const limit = maxSectors || 10000;
    while (sector !== 0xFFFFFFFE && sector !== 0xFFFFFFFF && sector < fat.length && chain.length < limit) {
        chain.push(sector);
        sector = fat[sector];
    }
    return chain;
}

/**
 * Read all directory entries by following the directory chain in the FAT.
 */
function readDirectoryEntries(bytes, header, fat) {
    const chain = followChain(fat, header.firstDirSector, 100);
    const entries = [];

    for (const sector of chain) {
        const offset = sectorOffset(sector, header.sectorSize);
        if (offset + header.sectorSize > bytes.length) break;

        const entriesPerSector = header.sectorSize / 128;
        for (let i = 0; i < entriesPerSector; i++) {
            const entryOffset = offset + i * 128;
            if (entryOffset + 128 > bytes.length) break;

            const nameLen = readU16(bytes, entryOffset + 64);
            if (nameLen === 0 || nameLen > 64) continue;

            // Entry name is UTF-16LE
            let name = '';
            for (let j = 0; j < nameLen - 2; j += 2) {
                name += String.fromCharCode(readU16(bytes, entryOffset + j));
            }

            const entryType = bytes[entryOffset + 66]; // 1=storage, 2=stream, 5=root
            const startSector = readU32(bytes, entryOffset + 116);
            const streamSize = readU32(bytes, entryOffset + 120);

            entries.push({ name, entryType, startSector, streamSize });
        }
    }

    return entries;
}

/**
 * Read a stream's full data by following its FAT chain.
 * Handles both regular streams and mini streams (< miniStreamCutoff).
 */
function readStream(bytes, header, fat, entry, miniCtx) {
    if (entry.streamSize === 0) return null;

    // Small streams are stored in the mini stream (64-byte sectors)
    if (entry.streamSize < header.miniStreamCutoff && miniCtx) {
        return readMiniStreamData(miniCtx, header, entry);
    }

    const chain = followChain(fat, entry.startSector, 1000);
    if (chain.length === 0) return null;

    const result = new Uint8Array(entry.streamSize);
    let pos = 0;

    for (const sector of chain) {
        const offset = sectorOffset(sector, header.sectorSize);
        if (offset >= bytes.length) break;
        const available = Math.min(header.sectorSize, bytes.length - offset, entry.streamSize - pos);
        if (available <= 0) break;
        result.set(bytes.subarray(offset, offset + available), pos);
        pos += available;
        if (pos >= entry.streamSize) break;
    }

    return result;
}

/**
 * Build the mini stream context: the container data and mini FAT.
 */
function buildMiniStreamContext(bytes, header, fat, dirs) {
    const rootEntry = dirs.find(e => e.entryType === 5);
    if (!rootEntry || rootEntry.streamSize === 0) return null;

    const containerChain = followChain(fat, rootEntry.startSector, 10000);
    if (containerChain.length === 0) return null;

    const container = new Uint8Array(rootEntry.streamSize);
    let pos = 0;
    for (const sector of containerChain) {
        const offset = sectorOffset(sector, header.sectorSize);
        if (offset >= bytes.length) break;
        const available = Math.min(header.sectorSize, bytes.length - offset, rootEntry.streamSize - pos);
        if (available <= 0) break;
        container.set(bytes.subarray(offset, offset + available), pos);
        pos += available;
        if (pos >= rootEntry.streamSize) break;
    }

    const miniFat = [];
    if (header.firstMiniFatSector !== 0xFFFFFFFE) {
        const mfChain = followChain(fat, header.firstMiniFatSector, 1000);
        const entriesPerSector = header.sectorSize / 4;
        for (const sector of mfChain) {
            const offset = sectorOffset(sector, header.sectorSize);
            if (offset + header.sectorSize > bytes.length) break;
            for (let i = 0; i < entriesPerSector; i++) {
                miniFat.push(readU32(bytes, offset + i * 4));
            }
        }
    }

    return { container, miniFat };
}

/**
 * Read data from the mini stream using mini sectors.
 */
function readMiniStreamData(miniCtx, header, entry) {
    const miniSectorSize = header.miniSectorSize || 64;
    const chain = followChain(miniCtx.miniFat, entry.startSector, 10000);
    if (chain.length === 0) return null;

    const result = new Uint8Array(entry.streamSize);
    let pos = 0;
    for (const sector of chain) {
        const offset = sector * miniSectorSize;
        if (offset >= miniCtx.container.length) break;
        const available = Math.min(miniSectorSize, miniCtx.container.length - offset, entry.streamSize - pos);
        if (available <= 0) break;
        result.set(miniCtx.container.subarray(offset, offset + available), pos);
        pos += available;
        if (pos >= entry.streamSize) break;
    }
    return result;
}

// Property ID → field name for SummaryInformation stream
const SUMMARY_PROP_NAMES = {
    2: 'title',
    3: 'subject',
    4: 'author',
    5: 'keywords',
    6: 'comments',
    7: 'template',
    8: 'lastAuthor',
    9: 'revisionNumber',
    10: 'editTime',
    11: 'lastPrinted',
    12: 'created',
    13: 'modified',
    14: 'pageCount',
    15: 'wordCount',
    16: 'charCount',
    18: 'application',
    19: 'security',
};

// Property ID → field name for DocumentSummaryInformation stream
const DOCSUMMARY_PROP_NAMES = {
    2: 'category',
    3: 'presentationTarget',
    4: 'byteCount',
    5: 'lineCount',
    6: 'manager',
    7: 'company',
    8: 'paragraphCount',
    9: 'slideCount',
    10: 'noteCount',
    11: 'hiddenSlideCount',
    14: 'docVersion',
    26: 'contentType',
    27: 'contentStatus',
    28: 'language',
};

/**
 * Parse a SummaryInformation or DocumentSummaryInformation property set stream.
 * The stream data is already fully assembled from the FAT chain.
 */
function parseSummaryProperties(streamData, propNames) {
    const props = {};

    if (streamData.length < 48) return props;

    // Property set header:
    // Byte order (2) + version (2) + OS version (4) + class ID (16) + section count (4) = 28
    // Then for each section: FMTID (16) + offset (4)
    // First section offset is at byte 44

    const sectionOffset = readU32(streamData, 44);
    if (sectionOffset + 8 > streamData.length) return props;

    const sectionSize = readU32(streamData, sectionOffset);
    const propCount = readU32(streamData, sectionOffset + 4);

    for (let i = 0; i < Math.min(propCount, 50); i++) {
        const pidOffset = sectionOffset + 8 + (i * 8);
        if (pidOffset + 8 > streamData.length) break;

        const propId = readU32(streamData, pidOffset);
        const propOffset = sectionOffset + readU32(streamData, pidOffset + 4);

        if (propOffset + 8 > streamData.length) continue;

        const propName = propNames[propId];
        if (!propName) continue;

        const type = readU32(streamData, propOffset);

        if (type === 30 || type === 0x1E) {
            // VT_LPSTR — length-prefixed ANSI string
            const strLen = readU32(streamData, propOffset + 4);
            if (strLen > 0 && strLen < 4096 && propOffset + 8 + strLen <= streamData.length) {
                let str = '';
                for (let j = 0; j < strLen - 1; j++) {
                    const ch = streamData[propOffset + 8 + j];
                    if (ch === 0) break;
                    str += String.fromCharCode(ch);
                }
                if (str.trim()) props[propName] = str.trim();
            }
        } else if (type === 31 || type === 0x1F) {
            // VT_LPWSTR — length-prefixed Unicode string
            const strLen = readU32(streamData, propOffset + 4);
            if (strLen > 0 && strLen < 4096 && propOffset + 8 + strLen * 2 <= streamData.length) {
                let str = '';
                for (let j = 0; j < strLen - 1; j++) {
                    str += String.fromCharCode(readU16(streamData, propOffset + 8 + j * 2));
                }
                if (str.trim()) props[propName] = str.trim();
            }
        } else if (type === 64 || type === 0x40) {
            // VT_FILETIME — 8-byte Windows FILETIME
            if (propOffset + 16 <= streamData.length) {
                if (propName === 'editTime') {
                    // Edit time is a duration, not an absolute timestamp
                    const duration = readFiletimeDuration(streamData, propOffset + 4);
                    if (duration) props[propName] = duration;
                } else {
                    const ft = readFiletime(streamData, propOffset + 4);
                    if (ft) props[propName] = ft;
                }
            }
        } else if (type === 3) {
            // VT_I4 — 4-byte signed integer
            const val = readU32(streamData, propOffset + 4);
            if (val > 0) props[propName] = val;
        }
    }

    return props;
}

/**
 * Convert a Windows FILETIME (100ns intervals since 1601-01-01) to ISO string.
 */
function readFiletime(bytes, offset) {
    const lo = readU32(bytes, offset);
    const hi = readU32(bytes, offset + 4);
    if (lo === 0 && hi === 0) return null;

    // FILETIME to JS: subtract epoch difference and convert from 100ns to ms
    // Epoch diff: 11644473600 seconds between 1601-01-01 and 1970-01-01
    const fileTime = (hi * 0x100000000 + lo);
    const ms = fileTime / 10000 - 11644473600000;

    try {
        const date = new Date(ms);
        if (date.getFullYear() > 1900 && date.getFullYear() < 2100) {
            return date.toISOString();
        }
    } catch {}
    return null;
}

/**
 * Convert a Windows FILETIME duration (100ns intervals) to human-readable string.
 * Used for editing time which is a duration, not an absolute date.
 */
function readFiletimeDuration(bytes, offset) {
    const lo = readU32(bytes, offset);
    const hi = readU32(bytes, offset + 4);
    if (lo === 0 && hi === 0) return null;

    const totalMinutes = Math.round((hi * 0x100000000 + lo) / 600000000);
    if (totalMinutes <= 0) return null;

    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

/**
 * Fallback: scan for readable ASCII strings that look like metadata fields.
 */
function scanForMetadataStrings(bytes) {
    const info = {};
    const text = new TextDecoder('latin1').decode(bytes);

    // Look for Microsoft Office signature
    const appPatterns = [
        /Microsoft (?:Office )?Word/,
        /Microsoft (?:Office )?Excel/,
        /Microsoft (?:Office )?PowerPoint/,
    ];
    for (const pat of appPatterns) {
        const m = text.match(pat);
        if (m) { info.application = m[0]; break; }
    }

    return info;
}

function readU16(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}
