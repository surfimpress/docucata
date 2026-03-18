/**
 * Extract content statistics from plain text files.
 * Plain text has no embedded metadata standard, so we derive structural
 * properties that are useful for archival and research purposes.
 *
 * @param {File} file
 * @returns {Promise<Object|null>}
 */
export async function parseTextMetadata(input) {
    try {
        const buffer = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        if (bytes.length === 0) return null;

        const info = {};

        // Detect encoding and BOM
        const { encoding, bom } = detectEncoding(bytes);
        info.encoding = encoding;
        if (bom) info.bom = bom;

        // Decode text
        let text;
        try {
            text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
        } catch {
            text = new TextDecoder('latin1').decode(bytes);
            info.encoding = 'ISO-8859-1 (fallback)';
        }

        // Strip BOM character if present
        if (text.charCodeAt(0) === 0xFEFF) {
            text = text.substring(1);
        }

        // Line ending detection
        const hasCRLF = text.includes('\r\n');
        const hasCR = !hasCRLF && text.includes('\r');
        const hasLF = text.includes('\n');

        if (hasCRLF) info.lineEndings = 'CRLF (Windows)';
        else if (hasCR) info.lineEndings = 'CR (Classic Mac)';
        else if (hasLF) info.lineEndings = 'LF (Unix/macOS)';
        else info.lineEndings = 'None (single line)';

        // Normalize line endings for counting
        const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const lines = normalized.split('\n');

        info.lineCount = lines.length;

        // Word count (split on whitespace, filter empty)
        const words = normalized.split(/\s+/).filter(w => w.length > 0);
        info.wordCount = words.length;

        // Character counts
        info.charCount = normalized.length;
        info.charCountNoSpaces = normalized.replace(/\s/g, '').length;

        // Non-ASCII detection
        let nonAscii = 0;
        for (let i = 0; i < bytes.length; i++) {
            if (bytes[i] > 127) nonAscii++;
        }
        if (nonAscii > 0) {
            info.nonAsciiBytes = nonAscii;
            info.nonAsciiPercent = `${((nonAscii / bytes.length) * 100).toFixed(1)}%`;
        }

        // Check if file ends with newline (common convention)
        info.endsWithNewline = normalized.endsWith('\n');

        // Longest line
        let maxLineLen = 0;
        for (const line of lines) {
            if (line.length > maxLineLen) maxLineLen = line.length;
        }
        info.longestLine = maxLineLen;

        // Check for null bytes (binary content detection)
        let nullBytes = 0;
        for (let i = 0; i < Math.min(bytes.length, 8192); i++) {
            if (bytes[i] === 0) nullBytes++;
        }
        if (nullBytes > 0) {
            info.containsNullBytes = true;
            info.possiblyBinary = true;
        }

        console.group(`[Docucata:Text] ${(input instanceof ArrayBuffer ? '(buffer)' : input.name)}`);
        console.log('Text metadata:', info);
        console.groupEnd();

        return info;
    } catch (e) {
        console.warn(`[Docucata:Text] Failed to parse ${(input instanceof ArrayBuffer ? '(buffer)' : input.name)}:`, e);
        return null;
    }
}

/**
 * Detect text encoding from byte patterns and BOM.
 */
function detectEncoding(bytes) {
    // Check for BOM (Byte Order Mark)
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
        return { encoding: 'utf-8', bom: 'UTF-8 BOM' };
    }
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
        return { encoding: 'utf-16le', bom: 'UTF-16 LE BOM' };
    }
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
        return { encoding: 'utf-16be', bom: 'UTF-16 BE BOM' };
    }

    // Heuristic: check if valid UTF-8
    if (isValidUtf8(bytes)) {
        // Check if it's pure ASCII
        let allAscii = true;
        for (let i = 0; i < bytes.length; i++) {
            if (bytes[i] > 127) { allAscii = false; break; }
        }
        return { encoding: 'utf-8', bom: allAscii ? null : null };
    }

    return { encoding: 'latin1', bom: null };
}

/**
 * Check if bytes are valid UTF-8.
 */
function isValidUtf8(bytes) {
    let i = 0;
    while (i < bytes.length) {
        const b = bytes[i];
        if (b <= 0x7F) {
            i++;
        } else if (b >= 0xC2 && b <= 0xDF) {
            if (i + 1 >= bytes.length || (bytes[i+1] & 0xC0) !== 0x80) return false;
            i += 2;
        } else if (b >= 0xE0 && b <= 0xEF) {
            if (i + 2 >= bytes.length || (bytes[i+1] & 0xC0) !== 0x80 || (bytes[i+2] & 0xC0) !== 0x80) return false;
            i += 3;
        } else if (b >= 0xF0 && b <= 0xF4) {
            if (i + 3 >= bytes.length || (bytes[i+1] & 0xC0) !== 0x80 || (bytes[i+2] & 0xC0) !== 0x80 || (bytes[i+3] & 0xC0) !== 0x80) return false;
            i += 4;
        } else {
            return false;
        }
    }
    return true;
}
