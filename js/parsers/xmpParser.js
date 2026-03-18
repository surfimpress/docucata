/**
 * XMP metadata parser — extracts Dublin Core and XMP fields from raw XMP XML.
 *
 * Worker-safe — uses regex parsing (no DOMParser, which is unavailable in workers).
 * Shared by psdParser, inddParser, and any future format with embedded XMP.
 *
 * @param {string} xml — raw XMP XML string (the content between <?xpacket begin...end?>)
 * @returns {Object} — extracted metadata fields
 */
export function parseXmpXml(xml) {
    if (!xml) return {};
    const meta = {};

    // Helper: extract single-value tag content
    function tag(pattern) {
        const m = xml.match(pattern);
        return m ? m[1].trim() : null;
    }

    // Helper: extract rdf:Bag / rdf:Seq / rdf:Alt list items
    function listItems(tagName) {
        const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i');
        const m = xml.match(re);
        if (!m) return null;
        const items = [];
        const liRe = /<rdf:li[^>]*>([^<]*)<\/rdf:li>/gi;
        let li;
        while ((li = liRe.exec(m[1])) !== null) {
            if (li[1].trim()) items.push(li[1].trim());
        }
        return items.length > 0 ? items : null;
    }

    // Dublin Core (dc:)
    const title = listItems('dc:title');
    if (title) meta.Title = title[0]; // Alt list, first = default language

    const creator = listItems('dc:creator');
    if (creator) meta.Author = creator.join('; ');

    const description = listItems('dc:description');
    if (description) meta.Description = description[0];

    const subject = listItems('dc:subject');
    if (subject) meta.Keywords = subject.join(', ');

    const rights = listItems('dc:rights');
    if (rights) meta.Rights = rights[0];

    const dcFormat = tag(/<dc:format>([^<]+)<\/dc:format>/i);
    if (dcFormat) meta.Format = dcFormat;

    // XMP basic (xmp:)
    const createDate = tag(/<xmp:CreateDate>([^<]+)<\/xmp:CreateDate>/i);
    if (createDate) meta.CreationDate = createDate;

    const modifyDate = tag(/<xmp:ModifyDate>([^<]+)<\/xmp:ModifyDate>/i);
    if (modifyDate) meta.ModifyDate = modifyDate;

    const creatorTool = tag(/<xmp:CreatorTool>([^<]+)<\/xmp:CreatorTool>/i);
    if (creatorTool) meta.CreatorTool = creatorTool;

    const metadataDate = tag(/<xmp:MetadataDate>([^<]+)<\/xmp:MetadataDate>/i);
    if (metadataDate) meta.MetadataDate = metadataDate;

    // XMP Media Management (xmpMM:)
    const docId = tag(/<xmpMM:DocumentID>([^<]+)<\/xmpMM:DocumentID>/i);
    if (docId) meta.DocumentID = docId;

    const instanceId = tag(/<xmpMM:InstanceID>([^<]+)<\/xmpMM:InstanceID>/i);
    if (instanceId) meta.InstanceID = instanceId;

    const origDocId = tag(/<xmpMM:OriginalDocumentID>([^<]+)<\/xmpMM:OriginalDocumentID>/i);
    if (origDocId) meta.OriginalDocumentID = origDocId;

    // PDF-specific (pdf:) — present in AI files
    const producer = tag(/<pdf:Producer>([^<]+)<\/pdf:Producer>/i);
    if (producer) meta.Producer = producer;

    const trapped = tag(/<pdf:Trapped>([^<]+)<\/pdf:Trapped>/i);
    if (trapped) meta.Trapped = trapped;

    // Illustrator-specific (xmpTPg:, illustrator:)
    const nPages = tag(/<xmpTPg:NPages>([^<]+)<\/xmpTPg:NPages>/i);
    if (nPages) meta.PageCount = parseInt(nPages, 10);

    // InDesign-specific (xmpTPg:, indd:)
    const documentID = tag(/<xmpMM:DocumentID>([^<]+)<\/xmpMM:DocumentID>/i);
    // already captured above

    // Photoshop-specific (photoshop:)
    const colorMode = tag(/<photoshop:ColorMode>([^<]+)<\/photoshop:ColorMode>/i);
    if (colorMode) {
        const modes = ['Bitmap', 'Grayscale', 'Indexed', 'RGB', 'CMYK', '', '', 'Multichannel', 'Duotone', 'Lab'];
        meta.XmpColorMode = modes[parseInt(colorMode, 10)] || colorMode;
    }

    const iccProfile = tag(/<photoshop:ICCProfile>([^<]+)<\/photoshop:ICCProfile>/i);
    if (iccProfile) meta.ICCProfile = iccProfile;

    return meta;
}

/**
 * Find and extract XMP packet from raw bytes.
 * Scans for <?xpacket begin marker and extracts the XML between begin/end markers.
 *
 * @param {Uint8Array} bytes
 * @param {number} [maxScan] — how far into the file to scan (default: 1MB)
 * @returns {string|null} — raw XMP XML or null
 */
export function findXmpPacket(bytes, maxScan = 1024 * 1024) {
    const limit = Math.min(bytes.length, maxScan);
    // Search for <?xpacket begin
    const needle = [0x3C, 0x3F, 0x78, 0x70, 0x61, 0x63, 0x6B, 0x65, 0x74, 0x20, 0x62, 0x65, 0x67, 0x69, 0x6E]; // <?xpacket begin
    let start = -1;
    for (let i = 0; i < limit - needle.length; i++) {
        let match = true;
        for (let j = 0; j < needle.length; j++) {
            if (bytes[i + j] !== needle[j]) { match = false; break; }
        }
        if (match) { start = i; break; }
    }
    if (start === -1) return null;

    // Search for <?xpacket end
    const endNeedle = [0x3C, 0x3F, 0x78, 0x70, 0x61, 0x63, 0x6B, 0x65, 0x74, 0x20, 0x65, 0x6E, 0x64]; // <?xpacket end
    const searchLimit = Math.min(bytes.length, start + maxScan);
    let end = -1;
    for (let i = start + 20; i < searchLimit - endNeedle.length; i++) {
        let match = true;
        for (let j = 0; j < endNeedle.length; j++) {
            if (bytes[i + j] !== endNeedle[j]) { match = false; break; }
        }
        if (match) {
            // Find the closing ?>
            for (let k = i; k < Math.min(i + 40, bytes.length); k++) {
                if (bytes[k] === 0x3E) { end = k + 1; break; }
            }
            break;
        }
    }
    if (end === -1) end = searchLimit;

    // Decode as UTF-8
    try {
        return new TextDecoder('utf-8').decode(bytes.slice(start, end));
    } catch {
        return null;
    }
}
