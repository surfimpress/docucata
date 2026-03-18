/**
 * Video metadata parser — ISO BMFF containers (MP4, MOV, M4V).
 *
 * Parses the box structure to extract:
 *   - Duration, dimensions, rotation (from moov/mvhd + trak/tkhd)
 *   - Codec identification (from stsd)
 *   - Creation date (Mac epoch → ISO 8601)
 *   - Major brand / format identification (from ftyp)
 *
 * Accepts File | ArrayBuffer.
 */

// Seconds between 1904-01-01 and 1970-01-01
const MAC_EPOCH_OFFSET = 2082844800;

const CONTAINER_BOXES = new Set([
    'moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts'
]);

// ── Box reading helpers ─────────────────────────────────

function readBoxHeader(view, offset) {
    if (offset + 8 > view.byteLength) return null;
    let size = view.getUint32(offset);
    const type = String.fromCharCode(
        view.getUint8(offset + 4), view.getUint8(offset + 5),
        view.getUint8(offset + 6), view.getUint8(offset + 7)
    );
    let headerLen = 8;
    if (size === 1 && offset + 16 <= view.byteLength) {
        // 64-bit extended size
        const hi = view.getUint32(offset + 8);
        const lo = view.getUint32(offset + 12);
        size = hi * 0x100000000 + lo;
        headerLen = 16;
    } else if (size === 0) {
        // Box extends to end of file
        size = view.byteLength - offset;
    }
    if (size < headerLen) return null;
    return { size, type, headerLen };
}

function readString(view, offset, length) {
    let s = '';
    for (let i = 0; i < length && offset + i < view.byteLength; i++) {
        s += String.fromCharCode(view.getUint8(offset + i));
    }
    return s;
}

function macDateToISO(seconds) {
    if (!seconds || seconds < MAC_EPOCH_OFFSET) return null;
    return new Date((seconds - MAC_EPOCH_OFFSET) * 1000).toISOString();
}

function formatDuration(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Box walker ──────────────────────────────────────────

/**
 * Recursively walk ISO BMFF boxes and invoke handler for each.
 * Container boxes are descended into automatically.
 */
function walkBoxes(view, start, end, handler) {
    let offset = start;
    while (offset < end) {
        const box = readBoxHeader(view, offset);
        if (!box) break;

        const boxEnd = offset + box.size;
        if (boxEnd > end) break;

        handler(box.type, offset + box.headerLen, boxEnd, view);

        if (CONTAINER_BOXES.has(box.type)) {
            walkBoxes(view, offset + box.headerLen, boxEnd, handler);
        }

        offset = boxEnd;
    }
}

// ── ISO BMFF parser ─────────────────────────────────────

function parseISOBMFF(view) {
    const meta = {};
    const tracks = [];
    let currentTrack = null;

    walkBoxes(view, 0, view.byteLength, (type, dataStart, boxEnd) => {
        try {
            if (type === 'ftyp') {
                meta.MajorBrand = readString(view, dataStart, 4).trim();
                const brandMap = {
                    'isom': 'MP4', 'iso2': 'MP4', 'mp41': 'MP4', 'mp42': 'MP4',
                    'avc1': 'MP4', 'M4V ': 'M4V', 'M4VH': 'M4V', 'M4VP': 'M4V',
                    'qt  ': 'MOV', 'MSNV': 'MP4', 'mp71': 'MP4',
                };
                meta.Format = brandMap[meta.MajorBrand] || 'MP4';
            }

            if (type === 'mvhd') {
                const version = view.getUint8(dataStart);
                if (version === 0 && dataStart + 24 <= boxEnd) {
                    const created = view.getUint32(dataStart + 4);
                    const timescale = view.getUint32(dataStart + 12);
                    const duration = view.getUint32(dataStart + 16);
                    if (created) meta.CreationDate = macDateToISO(created);
                    if (timescale && duration) {
                        meta.DurationSeconds = +(duration / timescale).toFixed(2);
                        meta.Duration = formatDuration(meta.DurationSeconds);
                    }
                    meta.Timescale = timescale;
                } else if (version === 1 && dataStart + 36 <= boxEnd) {
                    const createdHi = view.getUint32(dataStart + 4);
                    const createdLo = view.getUint32(dataStart + 8);
                    const created = createdHi * 0x100000000 + createdLo;
                    const timescale = view.getUint32(dataStart + 20);
                    const durHi = view.getUint32(dataStart + 24);
                    const durLo = view.getUint32(dataStart + 28);
                    const duration = durHi * 0x100000000 + durLo;
                    if (created) meta.CreationDate = macDateToISO(created);
                    if (timescale && duration) {
                        meta.DurationSeconds = +(duration / timescale).toFixed(2);
                        meta.Duration = formatDuration(meta.DurationSeconds);
                    }
                    meta.Timescale = timescale;
                }
            }

            if (type === 'trak') {
                currentTrack = {};
                tracks.push(currentTrack);
            }

            if (type === 'tkhd' && currentTrack) {
                const version = view.getUint8(dataStart);
                let off = dataStart + 4; // skip version + flags
                if (version === 1) off += 16; // created(8) + modified(8)
                else off += 8;                 // created(4) + modified(4)
                off += 8; // trackID(4) + reserved(4)

                // Duration follows but we use mvhd duration instead
                if (version === 1) off += 8; else off += 4;
                off += 8; // reserved(8)

                // Layer(2) + alternateGroup(2) + volume(2) + reserved(2)
                off += 8;

                // Transformation matrix: 9 × int32 fixed-point (36 bytes)
                const matrixOff = off;
                if (matrixOff + 36 <= boxEnd) {
                    const a = view.getInt32(matrixOff) / 65536;
                    const b = view.getInt32(matrixOff + 4) / 65536;
                    const rotation = Math.round(Math.atan2(b, a) * (180 / Math.PI));
                    if (rotation !== 0) currentTrack.rotation = rotation;
                }
                off += 36;

                // Width and height: fixed-point 16.16
                if (off + 8 <= boxEnd) {
                    const w = view.getUint32(off) / 65536;
                    const h = view.getUint32(off + 4) / 65536;
                    if (w > 0 && h > 0) {
                        currentTrack.width = Math.round(w);
                        currentTrack.height = Math.round(h);
                    }
                }
            }

            if (type === 'hdlr' && currentTrack && dataStart + 12 <= boxEnd) {
                currentTrack.handlerType = readString(view, dataStart + 8, 4);
            }

            if (type === 'stsd' && currentTrack && dataStart + 16 <= boxEnd) {
                // version(1) + flags(3) + entryCount(4) = 8, then first entry: size(4) + codec(4)
                const codec = readString(view, dataStart + 12, 4);
                if (codec && codec.trim()) currentTrack.codec = codec.trim();
            }
        } catch {
            // Tolerate corrupted boxes — extract whatever we can
        }
    });

    // Merge track info into meta
    meta.TrackCount = tracks.length;
    for (const t of tracks) {
        if (t.handlerType === 'vide') {
            if (t.width) meta.Width = t.width;
            if (t.height) meta.Height = t.height;
            if (t.rotation) meta.Rotation = t.rotation + '°';
            if (t.codec) meta.VideoCodec = t.codec;
        } else if (t.handlerType === 'soun') {
            if (t.codec) meta.AudioCodec = t.codec;
        }
    }

    return Object.keys(meta).length > 0 ? meta : null;
}

// ── Public API ──────────────────────────────────────────

/**
 * Parse video metadata from an ArrayBuffer. Worker-safe.
 * @param {ArrayBuffer} buffer
 * @returns {Object|null}
 */
export function parseVideoMetadataFromBuffer(buffer) {
    try {
        if (!buffer || buffer.byteLength < 12) return null;
        const view = new DataView(buffer);
        // Verify ftyp signature at bytes 4-7
        const ftyp = String.fromCharCode(
            view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7)
        );
        if (ftyp !== 'ftyp') return null;
        return parseISOBMFF(view);
    } catch (e) {
        console.warn('[Docucata:Video] Parse error:', e);
        return null;
    }
}

/**
 * Parse video metadata from a File or ArrayBuffer.
 * @param {File|ArrayBuffer} input
 * @returns {Promise<Object|null>}
 */
export async function parseVideoMetadata(input) {
    const buffer = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
    return parseVideoMetadataFromBuffer(buffer);
}
