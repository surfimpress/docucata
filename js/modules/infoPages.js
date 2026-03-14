/**
 * Info Pages — About and Guide modal content.
 *
 * Content is stored as markdown and converted to HTML via a lightweight
 * parser (no external dependency). The modal is shared between both pages.
 */

let modalEl = null;

function getModal() {
    if (!modalEl) {
        modalEl = document.getElementById('infoModal');
    }
    return modalEl;
}

// ── Markdown → HTML (minimal, covers our content) ─────────

/**
 * Convert a subset of Markdown to HTML.
 * Supports: headings (##), bold (**), italic (*), inline code (`),
 * unordered lists (- ), ordered lists (1. ), paragraphs, and horizontal rules (---).
 */
function markdownToHtml(md) {
    const lines = md.split('\n');
    const out = [];
    let inUl = false;
    let inOl = false;

    function closeLists() {
        if (inUl) { out.push('</ul>'); inUl = false; }
        if (inOl) { out.push('</ol>'); inOl = false; }
    }

    function inlineFormat(text) {
        // Escape HTML entities
        text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        // Inline code
        text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
        // Bold
        text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        // Italic (single *)
        text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
        return text;
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Blank line → close lists, skip
        if (line.trim() === '') {
            closeLists();
            continue;
        }

        // Horizontal rule
        if (/^---+$/.test(line.trim())) {
            closeLists();
            out.push('<hr>');
            continue;
        }

        // Headings
        const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
        if (headingMatch) {
            closeLists();
            const level = headingMatch[1].length;
            out.push(`<h${level}>${inlineFormat(headingMatch[2])}</h${level}>`);
            continue;
        }

        // Unordered list item
        const ulMatch = line.match(/^[-*]\s+(.+)$/);
        if (ulMatch) {
            if (inOl) { out.push('</ol>'); inOl = false; }
            if (!inUl) { out.push('<ul>'); inUl = true; }
            out.push(`<li>${inlineFormat(ulMatch[1])}</li>`);
            continue;
        }

        // Ordered list item
        const olMatch = line.match(/^\d+\.\s+(.+)$/);
        if (olMatch) {
            if (inUl) { out.push('</ul>'); inUl = false; }
            if (!inOl) { out.push('<ol>'); inOl = true; }
            out.push(`<li>${inlineFormat(olMatch[1])}</li>`);
            continue;
        }

        // Paragraph
        closeLists();
        out.push(`<p>${inlineFormat(line)}</p>`);
    }

    closeLists();
    return out.join('\n');
}

// ── Content ───────────────────────────────────────────────

const ABOUT_MD = `## What is Docucata?

Docucata is a tool for extracting, viewing, and exporting metadata from your files — documents, images, audio, spreadsheets, and more.

It was built for people who work with collections of files and need to capture structured information about them: archivists, librarians, records managers, digital preservation specialists, and anyone who needs to know what's inside a set of files without opening each one individually.

## Your files never leave your computer

**Docucata runs entirely in your web browser.** There is no server, no cloud service, and no internet connection required once the page has loaded. When you drop files into Docucata:

- The files are read directly by your browser on your own machine
- No data is uploaded, transmitted, or shared with any external service
- All metadata extraction, viewing, and export happens locally
- Your files and their metadata stay on your computer at all times

This makes Docucata suitable for working with sensitive, restricted, or unpublished materials where data sovereignty matters.

## How it works

Docucata reads the internal structure of your files to extract metadata that isn't visible from the file name or folder alone — things like author, creation date, page count, image dimensions, audio duration, software used to create the file, and much more.

It supports over 30 file formats across documents (PDF, Word, Excel, PowerPoint, RTF), images (JPEG, TIFF, PNG, and others), audio files (MP3, WAV, FLAC, and others), and plain text files.

The results are displayed in a searchable, sortable table. You can organise files into batches, customise which columns appear in your export, and download the results as CSV or JSON for use in spreadsheets, databases, or other systems.

## No installation required

Docucata is a single web page with no software to install. It works in any modern web browser (Chrome, Firefox, Safari, Edge). Just open it and start working.`;

const GUIDE_MD = `## Getting started

### 1. Add your files

There are two ways to add files to Docucata:

- **Drag and drop** files or folders directly onto the drop zone at the top of the page
- **Click "Browse Files"** to use your system's file picker

You can add files in any combination — individual files, multiple files at once, entire folders, or ZIP archives. Docucata will process each file and extract its metadata automatically.

### 2. Review the results

Once files are processed, they appear in the table below the drop zone. Each row represents one file, with columns for:

- **Name, Path, Category, Extension** — basic file identity
- **Size, Last Modified, Created** — file system information
- **Author, Title** — document-level metadata (when available)
- **Notes** — a free-text field you can edit (double-click any cell to type)
- **Excerpt** — a text preview of the file's content (when available)

### 3. View detailed metadata

Each file row has action buttons on the right:

- **Eye icon** — opens a preview of the file (PDFs, images, spreadsheets, audio, and text files)
- **Document icon** — expands a detail panel showing all extracted metadata fields for that file

The detail panel shows "deep metadata" — the full set of internal properties found in the file, which varies by format.

### 4. Organise files into batches

Use the **Batch** dropdown (above the table on the left) to group your work:

- Click **"New batch..."** to create a named batch
- Switch between batches by clicking their names in the dropdown
- Rename or delete batches using the icons that appear when you hover

Batches keep your sessions separate. Each batch remembers its own set of files and metadata.

### 5. Customise your export

Use the **Mapping** dropdown (in the top-right header) to control what appears in your export:

- **Default** exports all standard columns with their original names
- Click **"New mapping..."** to create a custom mapping
- In the mapping editor, you can:
  - **Include/exclude** columns using the checkboxes
  - **Rename** columns by changing the Export Label
  - **Map metadata** to pull a specific deep metadata field into a standard column
  - **Set a fixed value** that fills every row (useful for project codes or identifiers)
  - **Prepend or append** text to any column's values (useful for adding path prefixes or suffixes)
  - **Add custom fields** for additional columns not in the default set

### 6. Export your data

Click the **"Export"** button (top-right of the table area) and choose:

- **Export CSV** — a comma-separated file that opens in Excel, Google Sheets, or any spreadsheet application
- **Export JSON** — a structured data format for use in databases, scripts, or other software

The export uses whichever mapping is currently selected. Your file is downloaded directly to your computer.

---

## Tips

- **ZIP archives** can be unpacked in place — click the folder icon on a ZIP row to extract its contents into the table
- **Column visibility** can be toggled using the grid icon next to the search bar
- **Double-click** any cell in the Name, Path, Author, Title, or Notes columns to edit it directly
- **Files are cached** in your browser so you can preview them again without re-adding. Use "Clear Previews" to free up space
- **Search** using the search bar above the table to filter across all visible columns`;

// ── Public API ────────────────────────────────────────────

/**
 * Initialise the info modal: wire close handlers.
 */
export function initInfoPages() {
    const modal = getModal();
    if (!modal) return;

    modal.querySelector('.info-modal-close').addEventListener('click', closeInfoModal);
    modal.querySelector('.info-modal-backdrop').addEventListener('click', closeInfoModal);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('open')) {
            closeInfoModal();
        }
    });
}

/**
 * Open the info modal with the About content.
 */
export function showAbout() {
    openInfoModal('About Docucata', ABOUT_MD);
}

/**
 * Open the info modal with the Guide content.
 */
export function showGuide() {
    openInfoModal('User Guide', GUIDE_MD);
}

function openInfoModal(title, markdown) {
    const modal = getModal();
    modal.querySelector('.info-modal-title').textContent = title;
    modal.querySelector('.info-modal-body').innerHTML = markdownToHtml(markdown);
    modal.classList.add('open');
}

function closeInfoModal() {
    const modal = getModal();
    modal.classList.remove('open');
}
