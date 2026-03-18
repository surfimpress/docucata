/**
 * Extract readable text from legacy .doc (OLE2 / Word Binary) files.
 *
 * Strategy:
 *   1. Parse the OLE2 container to locate the WordDocument stream
 *   2. Read the FIB (File Information Block) to find the piece table
 *   3. Read the piece table from the Table stream (0Table or 1Table)
 *   4. Reconstruct text from piece descriptors
 *   5. Fallback: scan the WordDocument stream for printable character runs
 *
 * References:
 *   - [MS-DOC] Word Binary File Format specification
 *   - FIB structure: section 2.5.1
 *   - Piece table: section 2.8.1
 *
 * @param {File} file
 * @returns {Promise<string|null>} Extracted plain text, or null
 */
export async function extractDocText(input) {
    try {
        const buffer = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        // Word for Macintosh 4.0 (pre-OLE2): magic bytes FE 37 00 1C
        if (bytes[0] === 0xFE && bytes[1] === 0x37 && bytes[2] === 0x00 && bytes[3] === 0x1C) {
            return extractWordForMac4(bytes);
        }

        // Verify OLE2 signature
        if (bytes[0] !== 0xD0 || bytes[1] !== 0xCF || bytes[2] !== 0x11 || bytes[3] !== 0xE0) {
            return null;
        }

        const header = parseHeader(bytes);
        if (!header) return null;

        const fat = buildFAT(bytes, header);
        if (!fat) return null;

        const dirs = readDirectoryEntries(bytes, header, fat);

        // Build mini stream context for small streams (< miniStreamCutoff)
        const miniCtx = buildMiniStreamContext(bytes, header, fat, dirs);

        // Find WordDocument stream
        const wordDocEntry = dirs.find(e => e.name === 'WordDocument');
        if (!wordDocEntry) return null;

        const wordDocData = readStream(bytes, header, fat, wordDocEntry, miniCtx);
        if (!wordDocData || wordDocData.length < 68) return null;

        // Try piece table extraction first
        const pieceText = extractViaPieceTable(bytes, header, fat, dirs, wordDocData, miniCtx);
        if (pieceText && pieceText.length > 10) {
            console.log(`[Docucata:DocText] ${file.name}: extracted ${pieceText.length} chars via piece table`);
            return pieceText;
        }

        // Fallback: scan for readable text runs
        const scannedText = scanForText(wordDocData);
        if (scannedText) {
            console.log(`[Docucata:DocText] ${file.name}: extracted ${scannedText.length} chars via text scan`);
            return scannedText;
        }

        return null;
    } catch (e) {
        console.warn(`[Docucata:DocText] Failed to extract text from ${file.name}:`, e);
        return null;
    }
}

// ── Word for Macintosh 4.0 (pre-OLE2) ───────────────────

function extractWordForMac4(bytes) {
    // Pre-OLE2 Word for Mac 4.0 stores text directly in the file body.
    // The header is 256 bytes (0x100), then plain text follows using
    // Mac line endings (\r = 0x0D). Text runs until non-text binary
    // structures appear near the end of the file.

    let text = '';
    let trailingBinary = 0;

    for (let i = 0x100; i < bytes.length; i++) {
        const ch = bytes[i];

        if (ch === 0x0D) {
            text += '\n';
            trailingBinary = 0;
        } else if (ch === 0x09) {
            text += '\t';
            trailingBinary = 0;
        } else if (ch >= 32 && ch <= 126) {
            text += String.fromCharCode(ch);
            trailingBinary = 0;
        } else if (ch >= 0xA0) {
            // Mac Roman high characters — common in pre-OS X files
            text += decodeMacRoman(ch);
            trailingBinary = 0;
        } else {
            // Non-text byte — track consecutive binary to detect end of text
            trailingBinary++;
            if (trailingBinary > 20) {
                // Likely hit the binary footer — trim and stop
                text = text.substring(0, text.length - 20);
                break;
            }
        }
    }

    return cleanDocText(text) || null;
}

/**
 * Decode a Mac Roman high-byte character to Unicode.
 * Covers the most common characters found in pre-OS X Word files.
 */
function decodeMacRoman(ch) {
    const MAC_ROMAN = {
        0xA0: '\u00A0', 0xA5: '\u2022', 0xA9: '\u2026', 0xC7: '\u00AB',
        0xC8: '\u00BB', 0xC9: '\u2026', 0xCA: '\u00A0', 0xD0: '\u2013',
        0xD1: '\u2014', 0xD2: '\u201C', 0xD3: '\u201D', 0xD4: '\u2018',
        0xD5: '\u2019', 0xD6: '\u00F7', 0xE1: '\u00B7',
        // Common accented characters
        0x80: '\u00C4', 0x81: '\u00C5', 0x82: '\u00C7', 0x83: '\u00C9',
        0x84: '\u00D1', 0x85: '\u00D6', 0x86: '\u00DC', 0x87: '\u00E1',
        0x88: '\u00E0', 0x89: '\u00E2', 0x8A: '\u00E4', 0x8B: '\u00E3',
        0x8C: '\u00E5', 0x8D: '\u00E7', 0x8E: '\u00E9', 0x8F: '\u00E8',
        0x90: '\u00EA', 0x91: '\u00EB', 0x92: '\u00ED', 0x93: '\u00EC',
        0x94: '\u00EE', 0x95: '\u00EF', 0x96: '\u00F1', 0x97: '\u00F3',
        0x98: '\u00F2', 0x99: '\u00FA', 0x9A: '\u00F9', 0x9B: '\u00FB',
        0x9C: '\u00FC',
    };
    return MAC_ROMAN[ch] || String.fromCharCode(ch);
}

// ── Piece table approach ────────────────────────────────

function extractViaPieceTable(bytes, header, fat, dirs, wordDocData, miniCtx) {
    try {
        // FIB base (first 32 bytes of WordDocument stream)
        // Offset 10 (0x0A): flags — bit 9 (0x0200) = fWhichTblStm (0=0Table, 1=1Table)
        const fibFlags = readU16(wordDocData, 10);
        const tableName = (fibFlags & 0x0200) ? '1Table' : '0Table';

        // Find the Table stream
        const tableEntry = dirs.find(e => e.name === tableName);
        if (!tableEntry) return null;

        const tableData = readStream(bytes, header, fat, tableEntry, miniCtx);
        if (!tableData) return null;

        // FIB fields we need — their location depends on the FIB version.
        // For Word 97–2003 (nFib >= 193), the FibRgFcLcb97 structure starts
        // at a variable offset. We need fcClx and lcbClx.
        //
        // The FIB layout:
        //   - FibBase: 32 bytes (offset 0)
        //   - csw (2 bytes at offset 32): count of 16-bit values that follow
        //   - FibRgW: csw * 2 bytes
        //   - cslw (2 bytes): count of 32-bit values that follow
        //   - FibRgLw: cslw * 4 bytes
        //   - cbRgFcLcb (2 bytes): count of fc/lcb pairs
        //   - FibRgFcLcb: cbRgFcLcb * 8 bytes (pairs of fc + lcb, each 4 bytes)
        //
        // fcClx is at pair index 66 in FibRgFcLcb97.

        const csw = readU16(wordDocData, 32);
        const rgWEnd = 34 + csw * 2;
        const cslw = readU16(wordDocData, rgWEnd);
        const rgLwEnd = rgWEnd + 2 + cslw * 4;
        const cbRgFcLcb = readU16(wordDocData, rgLwEnd);

        // fcClx is pair index 66 (0-based), lcbClx is pair index 66's lcb
        const CLX_INDEX = 66;
        if (cbRgFcLcb <= CLX_INDEX) return null;

        const rgFcLcbStart = rgLwEnd + 2;
        const fcClx = readU32(wordDocData, rgFcLcbStart + CLX_INDEX * 8);
        const lcbClx = readU32(wordDocData, rgFcLcbStart + CLX_INDEX * 8 + 4);

        if (lcbClx === 0 || fcClx + lcbClx > tableData.length) return null;

        // Parse the CLX structure (in the Table stream at offset fcClx)
        // CLX = optional Pcr[] + Pcdt
        // Pcdt starts with clxt = 0x02, followed by lcb (4 bytes), then PlcPcd
        let pos = fcClx;
        const clxEnd = fcClx + lcbClx;

        // Skip any Prc entries (clxt = 0x01)
        while (pos < clxEnd && tableData[pos] === 0x01) {
            const cbGrpprl = readU16(tableData, pos + 1);
            pos += 3 + cbGrpprl;
        }

        // Now we should be at Pcdt (clxt = 0x02)
        if (pos >= clxEnd || tableData[pos] !== 0x02) return null;
        pos += 1;

        const lcbPlcPcd = readU32(tableData, pos);
        pos += 4;

        // PlcPcd: array of (n+1) CPs followed by n PCDs
        // Each CP is 4 bytes, each PCD is 8 bytes
        // n = (lcbPlcPcd - 4) / (4 + 8) — but more precisely:
        // (n+1)*4 + n*8 = lcbPlcPcd → n = (lcbPlcPcd - 4) / 12
        const n = Math.floor((lcbPlcPcd - 4) / 12);
        if (n <= 0) return null;

        // Read character positions (CPs)
        const cps = [];
        for (let i = 0; i <= n; i++) {
            cps.push(readU32(tableData, pos + i * 4));
        }

        // Read piece descriptors (PCDs) — each is 8 bytes
        const pcdStart = pos + (n + 1) * 4;
        let text = '';

        for (let i = 0; i < n; i++) {
            const cpLen = cps[i + 1] - cps[i];
            if (cpLen <= 0 || cpLen > 1000000) continue;

            const pcdOffset = pcdStart + i * 8;
            // PCD structure: 2 bytes (attrs) + 4 bytes (fc) + 2 bytes (prm)
            const fcCompressed = readU32(tableData, pcdOffset + 2);

            // Bit 30 of fc indicates compression (ANSI vs Unicode)
            const isAnsi = (fcCompressed & 0x40000000) !== 0;
            // Clear the compression bit to get the actual file offset
            const fc = isAnsi ? (fcCompressed & 0x3FFFFFFF) / 2 : (fcCompressed & 0x3FFFFFFF);

            if (isAnsi) {
                // ANSI: 1 byte per character
                const start = fc;
                for (let j = 0; j < cpLen; j++) {
                    if (start + j >= wordDocData.length) break;
                    const ch = wordDocData[start + j];
                    text += decodeDocChar(ch);
                }
            } else {
                // Unicode: 2 bytes per character
                const start = fc;
                for (let j = 0; j < cpLen; j++) {
                    const bytePos = start + j * 2;
                    if (bytePos + 1 >= wordDocData.length) break;
                    const ch = readU16(wordDocData, bytePos);
                    text += decodeDocChar(ch);
                }
            }
        }

        return cleanDocText(text);
    } catch (e) {
        console.warn('[Docucata:DocText] Piece table extraction failed:', e);
        return null;
    }
}

/**
 * Decode a Word special character code to readable text.
 */
function decodeDocChar(ch) {
    // Word uses special character codes for formatting
    if (ch === 13 || ch === 0x0D) return '\n';   // Paragraph mark
    if (ch === 11 || ch === 0x0B) return '\n';   // Hard line break
    if (ch === 9 || ch === 0x09) return '\t';    // Tab
    if (ch === 12 || ch === 0x0C) return '\n\n'; // Page break
    if (ch === 7) return '\t';                    // Cell mark (table cell)
    if (ch === 8) return '';                      // Delete (drawn object anchor)
    if (ch === 1 || ch === 2) return '';          // Field/footnote markers
    if (ch === 5) return '';                      // Annotation reference
    if (ch === 14 || ch === 15) return '';        // Column/section break markers
    if (ch === 19 || ch === 20 || ch === 21) return ''; // Field begin/separator/end
    if (ch === 30) return '\u00AD';              // Non-breaking hyphen
    if (ch === 31) return '\u00AD';              // Optional hyphen
    if (ch === 160) return '\u00A0';             // Non-breaking space
    if (ch < 32 && ch !== 10) return '';          // Other control chars
    return String.fromCharCode(ch);
}

// ── Fallback: scan for text runs ────────────────────────

function scanForText(wordDocData) {
    // Scan the WordDocument stream for runs of printable characters.
    // Word stores text as either ANSI or UTF-16LE runs.
    // We look for substantial runs of printable chars.

    let text = '';
    let run = '';
    const minRunLength = 8; // minimum chars to consider a run as "text"

    for (let i = 0; i < wordDocData.length; i++) {
        const ch = wordDocData[i];

        if (isPrintable(ch)) {
            run += String.fromCharCode(ch);
        } else if (ch === 0x0D || ch === 0x0A) {
            run += '\n';
        } else if (ch === 0x09) {
            run += '\t';
        } else {
            if (run.length >= minRunLength) {
                text += run;
            }
            run = '';
        }
    }
    if (run.length >= minRunLength) {
        text += run;
    }

    const cleaned = cleanDocText(text);
    return (cleaned && isReadableText(cleaned)) ? cleaned : null;
}

function isPrintable(ch) {
    // Only ASCII printable range for the fallback scanner.
    // High-Latin1 (160–255) is excluded because OLE2 binary structures
    // (FAT chains of 0xFFFFFFFE, directory entries) produce false runs
    // of characters like þ (0xFE) and ÿ (0xFF).
    return ch >= 32 && ch <= 126;
}

/**
 * Clean up extracted text — remove excessive whitespace, control chars.
 */
function cleanDocText(text) {
    if (!text) return '';
    return text
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+$/gm, '')       // trailing whitespace per line
        .trim();
}

/**
 * Quality gate for the fallback scanner — reject text that's mostly non-readable.
 * Only applied to scanForText output, NOT to piece table output (which is structured).
 */
function isReadableText(text) {
    if (!text || text.length === 0) return false;
    let asciiPrintable = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if ((c >= 32 && c <= 126) || c === 10 || c === 9) asciiPrintable++;
    }
    return (asciiPrintable / text.length) >= 0.5;
}

// ── OLE2 infrastructure (duplicated from ole2Parser for independence) ──

function parseHeader(bytes) {
    if (bytes.length < 512) return null;

    const sectorSize = 1 << readU16(bytes, 30);
    const fatSectorCount = readU32(bytes, 44);
    const firstDirSector = readU32(bytes, 48);
    const miniStreamCutoff = readU32(bytes, 56);
    const firstMiniFatSector = readU32(bytes, 60);
    const miniFatSectorCount = readU32(bytes, 64);
    const firstDifatSector = readU32(bytes, 68);
    const difatSectorCount = readU32(bytes, 72);

    const difatEntries = [];
    for (let i = 0; i < 109; i++) {
        const sector = readU32(bytes, 76 + i * 4);
        if (sector === 0xFFFFFFFE || sector === 0xFFFFFFFF) break;
        difatEntries.push(sector);
    }

    return {
        sectorSize, fatSectorCount, firstDirSector, miniStreamCutoff,
        firstMiniFatSector, miniFatSectorCount, firstDifatSector,
        difatSectorCount, difatEntries,
    };
}

function sectorOffset(sectorNum, sectorSize) {
    return (sectorNum + 1) * sectorSize;
}

function buildFAT(bytes, header) {
    const fat = [];
    const entriesPerSector = header.sectorSize / 4;

    for (const fatSector of header.difatEntries) {
        const offset = sectorOffset(fatSector, header.sectorSize);
        if (offset + header.sectorSize > bytes.length) break;
        for (let i = 0; i < entriesPerSector; i++) {
            fat.push(readU32(bytes, offset + i * 4));
        }
    }

    if (header.difatSectorCount > 0 && header.firstDifatSector !== 0xFFFFFFFE) {
        let difatSector = header.firstDifatSector;
        for (let d = 0; d < header.difatSectorCount && difatSector !== 0xFFFFFFFE; d++) {
            const offset = sectorOffset(difatSector, header.sectorSize);
            if (offset + header.sectorSize > bytes.length) break;
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

function followChain(fat, startSector) {
    const chain = [];
    let sector = startSector;
    while (sector !== 0xFFFFFFFE && sector !== 0xFFFFFFFF && sector < fat.length && chain.length < 10000) {
        chain.push(sector);
        sector = fat[sector];
    }
    return chain;
}

function readDirectoryEntries(bytes, header, fat) {
    const chain = followChain(fat, header.firstDirSector);
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
            let name = '';
            for (let j = 0; j < nameLen - 2; j += 2) {
                name += String.fromCharCode(readU16(bytes, entryOffset + j));
            }
            const entryType = bytes[entryOffset + 66];
            const startSector = readU32(bytes, entryOffset + 116);
            const streamSize = readU32(bytes, entryOffset + 120);
            entries.push({ name, entryType, startSector, streamSize });
        }
    }
    return entries;
}

function readStream(bytes, header, fat, entry, miniCtx) {
    if (entry.streamSize === 0) return null;

    // Small streams are stored in the mini stream (64-byte sectors)
    if (entry.streamSize < header.miniStreamCutoff && miniCtx) {
        return readMiniStreamData(miniCtx, entry);
    }

    const chain = followChain(fat, entry.startSector);
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
 * Build the mini FAT and mini stream container for reading small streams.
 */
function buildMiniStreamContext(bytes, header, fat, dirs) {
    // The mini stream is the Root Entry's data
    const rootEntry = dirs.find(e => e.entryType === 5);
    if (!rootEntry || rootEntry.streamSize === 0) return null;

    // Read the mini stream container from regular sectors
    const containerChain = followChain(fat, rootEntry.startSector);
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

    // Build the mini FAT
    const miniFat = [];
    if (header.firstMiniFatSector !== 0xFFFFFFFE) {
        const mfChain = followChain(fat, header.firstMiniFatSector);
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
 * Read a stream from the mini stream using 64-byte mini sectors.
 */
function readMiniStreamData(miniCtx, entry) {
    const MINI_SECTOR_SIZE = 64;
    const chain = followChain(miniCtx.miniFat, entry.startSector);
    if (chain.length === 0) return null;

    const result = new Uint8Array(entry.streamSize);
    let pos = 0;
    for (const sector of chain) {
        const offset = sector * MINI_SECTOR_SIZE;
        if (offset >= miniCtx.container.length) break;
        const available = Math.min(MINI_SECTOR_SIZE, miniCtx.container.length - offset, entry.streamSize - pos);
        if (available <= 0) break;
        result.set(miniCtx.container.subarray(offset, offset + available), pos);
        pos += available;
        if (pos >= entry.streamSize) break;
    }
    return result;
}

function readU16(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}
