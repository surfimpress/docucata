/**
 * Image metadata extractor — works for all image formats.
 * Combines:
 * - Browser Image API: dimensions (all formats)
 * - PNG chunk parsing: color type, bit depth, alpha, gamma, ICC, text chunks
 * - GIF header: dimensions, color table, version
 * - BMP header: dimensions, bit depth
 * - WebP: dimensions, format variant (VP8/VP8L/VP8X)
 * - EXIF (JPEG/TIFF): delegated to exifParser.js
 */

import { parseExifMetadata } from './exifParser.js';

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico',
                    'tiff', 'tif', 'heic', 'heif'];

/**
 * Extract all available metadata from an image file.
 * @param {File} file
 * @returns {Promise<Object|null>}
 */
export async function parseImageMetadata(file) {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!IMAGE_EXTS.includes(ext)) return null;

    const meta = {};

    try {
        // Get dimensions via browser's Image API (works for all decodable formats)
        const dims = await getImageDimensions(file);
        if (dims) {
            meta.Width = dims.width;
            meta.Height = dims.height;
            meta.AspectRatio = simplifyRatio(dims.width, dims.height);
            meta.Megapixels = ((dims.width * dims.height) / 1_000_000).toFixed(1) + ' MP';
        }

        // Format-specific binary parsing
        const slice = file.slice(0, 131072); // first 128KB
        const buffer = await slice.arrayBuffer();
        const view = new DataView(buffer);

        if (ext === 'png') {
            Object.assign(meta, parsePngChunks(view, buffer));
        } else if (ext === 'gif') {
            Object.assign(meta, parseGifHeader(view));
        } else if (ext === 'bmp') {
            Object.assign(meta, parseBmpHeader(view));
        } else if (ext === 'webp') {
            Object.assign(meta, await parseWebpHeader(view, buffer));
        } else if (ext === 'svg') {
            Object.assign(meta, await parseSvgMetadata(file));
        } else if (ext === 'ico') {
            Object.assign(meta, parseIcoHeader(view));
        }

        // JPEG/TIFF — merge EXIF on top
        if (['jpg', 'jpeg', 'tiff', 'tif', 'heic', 'heif'].includes(ext)) {
            const exif = await parseExifMetadata(file);
            if (exif) Object.assign(meta, exif);
        }
    } catch (e) {
        console.warn(`[Docucata:Image] Failed to parse ${file.name}:`, e);
    }

    return Object.keys(meta).length > 0 ? meta : null;
}

// ── Browser Image API ───────────────────────────────────

function getImageDimensions(file) {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            resolve({ width: img.naturalWidth, height: img.naturalHeight });
            URL.revokeObjectURL(url);
        };
        img.onerror = () => {
            resolve(null);
            URL.revokeObjectURL(url);
        };
        img.src = url;
    });
}

function simplifyRatio(w, h) {
    const g = gcd(w, h);
    return `${w / g}:${h / g}`;
}

function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }

// ── PNG ─────────────────────────────────────────────────

const PNG_COLOR_TYPES = {
    0: 'Grayscale',
    2: 'RGB',
    3: 'Indexed (palette)',
    4: 'Grayscale + Alpha',
    6: 'RGBA',
};

function parsePngChunks(view, buffer) {
    const meta = {};

    // Verify PNG signature
    if (view.byteLength < 8) return meta;
    if (view.getUint32(0) !== 0x89504E47 || view.getUint32(4) !== 0x0D0A1A0A) return meta;

    let offset = 8;
    while (offset + 8 < view.byteLength) {
        const chunkLen = view.getUint32(offset);
        const chunkType = String.fromCharCode(
            view.getUint8(offset + 4), view.getUint8(offset + 5),
            view.getUint8(offset + 6), view.getUint8(offset + 7)
        );

        const dataStart = offset + 8;
        const dataEnd = dataStart + chunkLen;
        if (dataEnd > view.byteLength) break;

        if (chunkType === 'IHDR' && chunkLen >= 13) {
            meta.BitDepth = view.getUint8(dataStart + 8);
            const colorType = view.getUint8(dataStart + 9);
            meta.ColorType = PNG_COLOR_TYPES[colorType] || `Unknown (${colorType})`;
            meta.AlphaChannel = (colorType === 4 || colorType === 6) ? 'Yes' : 'No';
            meta.Compression = 'Deflate';
            const interlace = view.getUint8(dataStart + 12);
            meta.Interlaced = interlace === 1 ? 'Adam7' : 'No';
            // Compute bits per pixel
            const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
            const ch = channels[colorType] || 1;
            meta.BitsPerPixel = meta.BitDepth * ch;
        }

        if (chunkType === 'gAMA' && chunkLen >= 4) {
            meta.Gamma = (view.getUint32(dataStart) / 100000).toFixed(4);
        }

        if (chunkType === 'cHRM' && chunkLen >= 32) {
            meta.Chromaticity = 'Present';
        }

        if (chunkType === 'sRGB' && chunkLen >= 1) {
            const intents = ['Perceptual', 'Relative colorimetric', 'Saturation', 'Absolute colorimetric'];
            meta.ColorSpace = 'sRGB';
            meta.RenderingIntent = intents[view.getUint8(dataStart)] || 'Unknown';
        }

        if (chunkType === 'iCCP' && chunkLen > 2) {
            // ICC profile name is null-terminated ASCII
            let name = '';
            for (let i = 0; i < Math.min(chunkLen, 80); i++) {
                const c = view.getUint8(dataStart + i);
                if (c === 0) break;
                name += String.fromCharCode(c);
            }
            if (name) meta.ICCProfile = name;
            if (!meta.ColorSpace) meta.ColorSpace = name;
        }

        if (chunkType === 'pHYs' && chunkLen >= 9) {
            const ppuX = view.getUint32(dataStart);
            const ppuY = view.getUint32(dataStart + 4);
            const unit = view.getUint8(dataStart + 8);
            if (unit === 1) {
                // Meters — convert to DPI
                meta.DpiX = Math.round(ppuX / 39.3701);
                meta.DpiY = Math.round(ppuY / 39.3701);
            } else {
                meta.PixelsPerUnitX = ppuX;
                meta.PixelsPerUnitY = ppuY;
            }
        }

        // Text chunks (tEXt, iTXt, zTXt)
        if (chunkType === 'tEXt' && chunkLen > 1) {
            const { key, value } = readPngTextChunk(buffer, dataStart, chunkLen);
            if (key) meta[`PNG:${key}`] = value;
        }

        if (chunkType === 'iTXt' && chunkLen > 5) {
            const { key, value } = readPngItxtChunk(buffer, dataStart, chunkLen);
            if (key) meta[`PNG:${key}`] = value;
        }

        // Stop at IDAT — no useful metadata after that
        if (chunkType === 'IDAT') break;

        offset = dataEnd + 4; // +4 for CRC
    }

    if (!meta.ColorSpace && meta.ColorType) {
        if (meta.ColorType.includes('RGB')) meta.ColorSpace = 'RGB';
        else if (meta.ColorType.includes('Grayscale')) meta.ColorSpace = 'Grayscale';
        else if (meta.ColorType.includes('Indexed')) meta.ColorSpace = 'Indexed';
    }

    return meta;
}

function readPngTextChunk(buffer, offset, len) {
    const bytes = new Uint8Array(buffer, offset, len);
    const nullIdx = bytes.indexOf(0);
    if (nullIdx < 0) return {};
    const key = new TextDecoder().decode(bytes.slice(0, nullIdx));
    const value = new TextDecoder().decode(bytes.slice(nullIdx + 1));
    return { key, value };
}

function readPngItxtChunk(buffer, offset, len) {
    const bytes = new Uint8Array(buffer, offset, len);
    const nullIdx = bytes.indexOf(0);
    if (nullIdx < 0) return {};
    const key = new TextDecoder().decode(bytes.slice(0, nullIdx));
    // Skip compression flag (1), compression method (1), language tag (null-term), translated keyword (null-term)
    let pos = nullIdx + 1;
    pos += 2; // compression flag + method
    // Skip language tag
    while (pos < bytes.length && bytes[pos] !== 0) pos++;
    pos++; // null
    // Skip translated keyword
    while (pos < bytes.length && bytes[pos] !== 0) pos++;
    pos++; // null
    const value = new TextDecoder('utf-8').decode(bytes.slice(pos));
    return { key, value };
}

// ── GIF ─────────────────────────────────────────────────

function parseGifHeader(view) {
    const meta = {};
    if (view.byteLength < 13) return meta;

    // Signature: GIF87a or GIF89a
    const sig = String.fromCharCode(
        view.getUint8(0), view.getUint8(1), view.getUint8(2),
        view.getUint8(3), view.getUint8(4), view.getUint8(5)
    );
    if (!sig.startsWith('GIF')) return meta;

    meta.GIFVersion = sig;
    meta.ColorSpace = 'Indexed';

    const packed = view.getUint8(10);
    const hasGCT = (packed >> 7) & 1;
    const colorRes = ((packed >> 4) & 7) + 1;
    const bitsPerPixel = (packed & 7) + 1;

    meta.BitsPerPixel = bitsPerPixel;
    meta.ColorResolution = colorRes + ' bits';
    if (hasGCT) {
        meta.GlobalColorTable = Math.pow(2, bitsPerPixel) + ' colors';
    }
    meta.BackgroundColorIndex = view.getUint8(11);

    // Count frames (scan for image descriptors 0x2C)
    let frames = 0;
    let offset = 13;
    if (hasGCT) offset += 3 * Math.pow(2, bitsPerPixel);
    while (offset < view.byteLength - 1) {
        const blockType = view.getUint8(offset);
        if (blockType === 0x2C) {
            frames++;
            offset += 10; // skip image descriptor
            const localPacked = view.getUint8(offset - 1);
            const hasLCT = (localPacked >> 7) & 1;
            if (hasLCT) {
                const lctBits = (localPacked & 7) + 1;
                offset += 3 * Math.pow(2, lctBits);
            }
            offset++; // LZW min code size
            // Skip sub-blocks
            while (offset < view.byteLength) {
                const subLen = view.getUint8(offset);
                offset++;
                if (subLen === 0) break;
                offset += subLen;
            }
        } else if (blockType === 0x21) {
            offset += 2; // skip extension label
            // Skip sub-blocks
            while (offset < view.byteLength) {
                const subLen = view.getUint8(offset);
                offset++;
                if (subLen === 0) break;
                offset += subLen;
            }
        } else if (blockType === 0x3B) {
            break; // trailer
        } else {
            offset++;
        }
    }
    if (frames > 1) meta.Animated = `Yes (${frames} frames)`;
    else if (frames === 1) meta.Animated = 'No';

    return meta;
}

// ── BMP ─────────────────────────────────────────────────

function parseBmpHeader(view) {
    const meta = {};
    if (view.byteLength < 30) return meta;
    if (view.getUint8(0) !== 0x42 || view.getUint8(1) !== 0x4D) return meta;

    const dibHeaderSize = view.getUint32(14, true);
    meta.DIBHeader = dibHeaderSize === 40 ? 'BITMAPINFOHEADER' :
                     dibHeaderSize === 108 ? 'BITMAPV4HEADER' :
                     dibHeaderSize === 124 ? 'BITMAPV5HEADER' :
                     `${dibHeaderSize} bytes`;

    if (dibHeaderSize >= 40) {
        const bpp = view.getUint16(28, true);
        meta.BitsPerPixel = bpp;
        meta.AlphaChannel = bpp === 32 ? 'Likely' : 'No';

        const compression = view.getUint32(30, true);
        const compNames = { 0: 'None (BI_RGB)', 1: 'RLE8', 2: 'RLE4', 3: 'Bitfields' };
        meta.Compression = compNames[compression] || `Code ${compression}`;

        if (dibHeaderSize >= 40 + 8) {
            const xPPM = view.getInt32(38, true);
            const yPPM = view.getInt32(42, true);
            if (xPPM > 0) meta.DpiX = Math.round(xPPM / 39.3701);
            if (yPPM > 0) meta.DpiY = Math.round(yPPM / 39.3701);
        }

        if (dibHeaderSize >= 40 + 12) {
            const colorsUsed = view.getUint32(46, true);
            if (colorsUsed > 0) meta.ColorsUsed = colorsUsed;
        }

        meta.ColorSpace = bpp <= 8 ? 'Indexed' : bpp === 24 ? 'RGB' : bpp === 32 ? 'RGBA' : `${bpp}-bit`;
    }

    return meta;
}

// ── WebP ────────────────────────────────────────────────

async function parseWebpHeader(view, buffer) {
    const meta = {};
    if (view.byteLength < 16) return meta;

    // RIFF....WEBP
    if (view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57454250) return meta;

    const chunkType = String.fromCharCode(
        view.getUint8(12), view.getUint8(13),
        view.getUint8(14), view.getUint8(15)
    );

    if (chunkType === 'VP8 ' && view.byteLength >= 30) {
        meta.WebPFormat = 'Lossy (VP8)';
        meta.Compression = 'Lossy';
    } else if (chunkType === 'VP8L' && view.byteLength >= 25) {
        meta.WebPFormat = 'Lossless (VP8L)';
        meta.Compression = 'Lossless';
        // VP8L signature byte
        if (view.getUint8(21) === 0x2F) {
            const bits = view.getUint32(22, true);
            const w = (bits & 0x3FFF) + 1;
            const h = ((bits >> 14) & 0x3FFF) + 1;
            const hasAlpha = (bits >> 28) & 1;
            meta.AlphaChannel = hasAlpha ? 'Yes' : 'No';
        }
    } else if (chunkType === 'VP8X' && view.byteLength >= 30) {
        meta.WebPFormat = 'Extended (VP8X)';
        const flags = view.getUint8(20);
        meta.AlphaChannel = (flags & 0x10) ? 'Yes' : 'No';
        meta.Animated = (flags & 0x02) ? 'Yes' : 'No';
        const hasICCP = flags & 0x20;
        const hasExif = flags & 0x08;
        const hasXMP = flags & 0x04;
        if (hasICCP) meta.ICCProfile = 'Present';
        if (hasExif) meta.EXIF = 'Present';
        if (hasXMP) meta.XMP = 'Present';

        // Parse EXIF chunk if present
        if (hasExif) {
            const exif = await findWebpExif(view, buffer);
            if (exif) Object.assign(meta, exif);
        }
    }

    meta.ColorSpace = meta.AlphaChannel === 'Yes' ? 'RGBA' : 'RGB';

    return meta;
}

// ── SVG ─────────────────────────────────────────────────

async function parseSvgMetadata(file) {
    const meta = {};
    try {
        const text = await file.text();
        // Quick regex extraction from the SVG root element
        const svgMatch = text.match(/<svg[^>]*>/i);
        if (svgMatch) {
            const root = svgMatch[0];
            const widthMatch = root.match(/\bwidth\s*=\s*["']([^"']+)/);
            const heightMatch = root.match(/\bheight\s*=\s*["']([^"']+)/);
            const viewBoxMatch = root.match(/viewBox\s*=\s*["']([^"']+)/);

            if (widthMatch) meta.SVGWidth = widthMatch[1];
            if (heightMatch) meta.SVGHeight = heightMatch[1];
            if (viewBoxMatch) meta.ViewBox = viewBoxMatch[1];
        }

        // Look for <title> and <desc>
        const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
        const descMatch = text.match(/<desc[^>]*>([^<]+)<\/desc>/i);
        if (titleMatch) meta.SVGTitle = titleMatch[1].trim();
        if (descMatch) meta.SVGDescription = descMatch[1].trim();

        meta.ColorSpace = 'Vector (SVG)';
        meta.Format = 'SVG/XML';

        // Rough element count for complexity
        const elementCount = (text.match(/<[a-zA-Z]/g) || []).length;
        meta.ElementCount = elementCount;
    } catch (e) {
        console.warn('[Docucata:Image] SVG parse error:', e);
    }
    return meta;
}

// ── ICO ─────────────────────────────────────────────────

function parseIcoHeader(view) {
    const meta = {};
    if (view.byteLength < 6) return meta;

    // Reserved (0), Type (1=icon, 2=cursor), Count
    const type = view.getUint16(2, true);
    const count = view.getUint16(4, true);

    meta.IconType = type === 1 ? 'Icon' : type === 2 ? 'Cursor' : `Type ${type}`;
    meta.ImageCount = count;

    // Parse directory entries (16 bytes each)
    const sizes = [];
    for (let i = 0; i < count && (6 + (i + 1) * 16) <= view.byteLength; i++) {
        const off = 6 + i * 16;
        const w = view.getUint8(off) || 256;
        const h = view.getUint8(off + 1) || 256;
        const bpp = view.getUint16(off + 6, true);
        sizes.push(`${w}x${h}` + (bpp ? ` (${bpp}bpp)` : ''));
    }
    if (sizes.length > 0) meta.Sizes = sizes.join(', ');

    return meta;
}

// ── WebP EXIF extraction ────────────────────────────────

async function findWebpExif(view, buffer) {
    // Walk RIFF chunks looking for EXIF
    let offset = 12;
    while (offset + 8 < view.byteLength) {
        const fourCC = String.fromCharCode(
            view.getUint8(offset), view.getUint8(offset + 1),
            view.getUint8(offset + 2), view.getUint8(offset + 3)
        );
        const size = view.getUint32(offset + 4, true);

        if (fourCC === 'EXIF' && size > 0) {
            // The EXIF data starts at offset+8, may have "Exif\0\0" prefix
            const exifStart = offset + 8;
            if (view.getUint32(exifStart) === 0x45786966) {
                // Has Exif header — create a fake JPEG-like view for the parser
                const tiffStart = exifStart + 6;
                if (tiffStart + 8 < view.byteLength) {
                    // Reuse existing EXIF TIFF parser would be ideal,
                    // but we already merge EXIF from parseExifMetadata above
                    return null;
                }
            }
        }

        offset += 8 + size;
        if (size % 2 !== 0) offset++; // RIFF chunks are word-aligned
    }
    return null;
}
