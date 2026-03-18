/**
 * PSD (Adobe Photoshop) metadata parser.
 *
 * Extracts from the binary format:
 *   - File header (26 bytes): dimensions, channels, bit depth, color mode
 *   - Image Resource Blocks: XMP (0x0424), IPTC (0x0404), resolution (0x03ED),
 *     ICC profile name (0x040F), print flags, slices, etc.
 *
 * References:
 *   - Adobe Photoshop File Formats Specification (2019)
 *   - Section: File Header, Image Resources
 *
 * Accepts File | ArrayBuffer.
 */

import { parseXmpXml, findXmpPacket } from './xmpParser.js';

const COLOR_MODES = [
    'Bitmap', 'Grayscale', 'Indexed', 'RGB', 'CMYK',
    'Multichannel', 'Duotone', 'Lab'  // 5 is unused, mapped to Multichannel at index 7→6
];

// Remap: PSD color mode values 0–4 map directly; 7=Multichannel, 8=Duotone, 9=Lab
function colorModeName(val) {
    const map = { 0: 'Bitmap', 1: 'Grayscale', 2: 'Indexed', 3: 'RGB', 4: 'CMYK',
                  7: 'Multichannel', 8: 'Duotone', 9: 'Lab' };
    return map[val] || `Unknown (${val})`;
}

/**
 * Parse PSD metadata from an ArrayBuffer. Worker-safe.
 * @param {ArrayBuffer} buffer
 * @returns {Object|null}
 */
export function parsePsdMetadataFromBuffer(buffer) {
    try {
        if (!buffer || buffer.byteLength < 26) return null;
        const bytes = new Uint8Array(buffer);
        const view = new DataView(buffer);

        // Verify magic: 8BPS
        if (bytes[0] !== 0x38 || bytes[1] !== 0x42 ||
            bytes[2] !== 0x50 || bytes[3] !== 0x53) return null;

        const meta = {};

        // File header
        const version = view.getUint16(4);
        meta.Format = version === 2 ? 'PSB' : 'PSD'; // PSB = large document format
        meta.Channels = view.getUint16(12);
        meta.Height = view.getUint32(14);
        meta.Width = view.getUint32(18);
        meta.BitDepth = view.getUint16(22);
        meta.ColorMode = colorModeName(view.getUint16(24));

        // Skip color mode data section
        let offset = 26;
        if (offset + 4 > buffer.byteLength) return meta;
        const colorDataLen = view.getUint32(offset);
        offset += 4 + colorDataLen;

        // Image Resource section
        if (offset + 4 > buffer.byteLength) return meta;
        const resLen = view.getUint32(offset);
        offset += 4;
        const resEnd = offset + resLen;

        while (offset + 12 <= resEnd && offset + 12 <= buffer.byteLength) {
            // Each resource: signature(4) + id(2) + pascal string + size(4) + data
            // Signature: 8BIM
            if (bytes[offset] !== 0x38 || bytes[offset + 1] !== 0x42 ||
                bytes[offset + 2] !== 0x49 || bytes[offset + 3] !== 0x4D) break;

            const resId = view.getUint16(offset + 4);

            // Pascal string (name): length byte + chars, padded to even
            const nameLen = bytes[offset + 6];
            const namePadded = nameLen === 0 ? 2 : (nameLen % 2 === 0 ? nameLen + 2 : nameLen + 1);
            const dataSizeOff = offset + 6 + namePadded;
            if (dataSizeOff + 4 > buffer.byteLength) break;

            const dataSize = view.getUint32(dataSizeOff);
            const dataOff = dataSizeOff + 4;
            if (dataOff + dataSize > buffer.byteLength) break;

            // Resolution (0x03ED)
            if (resId === 0x03ED && dataSize >= 16) {
                const hRes = view.getUint16(dataOff); // fixed-point 16.16, integer part
                const vRes = view.getUint16(dataOff + 8);
                meta.HorizontalResolution = hRes;
                meta.VerticalResolution = vRes;
            }

            // IPTC-NAA (0x0404)
            if (resId === 0x0404 && dataSize > 0) {
                const iptc = parseIptc(bytes, dataOff, dataSize);
                Object.assign(meta, iptc);
            }

            // XMP (0x0424)
            if (resId === 0x0424 && dataSize > 0) {
                try {
                    const xml = new TextDecoder('utf-8').decode(bytes.slice(dataOff, dataOff + dataSize));
                    const xmpMeta = parseXmpXml(xml);
                    Object.assign(meta, xmpMeta);
                } catch { /* ignore decode errors */ }
            }

            // ICC Profile name (0x040F)
            if (resId === 0x040F && dataSize > 0) {
                try {
                    const name = new TextDecoder('utf-8').decode(bytes.slice(dataOff, dataOff + dataSize));
                    if (name.trim()) meta.ICCProfile = name.trim();
                } catch { /* ignore */ }
            }

            // Next resource (data padded to even length)
            offset = dataOff + dataSize + (dataSize % 2);
        }

        return Object.keys(meta).length > 0 ? meta : null;
    } catch (e) {
        console.warn('[Docucata:PSD] Parse error:', e);
        return null;
    }
}

/**
 * Parse IPTC-NAA record from bytes.
 * Looks for 2:xxx datasets (Application Record).
 */
function parseIptc(bytes, offset, length) {
    const meta = {};
    const end = offset + length;
    const decoder = new TextDecoder('utf-8');

    while (offset + 5 <= end) {
        if (bytes[offset] !== 0x1C) break; // tag marker
        const recordNum = bytes[offset + 1];
        const datasetNum = bytes[offset + 2];
        const dataLen = (bytes[offset + 3] << 8) | bytes[offset + 4];
        offset += 5;
        if (offset + dataLen > end) break;

        if (recordNum === 2) {
            const val = decoder.decode(bytes.slice(offset, offset + dataLen));
            switch (datasetNum) {
                case 5:   meta.IptcTitle = val; break;
                case 25:  // Keywords — can appear multiple times
                    meta.IptcKeywords = meta.IptcKeywords ? meta.IptcKeywords + ', ' + val : val;
                    break;
                case 80:  meta.IptcAuthor = val; break;
                case 116: meta.IptcCopyright = val; break;
                case 120: meta.IptcDescription = val; break;
                case 55:  meta.IptcDateCreated = val; break;
            }
        }
        offset += dataLen;
    }
    return meta;
}

/**
 * Parse PSD metadata from a File or ArrayBuffer.
 * @param {File|ArrayBuffer} input
 * @returns {Promise<Object|null>}
 */
export async function parsePsdMetadata(input) {
    const buffer = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
    return parsePsdMetadataFromBuffer(buffer);
}
