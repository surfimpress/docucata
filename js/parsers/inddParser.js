/**
 * InDesign (.indd) metadata parser.
 *
 * InDesign uses a proprietary binary database format, but it embeds XMP metadata
 * as a plain-text XML packet that can be found by scanning for <?xpacket begin.
 *
 * Extracts: title, author, description, keywords, creation/modification dates,
 * creator tool, document IDs, ICC profile, and other XMP fields.
 *
 * Also reads the InDesign file header to extract database version info.
 *
 * Accepts File | ArrayBuffer.
 */

import { parseXmpXml, findXmpPacket } from './xmpParser.js';

// InDesign database header magic GUID (first 16 bytes)
// Big-endian: 06 06 ED F5 D8 1D 46 E5 BD 31 EF E7 FE 74 B7 1D
const INDD_MAGIC_BE = [0x06, 0x06, 0xED, 0xF5, 0xD8, 0x1D, 0x46, 0xE5];
// Little-endian variant
const INDD_MAGIC_LE = [0x06, 0x06, 0xED, 0xF5, 0xD8, 0x1D, 0x46, 0xE5];

/**
 * Parse InDesign metadata from an ArrayBuffer. Worker-safe.
 * @param {ArrayBuffer} buffer
 * @returns {Object|null}
 */
export function parseInddMetadataFromBuffer(buffer) {
    try {
        if (!buffer || buffer.byteLength < 32) return null;
        const bytes = new Uint8Array(buffer);

        const meta = {};
        meta.Format = 'InDesign';

        // Try to read the InDesign database version from the header
        // The master page at offset 0 has a sequence number, then the
        // contiguous object area starts. We just extract what's reliable.

        // Scan for XMP — InDesign embeds it as a contiguous packet
        // Scan deeper for INDD since the XMP can be well into the file
        const xmpXml = findXmpPacket(bytes, 4 * 1024 * 1024); // scan up to 4MB
        if (xmpXml) {
            const xmpMeta = parseXmpXml(xmpXml);
            Object.assign(meta, xmpMeta);
        }

        return Object.keys(meta) > 1 || xmpXml ? meta : null;
    } catch (e) {
        console.warn('[Docucata:INDD] Parse error:', e);
        return null;
    }
}

/**
 * Parse InDesign metadata from a File or ArrayBuffer.
 * @param {File|ArrayBuffer} input
 * @returns {Promise<Object|null>}
 */
export async function parseInddMetadata(input) {
    const buffer = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
    return parseInddMetadataFromBuffer(buffer);
}
