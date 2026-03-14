/**
 * Extract EXIF metadata from JPEG/TIFF files by reading raw bytes.
 * @param {File} file
 * @returns {Promise<Object|null>} Parsed EXIF data or null
 */
export async function parseExifMetadata(file) {
    try {
        // Only process JPEG and TIFF
        const ext = file.name.split('.').pop()?.toLowerCase();
        const supported = ['jpg', 'jpeg', 'tiff', 'tif'];
        if (!supported.includes(ext) && !file.type.startsWith('image/jpeg') && !file.type.startsWith('image/tiff')) {
            return null;
        }

        // Read first 128KB — EXIF is always near the start
        const slice = file.slice(0, 131072);
        const buffer = await slice.arrayBuffer();
        const view = new DataView(buffer);

        // JPEG: look for APP1 marker (0xFFE1) containing Exif
        if (view.getUint8(0) === 0xFF && view.getUint8(1) === 0xD8) {
            return parseJpegExif(view, file.name);
        }

        // TIFF: starts with byte order mark
        if ((view.getUint8(0) === 0x49 && view.getUint8(1) === 0x49) ||
            (view.getUint8(0) === 0x4D && view.getUint8(1) === 0x4D)) {
            return parseTiffExif(view, 0, file.name);
        }

        return null;
    } catch (e) {
        console.warn(`[Docucata:EXIF] Failed to parse ${file.name}:`, e);
        return null;
    }
}

function parseJpegExif(view, filename) {
    let offset = 2;
    const length = view.byteLength;

    while (offset < length - 1) {
        if (view.getUint8(offset) !== 0xFF) break;

        const marker = view.getUint8(offset + 1);

        // APP1 marker
        if (marker === 0xE1) {
            const segLen = view.getUint16(offset + 2);
            // Check for "Exif\0\0"
            if (view.getUint32(offset + 4) === 0x45786966 && view.getUint16(offset + 8) === 0x0000) {
                const tiffOffset = offset + 10;
                return parseTiffExif(view, tiffOffset, filename);
            }
            offset += 2 + segLen;
        } else if (marker === 0xDA) {
            // Start of scan — no more metadata
            break;
        } else {
            const segLen = view.getUint16(offset + 2);
            offset += 2 + segLen;
        }
    }

    return null;
}

function parseTiffExif(view, tiffStart, filename) {
    const length = view.byteLength;
    if (tiffStart + 8 > length) return null;

    const byteOrder = view.getUint16(tiffStart);
    const littleEndian = byteOrder === 0x4949;

    // Verify TIFF magic number
    if (view.getUint16(tiffStart + 2, littleEndian) !== 0x002A) return null;

    const ifdOffset = view.getUint32(tiffStart + 4, littleEndian);
    const tags = {};

    // Parse IFD0 (main image tags)
    const exifIfdPointer = parseIFD(view, tiffStart, ifdOffset, littleEndian, tags);

    // Parse Exif SubIFD if present
    if (exifIfdPointer) {
        parseIFD(view, tiffStart, exifIfdPointer, littleEndian, tags);
    }

    // Parse GPS IFD if present
    if (tags._gpsIfdPointer) {
        parseGpsIFD(view, tiffStart, tags._gpsIfdPointer, littleEndian, tags);
        delete tags._gpsIfdPointer;
    }

    // Clean up internal pointers and raw offsets
    delete tags._exifIfdPointer;
    delete tags._interopIfdPointer;
    delete tags.MakerNote_Offset;

    if (Object.keys(tags).length === 0) return null;

    console.group(`[Docucata:EXIF] ${filename}`);
    console.log('EXIF metadata:', tags);
    console.groupEnd();

    return tags;
}

const EXIF_TAGS = {
    // IFD0 — primary image tags
    0x0100: 'ImageWidth',
    0x0101: 'ImageHeight',
    0x0102: 'BitsPerSample',
    0x0103: 'Compression',
    0x0106: 'PhotometricInterpretation',
    0x010E: 'ImageDescription',
    0x010F: 'Make',
    0x0110: 'Model',
    0x0112: 'Orientation',
    0x0115: 'SamplesPerPixel',
    0x011A: 'XResolution',
    0x011B: 'YResolution',
    0x011C: 'PlanarConfiguration',
    0x0128: 'ResolutionUnit',
    0x0131: 'Software',
    0x0132: 'DateTime',
    0x013B: 'Artist',
    0x013E: 'WhitePoint',
    0x013F: 'PrimaryChromaticities',
    0x0211: 'YCbCrCoefficients',
    0x0212: 'YCbCrSubSampling',
    0x0213: 'YCbCrPositioning',
    0x0214: 'ReferenceBlackWhite',
    0x8298: 'Copyright',
    0x8769: '_exifIfdPointer',
    0x8825: '_gpsIfdPointer',

    // Exif SubIFD tags
    0x829A: 'ExposureTime',
    0x829D: 'FNumber',
    0x8822: 'ExposureProgram',
    0x8824: 'SpectralSensitivity',
    0x8827: 'ISO',
    0x8828: 'OECF',
    0x8830: 'SensitivityType',
    0x8831: 'StandardOutputSensitivity',
    0x8832: 'RecommendedExposureIndex',
    0x9000: 'ExifVersion',
    0x9003: 'DateTimeOriginal',
    0x9004: 'DateTimeDigitized',
    0x9010: 'OffsetTime',
    0x9011: 'OffsetTimeOriginal',
    0x9012: 'OffsetTimeDigitized',
    0x9101: 'ComponentsConfiguration',
    0x9102: 'CompressedBitsPerPixel',
    0x9201: 'ShutterSpeedValue',
    0x9202: 'ApertureValue',
    0x9203: 'BrightnessValue',
    0x9204: 'ExposureBiasValue',
    0x9205: 'MaxApertureValue',
    0x9206: 'SubjectDistance',
    0x9207: 'MeteringMode',
    0x9208: 'LightSource',
    0x9209: 'Flash',
    0x920A: 'FocalLength',
    0x9214: 'SubjectArea',
    0x927C: 'MakerNote_Offset',
    0x9286: 'UserComment',
    0x9290: 'SubSecTime',
    0x9291: 'SubSecTimeOriginal',
    0x9292: 'SubSecTimeDigitized',
    0xA000: 'FlashpixVersion',
    0xA001: 'ColorSpace',
    0xA002: 'PixelXDimension',
    0xA003: 'PixelYDimension',
    0xA004: 'RelatedSoundFile',
    0xA005: '_interopIfdPointer',
    0xA20B: 'FlashEnergy',
    0xA20E: 'FocalPlaneXResolution',
    0xA20F: 'FocalPlaneYResolution',
    0xA210: 'FocalPlaneResolutionUnit',
    0xA214: 'SubjectLocation',
    0xA215: 'ExposureIndex',
    0xA217: 'SensingMethod',
    0xA300: 'FileSource',
    0xA301: 'SceneType',
    0xA302: 'CFAPattern',
    0xA401: 'CustomRendered',
    0xA402: 'ExposureMode',
    0xA403: 'WhiteBalance',
    0xA404: 'DigitalZoomRatio',
    0xA405: 'FocalLengthIn35mmFilm',
    0xA406: 'SceneCaptureType',
    0xA407: 'GainControl',
    0xA408: 'Contrast',
    0xA409: 'Saturation',
    0xA40A: 'Sharpness',
    0xA40B: 'DeviceSettingDescription',
    0xA40C: 'SubjectDistanceRange',
    0xA420: 'ImageUniqueID',
    0xA430: 'CameraOwnerName',
    0xA431: 'BodySerialNumber',
    0xA432: 'LensSpecification',
    0xA433: 'LensMake',
    0xA434: 'LensModel',
    0xA435: 'LensSerialNumber',
    0xA500: 'Gamma',
};

function parseIFD(view, tiffStart, ifdOffset, littleEndian, tags) {
    const absOffset = tiffStart + ifdOffset;
    if (absOffset + 2 > view.byteLength) return null;

    const entryCount = view.getUint16(absOffset, littleEndian);
    let exifPointer = null;

    for (let i = 0; i < entryCount; i++) {
        const entryOffset = absOffset + 2 + (i * 12);
        if (entryOffset + 12 > view.byteLength) break;

        const tag = view.getUint16(entryOffset, littleEndian);
        const type = view.getUint16(entryOffset + 2, littleEndian);
        const count = view.getUint32(entryOffset + 4, littleEndian);

        const tagName = EXIF_TAGS[tag];
        if (!tagName) continue;

        const value = readTagValue(view, tiffStart, entryOffset, type, count, littleEndian);

        if (tagName === '_exifIfdPointer') {
            exifPointer = value;
        } else if (tagName === '_gpsIfdPointer') {
            tags._gpsIfdPointer = value;
        } else if (tagName === '_interopIfdPointer') {
            tags._interopIfdPointer = value;
        } else {
            tags[tagName] = value;
        }
    }

    return exifPointer;
}

const GPS_TAGS = {
    0x0000: 'GPSVersionID',
    0x0001: 'GPSLatitudeRef',
    0x0002: 'GPSLatitude',
    0x0003: 'GPSLongitudeRef',
    0x0004: 'GPSLongitude',
    0x0005: 'GPSAltitudeRef',
    0x0006: 'GPSAltitude',
    0x0007: 'GPSTimeStamp',
    0x0008: 'GPSSatellites',
    0x0009: 'GPSStatus',
    0x000A: 'GPSMeasureMode',
    0x000B: 'GPSDOP',
    0x000C: 'GPSSpeedRef',
    0x000D: 'GPSSpeed',
    0x000E: 'GPSTrackRef',
    0x000F: 'GPSTrack',
    0x0010: 'GPSImgDirectionRef',
    0x0011: 'GPSImgDirection',
    0x0012: 'GPSMapDatum',
    0x0013: 'GPSDestLatitudeRef',
    0x0014: 'GPSDestLatitude',
    0x0015: 'GPSDestLongitudeRef',
    0x0016: 'GPSDestLongitude',
    0x0017: 'GPSDestBearingRef',
    0x0018: 'GPSDestBearing',
    0x0019: 'GPSDestDistanceRef',
    0x001A: 'GPSDestDistance',
    0x001B: 'GPSProcessingMethod',
    0x001C: 'GPSAreaInformation',
    0x001D: 'GPSDateStamp',
    0x001E: 'GPSDifferential',
    0x001F: 'GPSHPositioningError',
};

function parseGpsIFD(view, tiffStart, ifdOffset, littleEndian, tags) {
    const absOffset = tiffStart + ifdOffset;
    if (absOffset + 2 > view.byteLength) return;

    const entryCount = view.getUint16(absOffset, littleEndian);
    const gpsRaw = {};

    for (let i = 0; i < entryCount; i++) {
        const entryOffset = absOffset + 2 + (i * 12);
        if (entryOffset + 12 > view.byteLength) break;

        const tag = view.getUint16(entryOffset, littleEndian);
        const type = view.getUint16(entryOffset + 2, littleEndian);
        const count = view.getUint32(entryOffset + 4, littleEndian);

        const tagName = GPS_TAGS[tag];
        if (!tagName) continue;

        gpsRaw[tagName] = readTagValue(view, tiffStart, entryOffset, type, count, littleEndian);
    }

    // Convert to decimal degrees
    if (gpsRaw.GPSLatitude && gpsRaw.GPSLatitudeRef) {
        const lat = dmsToDecimal(gpsRaw.GPSLatitude);
        tags.GPSLatitude = gpsRaw.GPSLatitudeRef === 'S' ? -lat : lat;
    }
    if (gpsRaw.GPSLongitude && gpsRaw.GPSLongitudeRef) {
        const lng = dmsToDecimal(gpsRaw.GPSLongitude);
        tags.GPSLongitude = gpsRaw.GPSLongitudeRef === 'W' ? -lng : lng;
    }
    if (gpsRaw.GPSAltitude != null) {
        tags.GPSAltitude = gpsRaw.GPSAltitude;
    }
    if (gpsRaw.GPSDateStamp) {
        tags.GPSDateStamp = gpsRaw.GPSDateStamp;
    }
    if (gpsRaw.GPSTimeStamp) {
        tags.GPSTimeStamp = gpsRaw.GPSTimeStamp;
    }
}

function dmsToDecimal(dms) {
    if (Array.isArray(dms) && dms.length === 3) {
        return dms[0] + dms[1] / 60 + dms[2] / 3600;
    }
    return dms;
}

function readTagValue(view, tiffStart, entryOffset, type, count, littleEndian) {
    const typeSizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 12: 8 };
    const typeSize = typeSizes[type] || 1;
    const totalSize = typeSize * count;

    let valueOffset;
    if (totalSize <= 4) {
        valueOffset = entryOffset + 8;
    } else {
        valueOffset = tiffStart + view.getUint32(entryOffset + 8, littleEndian);
    }

    if (valueOffset + totalSize > view.byteLength) return null;

    // ASCII string
    if (type === 2) {
        let str = '';
        for (let i = 0; i < count - 1; i++) {
            str += String.fromCharCode(view.getUint8(valueOffset + i));
        }
        return str.trim();
    }

    // BYTE / UNDEFINED
    if (type === 1 || type === 7) {
        if (count === 1) return view.getUint8(valueOffset);
        if (count <= 4) {
            const bytes = [];
            for (let i = 0; i < count; i++) bytes.push(view.getUint8(valueOffset + i));
            return bytes;
        }
        let str = '';
        for (let i = 0; i < Math.min(count, 32); i++) {
            str += String.fromCharCode(view.getUint8(valueOffset + i));
        }
        return str.trim();
    }

    // SHORT
    if (type === 3) {
        if (count === 1) return view.getUint16(valueOffset, littleEndian);
        const arr = [];
        for (let i = 0; i < count; i++) arr.push(view.getUint16(valueOffset + i * 2, littleEndian));
        return arr;
    }

    // LONG
    if (type === 4) {
        if (count === 1) return view.getUint32(valueOffset, littleEndian);
        const arr = [];
        for (let i = 0; i < count; i++) arr.push(view.getUint32(valueOffset + i * 4, littleEndian));
        return arr;
    }

    // RATIONAL (two LONGs: numerator/denominator)
    if (type === 5) {
        if (count === 1) {
            const num = view.getUint32(valueOffset, littleEndian);
            const den = view.getUint32(valueOffset + 4, littleEndian);
            return den === 0 ? 0 : num / den;
        }
        const arr = [];
        for (let i = 0; i < count; i++) {
            const num = view.getUint32(valueOffset + i * 8, littleEndian);
            const den = view.getUint32(valueOffset + i * 8 + 4, littleEndian);
            arr.push(den === 0 ? 0 : num / den);
        }
        return arr;
    }

    // SLONG
    if (type === 9) {
        if (count === 1) return view.getInt32(valueOffset, littleEndian);
        const arr = [];
        for (let i = 0; i < count; i++) arr.push(view.getInt32(valueOffset + i * 4, littleEndian));
        return arr;
    }

    // SRATIONAL
    if (type === 10) {
        if (count === 1) {
            const num = view.getInt32(valueOffset, littleEndian);
            const den = view.getInt32(valueOffset + 4, littleEndian);
            return den === 0 ? 0 : num / den;
        }
        const arr = [];
        for (let i = 0; i < count; i++) {
            const num = view.getInt32(valueOffset + i * 8, littleEndian);
            const den = view.getInt32(valueOffset + i * 8 + 4, littleEndian);
            arr.push(den === 0 ? 0 : num / den);
        }
        return arr;
    }

    return null;
}
