/**
 * Extract metadata from audio files.
 * Supports: MP3 (ID3v1 + ID3v2), WAV (RIFF header), FLAC (Vorbis comments),
 * OGG (Vorbis comments), M4A/AAC (basic), AIFF.
 *
 * Uses the browser's AudioContext for universal duration/channel detection,
 * plus format-specific binary parsing for tags.
 *
 * @param {File} file
 * @returns {Promise<Object|null>}
 */
export async function parseAudioMetadata(file) {
    try {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const ext = file.name.split('.').pop()?.toLowerCase();

        const info = {};

        // Format-specific tag parsing
        if (ext === 'mp3' || isMp3(bytes)) {
            Object.assign(info, parseId3v2(bytes));
            Object.assign(info, parseId3v1(bytes)); // ID3v1 fills gaps
            const mp3Info = parseMp3Frame(bytes);
            if (mp3Info) Object.assign(info, mp3Info);
        } else if (ext === 'wav' || ext === 'wave') {
            Object.assign(info, parseWav(bytes));
        } else if (ext === 'flac') {
            Object.assign(info, parseFlac(bytes));
        } else if (ext === 'ogg' || ext === 'oga') {
            Object.assign(info, parseOgg(bytes));
        } else if (ext === 'aif' || ext === 'aiff') {
            Object.assign(info, parseAiff(bytes));
        }

        // Use Web Audio API for duration and basic info (works for any format the browser supports)
        try {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const audioBuffer = await audioCtx.decodeAudioData(buffer.slice(0));
            if (!info.duration) {
                const secs = audioBuffer.duration;
                const mins = Math.floor(secs / 60);
                const remainSecs = Math.floor(secs % 60);
                info.duration = `${mins}:${remainSecs.toString().padStart(2, '0')}`;
                info.durationSeconds = Math.round(secs * 100) / 100;
            }
            if (!info.sampleRate) info.sampleRate = audioBuffer.sampleRate;
            if (!info.channels) info.channels = audioBuffer.numberOfChannels;
            audioCtx.close();
        } catch (audioErr) {
            // Browser may not support this format for decoding — that's OK
            console.debug('[Docucata:Audio] Web Audio decode failed:', audioErr.message);
        }

        // Estimate bitrate from file size and duration
        if (info.durationSeconds && info.durationSeconds > 0 && !info.bitrate) {
            const kbps = Math.round((file.size * 8) / (info.durationSeconds * 1000));
            info.bitrate = `${kbps} kbps`;
        }

        if (Object.keys(info).length === 0) return null;

        info.format = ext?.toUpperCase();

        console.group(`[Docucata:Audio] ${file.name}`);
        console.log('Audio metadata:', info);
        console.groupEnd();

        return info;
    } catch (e) {
        console.warn(`[Docucata:Audio] Failed to parse ${file.name}:`, e);
        return null;
    }
}

// ── MP3 ID3v2 ──────────────────────────────────────────

function isMp3(bytes) {
    // ID3v2 header or MP3 sync word
    return (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
           (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0);
}

function parseId3v2(bytes) {
    const info = {};

    // Check for ID3v2 header: "ID3"
    if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return info;

    const version = bytes[3];
    info.id3Version = `ID3v2.${version}`;

    // Size is syncsafe integer (4 bytes, 7 bits each)
    const size = (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
    const headerSize = 10;
    const end = Math.min(headerSize + size, bytes.length);

    // Frame ID map
    const frameMap = {
        'TIT2': 'title', 'TPE1': 'artist', 'TALB': 'album',
        'TRCK': 'track', 'TYER': 'year', 'TDRC': 'year',
        'TCON': 'genre', 'TCOM': 'composer', 'TPE2': 'albumArtist',
        'TPOS': 'discNumber', 'TBPM': 'bpm', 'TPUB': 'publisher',
        'TCOP': 'copyright', 'TENC': 'encodedBy', 'TSSE': 'encoderSettings',
        'TLAN': 'language', 'TKEY': 'initialKey', 'TSRC': 'isrc',
        'TPE3': 'conductor', 'TEXT': 'lyricist', 'TOPE': 'originalArtist',
        'TOAL': 'originalAlbum', 'TDOR': 'originalReleaseDate',
        'COMM': 'comment', 'USLT': 'lyrics',
    };

    let pos = headerSize;

    // Skip extended header if present
    if (bytes[5] & 0x40) {
        const extSize = version >= 4
            ? ((bytes[pos] << 21) | (bytes[pos+1] << 14) | (bytes[pos+2] << 7) | bytes[pos+3])
            : ((bytes[pos] << 24) | (bytes[pos+1] << 16) | (bytes[pos+2] << 8) | bytes[pos+3]) + 4;
        pos += extSize;
    }

    while (pos + 10 < end) {
        const frameId = String.fromCharCode(bytes[pos], bytes[pos+1], bytes[pos+2], bytes[pos+3]);

        // Stop at padding
        if (frameId === '\0\0\0\0') break;

        let frameSize;
        if (version >= 4) {
            // Syncsafe in v2.4
            frameSize = (bytes[pos+4] << 21) | (bytes[pos+5] << 14) | (bytes[pos+6] << 7) | bytes[pos+7];
        } else {
            frameSize = (bytes[pos+4] << 24) | (bytes[pos+5] << 16) | (bytes[pos+6] << 8) | bytes[pos+7];
        }

        const frameFlags = (bytes[pos+8] << 8) | bytes[pos+9];
        pos += 10;

        if (frameSize <= 0 || pos + frameSize > end) break;

        const field = frameMap[frameId];
        if (field && !info[field]) {
            const frameData = bytes.subarray(pos, pos + frameSize);

            if (frameId === 'COMM' || frameId === 'USLT') {
                // Comment/Lyrics: encoding(1) + language(3) + description(null-term) + text
                info[field] = decodeId3Text(frameData, true);
            } else if (frameId.startsWith('T')) {
                // Text frame: encoding(1) + text
                info[field] = decodeId3Text(frameData, false);
            }
        }

        // Check for APIC (album art) — just note its presence
        if (frameId === 'APIC') {
            info.hasAlbumArt = true;
        }

        pos += frameSize;
    }

    // Clean up genre — ID3v1 genre numbers in parentheses like "(17)"
    if (info.genre) {
        const genreMatch = info.genre.match(/^\((\d+)\)(.*)$/);
        if (genreMatch) {
            const name = ID3V1_GENRES[parseInt(genreMatch[1])] || genreMatch[1];
            info.genre = genreMatch[2] ? `${genreMatch[2]} (${name})` : name;
        }
    }

    return info;
}

function decodeId3Text(data, hasDescription) {
    if (data.length < 2) return '';
    const encoding = data[0];
    let offset = 1;

    if (hasDescription) {
        // Skip language code (3 bytes)
        offset += 3;
        // Skip description (null-terminated)
        if (encoding === 0 || encoding === 3) {
            while (offset < data.length && data[offset] !== 0) offset++;
            offset++; // skip null
        } else {
            while (offset + 1 < data.length && !(data[offset] === 0 && data[offset+1] === 0)) offset += 2;
            offset += 2; // skip double null
        }
    }

    const textBytes = data.subarray(offset);

    if (encoding === 0) {
        // ISO-8859-1
        return Array.from(textBytes).filter(b => b !== 0).map(b => String.fromCharCode(b)).join('');
    } else if (encoding === 1) {
        // UTF-16 with BOM
        return decodeUtf16(textBytes);
    } else if (encoding === 2) {
        // UTF-16BE without BOM
        return decodeUtf16BE(textBytes);
    } else {
        // UTF-8
        return new TextDecoder('utf-8').decode(textBytes).replace(/\0+$/, '');
    }
}

function decodeUtf16(bytes) {
    if (bytes.length < 2) return '';
    const bom = (bytes[0] << 8) | bytes[1];
    const isLE = bom === 0xFFFE;
    const start = (bom === 0xFEFF || bom === 0xFFFE) ? 2 : 0;
    let str = '';
    for (let i = start; i + 1 < bytes.length; i += 2) {
        const code = isLE ? (bytes[i] | (bytes[i+1] << 8)) : ((bytes[i] << 8) | bytes[i+1]);
        if (code === 0) break;
        str += String.fromCharCode(code);
    }
    return str;
}

function decodeUtf16BE(bytes) {
    let str = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) {
        const code = (bytes[i] << 8) | bytes[i+1];
        if (code === 0) break;
        str += String.fromCharCode(code);
    }
    return str;
}

// ── MP3 Frame Header ───────────────────────────────────

function parseMp3Frame(bytes) {
    // Find first sync word (0xFFE0)
    let pos = 0;

    // Skip ID3v2 tag
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
        const size = (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
        pos = 10 + size;
    }

    while (pos + 4 < bytes.length) {
        if (bytes[pos] === 0xFF && (bytes[pos+1] & 0xE0) === 0xE0) {
            const b1 = bytes[pos+1];
            const b2 = bytes[pos+2];

            const versionBits = (b1 >> 3) & 3;
            const layerBits = (b1 >> 1) & 3;
            const bitrateBits = (b2 >> 4) & 0xF;
            const sampleBits = (b2 >> 2) & 3;
            const channelBits = (bytes[pos+3] >> 6) & 3;

            const version = [2.5, null, 2, 1][versionBits];
            const layer = [null, 3, 2, 1][layerBits];

            if (!version || !layer || bitrateBits === 0xF || sampleBits === 3) {
                pos++;
                continue;
            }

            const info = {};
            info.mpegVersion = `MPEG${version === 1 ? '1' : version === 2 ? '2' : '2.5'}`;
            info.layer = `Layer ${['', 'I', 'II', 'III'][layer]}`;
            info.channelMode = ['Stereo', 'Joint Stereo', 'Dual Channel', 'Mono'][channelBits];

            // Bitrate tables (kbps)
            const bitrateTable = {
                '1-1': [0,32,64,96,128,160,192,224,256,288,320,352,384,416,448],
                '1-2': [0,32,48,56,64,80,96,112,128,160,192,224,256,320,384],
                '1-3': [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320],
                '2-1': [0,32,48,56,64,80,96,112,128,144,160,176,192,224,256],
                '2-2': [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160],
                '2-3': [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160],
            };

            const vKey = version === 1 ? '1' : '2';
            const table = bitrateTable[`${vKey}-${layer}`];
            if (table && table[bitrateBits]) {
                info.bitrate = `${table[bitrateBits]} kbps`;
            }

            // Sample rate tables
            const sampleTable = {
                1: [44100, 48000, 32000],
                2: [22050, 24000, 16000],
                2.5: [11025, 12000, 8000],
            };
            if (sampleTable[version]) {
                info.sampleRate = sampleTable[version][sampleBits];
            }

            return info;
        }
        pos++;
    }
    return null;
}

// ── ID3v1 (last 128 bytes of MP3) ─────────────────────

function parseId3v1(bytes) {
    const info = {};
    if (bytes.length < 128) return info;

    const offset = bytes.length - 128;
    if (bytes[offset] !== 0x54 || bytes[offset+1] !== 0x41 || bytes[offset+2] !== 0x47) return info; // "TAG"

    const read = (start, len) => {
        const slice = bytes.subarray(offset + start, offset + start + len);
        return Array.from(slice).filter(b => b !== 0).map(b => String.fromCharCode(b)).join('').trim();
    };

    const title = read(3, 30);
    const artist = read(33, 30);
    const album = read(63, 30);
    const year = read(93, 4);
    const comment = read(97, 30);
    const genreIdx = bytes[offset + 127];

    // Only fill gaps — ID3v2 takes priority
    if (title && !info.title) info.title = title;
    if (artist && !info.artist) info.artist = artist;
    if (album && !info.album) info.album = album;
    if (year && !info.year) info.year = year;
    if (comment && !info.comment) info.comment = comment;
    if (genreIdx < ID3V1_GENRES.length && !info.genre) {
        info.genre = ID3V1_GENRES[genreIdx];
    }

    // ID3v1.1: track number in byte 126 if byte 125 is null
    if (bytes[offset + 125] === 0 && bytes[offset + 126] !== 0) {
        info.track = String(bytes[offset + 126]);
    }

    return info;
}

// ── WAV ────────────────────────────────────────────────

function parseWav(bytes) {
    const info = {};

    // RIFF header check
    if (bytes.length < 44) return info;
    const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    const wave = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (riff !== 'RIFF' || wave !== 'WAVE') return info;

    info.format = 'WAV';

    // Find fmt chunk
    let pos = 12;
    while (pos + 8 < bytes.length) {
        const chunkId = String.fromCharCode(bytes[pos], bytes[pos+1], bytes[pos+2], bytes[pos+3]);
        const chunkSize = readU32LE(bytes, pos + 4);

        if (chunkId === 'fmt ') {
            const audioFormat = readU16LE(bytes, pos + 8);
            info.audioFormat = audioFormat === 1 ? 'PCM' : audioFormat === 3 ? 'IEEE Float' :
                              audioFormat === 6 ? 'A-law' : audioFormat === 7 ? 'µ-law' : `Format ${audioFormat}`;
            info.channels = readU16LE(bytes, pos + 10);
            info.sampleRate = readU32LE(bytes, pos + 12);
            info.byteRate = readU32LE(bytes, pos + 16);
            info.bitsPerSample = readU16LE(bytes, pos + 22);
            info.bitrate = `${Math.round(info.byteRate * 8 / 1000)} kbps`;
        }

        if (chunkId === 'data') {
            // Calculate duration from data size
            if (info.byteRate && info.byteRate > 0) {
                const secs = chunkSize / info.byteRate;
                const mins = Math.floor(secs / 60);
                const remainSecs = Math.floor(secs % 60);
                info.duration = `${mins}:${remainSecs.toString().padStart(2, '0')}`;
                info.durationSeconds = Math.round(secs * 100) / 100;
            }
        }

        // LIST-INFO chunk for metadata
        if (chunkId === 'LIST') {
            const listType = String.fromCharCode(bytes[pos+8], bytes[pos+9], bytes[pos+10], bytes[pos+11]);
            if (listType === 'INFO') {
                parseRiffInfo(bytes, pos + 12, pos + 8 + chunkSize, info);
            }
        }

        pos += 8 + chunkSize;
        if (chunkSize % 2 !== 0) pos++; // pad byte
    }

    delete info.byteRate; // internal use only
    return info;
}

function parseRiffInfo(bytes, start, end, info) {
    const riffMap = {
        'IART': 'artist', 'INAM': 'title', 'IPRD': 'album',
        'ICRD': 'year', 'IGNR': 'genre', 'ICMT': 'comment',
        'ISFT': 'software', 'IENG': 'engineer', 'ITCH': 'technician',
        'ICOP': 'copyright', 'ISBJ': 'subject', 'ISRC': 'source',
    };

    let pos = start;
    while (pos + 8 < end) {
        const id = String.fromCharCode(bytes[pos], bytes[pos+1], bytes[pos+2], bytes[pos+3]);
        const size = readU32LE(bytes, pos + 4);
        pos += 8;

        if (riffMap[id] && size > 0 && size < 4096 && pos + size <= end) {
            const val = new TextDecoder('latin1').decode(bytes.subarray(pos, pos + size)).replace(/\0+$/, '').trim();
            if (val) info[riffMap[id]] = val;
        }

        pos += size;
        if (size % 2 !== 0) pos++;
    }
}

// ── FLAC ───────────────────────────────────────────────

function parseFlac(bytes) {
    const info = {};

    if (bytes.length < 42) return info;
    const sig = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (sig !== 'fLaC') return info;

    info.format = 'FLAC';

    let pos = 4;

    while (pos + 4 < bytes.length) {
        const isLast = (bytes[pos] & 0x80) !== 0;
        const blockType = bytes[pos] & 0x7F;
        const blockSize = (bytes[pos+1] << 16) | (bytes[pos+2] << 8) | bytes[pos+3];
        pos += 4;

        if (blockType === 0 && blockSize >= 34) {
            // STREAMINFO
            const minBlockSize = (bytes[pos] << 8) | bytes[pos+1];
            const maxBlockSize = (bytes[pos+2] << 8) | bytes[pos+3];
            info.sampleRate = (bytes[pos+10] << 12) | (bytes[pos+11] << 4) | (bytes[pos+12] >> 4);
            info.channels = ((bytes[pos+12] >> 1) & 7) + 1;
            info.bitsPerSample = ((bytes[pos+12] & 1) << 4) | (bytes[pos+13] >> 4) + 1;

            // Total samples: 36 bits
            const totalSamples = ((bytes[pos+13] & 0xF) * 0x100000000) +
                (bytes[pos+14] << 24) + (bytes[pos+15] << 16) + (bytes[pos+16] << 8) + bytes[pos+17];

            if (info.sampleRate > 0 && totalSamples > 0) {
                const secs = totalSamples / info.sampleRate;
                const mins = Math.floor(secs / 60);
                const remainSecs = Math.floor(secs % 60);
                info.duration = `${mins}:${remainSecs.toString().padStart(2, '0')}`;
                info.durationSeconds = Math.round(secs * 100) / 100;
            }
        }

        if (blockType === 4) {
            // VORBIS_COMMENT
            Object.assign(info, parseVorbisComment(bytes, pos, pos + blockSize));
        }

        if (blockType === 6) {
            // PICTURE
            info.hasAlbumArt = true;
        }

        pos += blockSize;
        if (isLast) break;
    }

    return info;
}

// ── OGG Vorbis ─────────────────────────────────────────

function parseOgg(bytes) {
    const info = {};

    // OGG page header: "OggS"
    if (bytes.length < 58) return info;
    if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'OggS') return info;

    info.format = 'OGG Vorbis';

    // Look for Vorbis identification header
    // First page's first segment should contain "\x01vorbis"
    let pos = 0;
    while (pos + 27 < bytes.length) {
        if (bytes[pos] !== 0x4F || bytes[pos+1] !== 0x67 || bytes[pos+2] !== 0x67 || bytes[pos+3] !== 0x53) break;

        const segments = bytes[pos + 26];
        let dataStart = pos + 27 + segments;
        let dataSize = 0;
        for (let s = 0; s < segments; s++) {
            dataSize += bytes[pos + 27 + s];
        }

        const pageData = bytes.subarray(dataStart, dataStart + dataSize);

        // Vorbis identification header: \x01vorbis
        if (pageData.length > 30 && pageData[0] === 1 &&
            String.fromCharCode(pageData[1], pageData[2], pageData[3], pageData[4], pageData[5], pageData[6]) === 'vorbis') {
            info.channels = pageData[11];
            info.sampleRate = readU32LE(pageData, 12);
            const bitrateMax = readU32LE(pageData, 16);
            const bitrateNom = readU32LE(pageData, 20);
            const bitrateMin = readU32LE(pageData, 24);
            if (bitrateNom > 0) info.bitrate = `${Math.round(bitrateNom / 1000)} kbps`;
        }

        // Vorbis comment header: \x03vorbis
        if (pageData.length > 7 && pageData[0] === 3 &&
            String.fromCharCode(pageData[1], pageData[2], pageData[3], pageData[4], pageData[5], pageData[6]) === 'vorbis') {
            Object.assign(info, parseVorbisComment(pageData, 7, pageData.length));
        }

        pos = dataStart + dataSize;
    }

    return info;
}

// ── AIFF ───────────────────────────────────────────────

function parseAiff(bytes) {
    const info = {};

    if (bytes.length < 12) return info;
    const form = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    const aiff = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (form !== 'FORM' || (aiff !== 'AIFF' && aiff !== 'AIFC')) return info;

    info.format = aiff === 'AIFC' ? 'AIFF-C' : 'AIFF';

    let pos = 12;
    while (pos + 8 < bytes.length) {
        const chunkId = String.fromCharCode(bytes[pos], bytes[pos+1], bytes[pos+2], bytes[pos+3]);
        const chunkSize = (bytes[pos+4] << 24) | (bytes[pos+5] << 16) | (bytes[pos+6] << 8) | bytes[pos+7];
        pos += 8;

        if (chunkId === 'COMM') {
            info.channels = (bytes[pos] << 8) | bytes[pos+1];
            const numFrames = (bytes[pos+2] << 24) | (bytes[pos+3] << 16) | (bytes[pos+4] << 8) | bytes[pos+5];
            info.bitsPerSample = (bytes[pos+6] << 8) | bytes[pos+7];
            // Sample rate is 80-bit IEEE 754 extended — parse simply
            const sr = parseIeee80(bytes, pos + 8);
            if (sr > 0) {
                info.sampleRate = sr;
                if (numFrames > 0) {
                    const secs = numFrames / sr;
                    const mins = Math.floor(secs / 60);
                    const remainSecs = Math.floor(secs % 60);
                    info.duration = `${mins}:${remainSecs.toString().padStart(2, '0')}`;
                    info.durationSeconds = Math.round(secs * 100) / 100;
                }
            }
        }

        pos += chunkSize;
        if (chunkSize % 2 !== 0) pos++;
    }

    return info;
}

/**
 * Parse IEEE 754 80-bit extended precision float (used in AIFF for sample rate).
 */
function parseIeee80(bytes, offset) {
    const exponent = ((bytes[offset] & 0x7F) << 8) | bytes[offset + 1];
    let mantissa = 0;
    for (let i = 0; i < 8; i++) {
        mantissa = mantissa * 256 + bytes[offset + 2 + i];
    }
    const sign = bytes[offset] & 0x80 ? -1 : 1;
    if (exponent === 0 && mantissa === 0) return 0;
    return sign * Math.pow(2, exponent - 16383 - 63) * mantissa;
}

// ── Vorbis Comment (shared by FLAC and OGG) ───────────

function parseVorbisComment(bytes, start, end) {
    const info = {};

    try {
        let pos = start;
        if (pos + 4 > end) return info;

        // Vendor string
        const vendorLen = readU32LE(bytes, pos);
        pos += 4;
        if (vendorLen > 0 && vendorLen < 4096 && pos + vendorLen <= end) {
            info.encoder = new TextDecoder('utf-8').decode(bytes.subarray(pos, pos + vendorLen));
        }
        pos += vendorLen;

        // Comment count
        if (pos + 4 > end) return info;
        const commentCount = readU32LE(bytes, pos);
        pos += 4;

        const vorbisMap = {
            'title': 'title', 'artist': 'artist', 'album': 'album',
            'date': 'year', 'tracknumber': 'track', 'genre': 'genre',
            'comment': 'comment', 'albumartist': 'albumArtist',
            'composer': 'composer', 'performer': 'performer',
            'discnumber': 'discNumber', 'bpm': 'bpm',
            'copyright': 'copyright', 'license': 'license',
            'organization': 'organization', 'description': 'description',
            'location': 'location', 'contact': 'contact',
            'isrc': 'isrc', 'lyrics': 'lyrics', 'conductor': 'conductor',
            'replaygain_track_gain': 'replayGainTrack',
            'replaygain_album_gain': 'replayGainAlbum',
        };

        for (let i = 0; i < Math.min(commentCount, 200); i++) {
            if (pos + 4 > end) break;
            const len = readU32LE(bytes, pos);
            pos += 4;
            if (len <= 0 || len > 65536 || pos + len > end) break;

            const comment = new TextDecoder('utf-8').decode(bytes.subarray(pos, pos + len));
            pos += len;

            const eq = comment.indexOf('=');
            if (eq === -1) continue;

            const key = comment.substring(0, eq).toLowerCase();
            const val = comment.substring(eq + 1);

            const field = vorbisMap[key];
            if (field && val && !info[field]) {
                info[field] = val;
            }
        }
    } catch (e) {
        // Partial parse is fine
    }

    return info;
}

// ── Utilities ──────────────────────────────────────────

function readU16LE(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32LE(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

// ── ID3v1 Genre List ───────────────────────────────────

const ID3V1_GENRES = [
    'Blues','Classic Rock','Country','Dance','Disco','Funk','Grunge','Hip-Hop',
    'Jazz','Metal','New Age','Oldies','Other','Pop','R&B','Rap','Reggae','Rock',
    'Techno','Industrial','Alternative','Ska','Death Metal','Pranks','Soundtrack',
    'Euro-Techno','Ambient','Trip-Hop','Vocal','Jazz+Funk','Fusion','Trance',
    'Classical','Instrumental','Acid','House','Game','Sound Clip','Gospel','Noise',
    'AlternRock','Bass','Soul','Punk','Space','Meditative','Instrumental Pop',
    'Instrumental Rock','Ethnic','Gothic','Darkwave','Techno-Industrial','Electronic',
    'Pop-Folk','Eurodance','Dream','Southern Rock','Comedy','Cult','Gangsta','Top 40',
    'Christian Rap','Pop/Funk','Jungle','Native American','Cabaret','New Wave',
    'Psychedelic','Rave','Showtunes','Trailer','Lo-Fi','Tribal','Acid Punk',
    'Acid Jazz','Polka','Retro','Musical','Rock & Roll','Hard Rock',
    'Folk','Folk-Rock','National Folk','Swing','Fast Fusion','Bebop','Latin','Revival',
    'Celtic','Bluegrass','Avantgarde','Gothic Rock','Progressive Rock',
    'Psychedelic Rock','Symphonic Rock','Slow Rock','Big Band','Chorus',
    'Easy Listening','Acoustic','Humour','Speech','Chanson','Opera','Chamber Music',
    'Sonata','Symphony','Booty Bass','Primus','Porn Groove','Satire','Slow Jam',
    'Club','Tango','Samba','Folklore','Ballad','Power Ballad','Rhythmic Soul',
    'Freestyle','Duet','Punk Rock','Drum Solo','A capella','Euro-House','Dance Hall',
    'Goa','Drum & Bass','Club-House','Hardcore Techno','Terror','Indie','BritPop',
    'Negerpunk','Polsk Punk','Beat','Christian Gangsta Rap','Heavy Metal','Black Metal',
    'Crossover','Contemporary Christian','Christian Rock','Merengue','Salsa',
    'Thrash Metal','Anime','JPop','Synthpop','Abstract','Art Rock','Baroque',
    'Bhangra','Big Beat','Breakbeat','Chillout','Downtempo','Dub','EBM','Eclectic',
    'Electro','Electroclash','Emo','Experimental','Garage','Global','IDM',
    'Illbient','Industro-Goth','Jam Band','Krautrock','Leftfield','Lounge',
    'Math Rock','New Romantic','Nu-Breakz','Post-Punk','Post-Rock','Psytrance',
    'Shoegaze','Space Rock','Trop Rock','World Music','Neoclassical','Audiobook',
    'Audio Theatre','Neue Deutsche Welle','Podcast','Indie Rock','G-Funk',
    'Dubstep','Garage Rock','Psybient',
];
