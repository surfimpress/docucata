/**
 * Extract deep structural metadata from spreadsheet files using SheetJS.
 * Captures sheet-level data that our generic officeParser.js cannot reach:
 * sheet names, dimensions, cell/formula/merge counts, hidden sheets, named ranges, etc.
 *
 * @param {File} file
 * @returns {Promise<Object|null>} Structural metadata or null
 */
export async function parseSpreadsheetMetadata(input) {
    if (typeof XLSX === 'undefined') return null;

    try {
        const buffer = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
        const wb = XLSX.read(buffer, { type: 'array', cellFormula: true, cellStyles: true });

        const info = {};

        // Workbook-level properties
        if (wb.Props) {
            const p = wb.Props;
            if (p.Title) info.title = p.Title;
            if (p.Subject) info.subject = p.Subject;
            if (p.Author) info.author = p.Author;
            if (p.Manager) info.manager = p.Manager;
            if (p.Company) info.company = p.Company;
            if (p.Category) info.category = p.Category;
            if (p.Keywords) info.keywords = p.Keywords;
            if (p.Comments) info.comments = p.Comments;
            if (p.LastAuthor) info.lastAuthor = p.LastAuthor;
            if (p.CreatedDate) info.created = new Date(p.CreatedDate).toISOString();
            if (p.ModifiedDate) info.modified = new Date(p.ModifiedDate).toISOString();
            if (p.Application) info.application = p.Application;
            if (p.AppVersion) info.appVersion = p.AppVersion;
            if (p.ContentStatus) info.contentStatus = p.ContentStatus;
            if (p.Identifier) info.identifier = p.Identifier;
            if (p.Language) info.language = p.Language;
            if (p.Revision) info.revision = p.Revision;
            if (p.Version) info.version = p.Version;
            if (p.Description) info.description = p.Description;
        }

        // Custom properties
        if (wb.Custprops && Object.keys(wb.Custprops).length > 0) {
            info.customProperties = { ...wb.Custprops };
        }

        // Sheet structure
        info.sheetCount = wb.SheetNames.length;
        info.sheetNames = wb.SheetNames.join(', ');

        // Named ranges / defined names
        if (wb.Workbook?.Names?.length) {
            info.namedRanges = wb.Workbook.Names
                .filter(n => !n.Name.startsWith('_'))
                .map(n => n.Name)
                .join(', ');
            info.namedRangeCount = wb.Workbook.Names.filter(n => !n.Name.startsWith('_')).length;
        }

        // Per-sheet analysis
        const sheetDetails = [];
        let totalCells = 0;
        let totalFormulas = 0;
        let totalMerges = 0;
        const hiddenSheets = [];

        for (let i = 0; i < wb.SheetNames.length; i++) {
            const name = wb.SheetNames[i];
            const ws = wb.Sheets[name];
            if (!ws) continue;

            const detail = { name };

            // Dimensions (used range)
            const ref = ws['!ref'];
            if (ref) {
                detail.range = ref;
                const range = XLSX.utils.decode_range(ref);
                detail.rows = range.e.r - range.s.r + 1;
                detail.cols = range.e.c - range.s.c + 1;
                detail.cellCapacity = detail.rows * detail.cols;
            }

            // Count actual populated cells and formulas
            let cellCount = 0;
            let formulaCount = 0;
            const typeDistribution = {};

            for (const addr of Object.keys(ws)) {
                if (addr.startsWith('!')) continue; // skip metadata keys
                cellCount++;
                const cell = ws[addr];
                if (cell.f) formulaCount++;
                const typeName = { b: 'boolean', n: 'number', s: 'string', d: 'date', e: 'error' }[cell.t] || 'other';
                typeDistribution[typeName] = (typeDistribution[typeName] || 0) + 1;
            }

            detail.populatedCells = cellCount;
            detail.formulas = formulaCount;
            detail.dataTypes = typeDistribution;
            totalCells += cellCount;
            totalFormulas += formulaCount;

            // Merged cells
            if (ws['!merges']?.length) {
                detail.mergedRegions = ws['!merges'].length;
                totalMerges += ws['!merges'].length;
            }

            // Hidden state
            if (wb.Workbook?.Sheets?.[i]?.Hidden) {
                const hidden = wb.Workbook.Sheets[i].Hidden;
                detail.hidden = hidden === 1 ? 'hidden' : hidden === 2 ? 'very hidden' : false;
                if (detail.hidden) hiddenSheets.push(name);
            }

            // AutoFilter
            if (ws['!autofilter']) {
                detail.hasAutoFilter = true;
            }

            sheetDetails.push(detail);
        }

        info.totalPopulatedCells = totalCells;
        info.totalFormulas = totalFormulas;
        if (totalMerges > 0) info.totalMergedRegions = totalMerges;
        if (hiddenSheets.length > 0) info.hiddenSheets = hiddenSheets.join(', ');

        // Build a readable per-sheet summary
        info.sheetSummary = sheetDetails.map(d => {
            const parts = [d.name];
            if (d.range) parts.push(`${d.rows}×${d.cols}`);
            parts.push(`${d.populatedCells} cells`);
            if (d.formulas > 0) parts.push(`${d.formulas} formulas`);
            if (d.hidden) parts.push(`(${d.hidden})`);
            return parts.join(' — ');
        }).join(' | ');

        // Data type summary across all sheets
        const allTypes = {};
        for (const d of sheetDetails) {
            for (const [t, c] of Object.entries(d.dataTypes || {})) {
                allTypes[t] = (allTypes[t] || 0) + c;
            }
        }
        if (Object.keys(allTypes).length > 0) {
            info.dataTypes = Object.entries(allTypes)
                .sort((a, b) => b[1] - a[1])
                .map(([t, c]) => `${t}: ${c}`)
                .join(', ');
        }

        console.group(`[Docucata:Spreadsheet] ${(input instanceof ArrayBuffer ? '(buffer)' : input.name)}`);
        console.log('Sheet metadata:', info);
        console.log('Sheet details:', sheetDetails);
        console.groupEnd();

        return info;
    } catch (e) {
        console.warn(`[Docucata:Spreadsheet] Failed to parse ${(input instanceof ArrayBuffer ? '(buffer)' : input.name)}:`, e);
        return null;
    }
}
