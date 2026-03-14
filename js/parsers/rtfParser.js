/**
 * Extract metadata from RTF files.
 * RTF stores metadata in the {\info ...} group with fields like \title, \author, \creatim, etc.
 * @param {File} file
 * @returns {Promise<Object|null>}
 */
export async function parseRtfMetadata(file) {
    try {
        // Read first 32KB - metadata is always near the start
        var slice = file.slice(0, 32768);
        var text = await slice.text();

        if (!text.startsWith("{\\rtf")) return null;

        var info = {};

        // Find the \info group
        var infoStart = text.indexOf("{\\info");
        if (infoStart === -1) return null;

        // Extract the info block (find matching closing brace)
        var depth = 0;
        var infoEnd = infoStart;
        for (var i = infoStart; i < text.length; i++) {
            if (text[i] === "{") depth++;
            else if (text[i] === "}") {
                depth--;
                if (depth === 0) { infoEnd = i + 1; break; }
            }
        }

        var infoBlock = text.substring(infoStart, infoEnd);

        // Extract text fields
        var fields = {
            "title": "title",
            "subject": "subject",
            "author": "author",
            "manager": "manager",
            "company": "company",
            "operator": "lastAuthor",
            "category": "category",
            "keywords": "keywords",
            "comment": "comments",
            "doccomm": "comments",
            "hlinkbase": "hyperlinkBase"
        };

        for (var rtfKey in fields) {
            var fieldName = fields[rtfKey];
            var regex = new RegExp("\\{\\\\(" + rtfKey + ")\\s+([^}]*)\\}", "i");
            var match = infoBlock.match(regex);
            if (match) {
                var val = match[2].trim();
                if (val) info[fieldName] = val;
            }
        }

        // Extract date fields: \creatim, \revtim, \printim
        var dateFields = {
            "creatim": "created",
            "revtim": "modified",
            "printim": "lastPrinted"
        };

        for (var dateKey in dateFields) {
            var dateName = dateFields[dateKey];
            var dateRegex = new RegExp("\\{\\\\(" + dateKey + ")[^}]*\\}", "i");
            var dateMatch = infoBlock.match(dateRegex);
            if (dateMatch) {
                var date = parseRtfDate(dateMatch[0]);
                if (date) info[dateName] = date;
            }
        }

        // Extract version/revision
        var versionMatch = infoBlock.match(/\{\\version(\d+)\}/);
        if (versionMatch) info.revision = versionMatch[1];

        var nofpagesMatch = infoBlock.match(/\{\\nofpages(\d+)\}/);
        if (nofpagesMatch) info.pageCount = parseInt(nofpagesMatch[1]);

        var nofwordsMatch = infoBlock.match(/\{\\nofwords(\d+)\}/);
        if (nofwordsMatch) info.wordCount = parseInt(nofwordsMatch[1]);

        var nofcharsMatch = infoBlock.match(/\{\\nofchars(\d+)\}/);
        if (nofcharsMatch) info.charCount = parseInt(nofcharsMatch[1]);

        var nofcharswsMatch = infoBlock.match(/\{\\nofcharsws(\d+)\}/);
        if (nofcharswsMatch) info.charCountWithSpaces = parseInt(nofcharswsMatch[1]);

        var edminsMatch = infoBlock.match(/\{\\edmins(\d+)\}/);
        if (edminsMatch) {
            var mins = parseInt(edminsMatch[1]);
            var hrs = Math.floor(mins / 60);
            var remMins = mins % 60;
            info.totalEditingTime = hrs > 0 ? (hrs + "h " + remMins + "m") : (mins + "m");
        }

        var idMatch = infoBlock.match(/\{\\id(\d+)\}/);
        if (idMatch) info.documentId = idMatch[1];

        // RTF version from header
        var rtfVersionMatch = text.match(/^\{\\rtf(\d+)/);
        if (rtfVersionMatch) info.rtfVersion = rtfVersionMatch[1];

        // Default language from header
        var deflangMatch = text.match(/\\deflang(\d+)/);
        if (deflangMatch) info.defaultLanguageId = deflangMatch[1];

        if (Object.keys(info).length === 0) return null;

        console.group("[Docucata:RTF] " + file.name);
        console.log("RTF metadata:", info);
        console.groupEnd();

        return info;
    } catch (e) {
        console.warn("[Docucata:RTF] Failed to parse " + file.name + ":", e);
        return null;
    }
}

/**
 * Parse an RTF date group like {\creatim\yr2023\mo10\dy15\hr14\min30\sec0}
 */
function parseRtfDate(dateStr) {
    var yr = dateStr.match(/\\yr(\d+)/);
    var mo = dateStr.match(/\\mo(\d+)/);
    var dy = dateStr.match(/\\dy(\d+)/);
    var hr = dateStr.match(/\\hr(\d+)/);
    var mn = dateStr.match(/\\min(\d+)/);
    var sec = dateStr.match(/\\sec(\d+)/);

    if (!yr) return null;

    try {
        var date = new Date(
            parseInt(yr[1]),
            mo ? parseInt(mo[1]) - 1 : 0,
            dy ? parseInt(dy[1]) : 1,
            hr ? parseInt(hr[1]) : 0,
            mn ? parseInt(mn[1]) : 0,
            sec ? parseInt(sec[1]) : 0
        );
        return date.toISOString();
    } catch (e) {
        return null;
    }
}
