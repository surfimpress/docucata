# Changelog

## 2026-03-18

### Adobe Creative Suite Support (AI, PSD, INDD)
- **Illustrator (.ai)**: Routed to PDF parser and pdf.js viewer — modern AI files (Illustrator 9+) are PDF-based internally. Full metadata extraction (title, author, creation date, page count, XMP) and visual preview via pdf.js canvas rendering
- **Photoshop (.psd/.psb)**: New parser `psdParser.js` — reads binary header (dimensions, channels, bit depth, color mode) and Image Resource Blocks for XMP metadata (0x0424), IPTC records (0x0404), resolution (0x03ED), and ICC profile name (0x040F). Handles PSB (large document) format via version detection
- **InDesign (.indd)**: New parser `inddParser.js` — scans for embedded XMP packet (`<?xpacket begin` marker) to extract Dublin Core fields (title, author, description, keywords), creation/modification dates, creator tool, and document IDs. Scans up to 4MB into the file
- **Shared XMP parser**: New `xmpParser.js` — regex-based XML parser (worker-safe, no DOMParser) extracts Dublin Core, XMP basic, XMP Media Management, Photoshop, and Illustrator-specific fields. `findXmpPacket()` locates XMP packets by scanning raw bytes. Reusable by any format with embedded XMP
- Added `indd` to `CATEGORY_MAP` as 'Document'; PSD magic byte (`8BPS`) detection added to `matchMagicBytes()`
- 23 new metadata keys added to `DEEP_META_CATALOG` across PSD and XMP source groups

### TIFF Preview Support
- TIFF files now render in the viewer via **UTIF.js** canvas decoding — cross-browser support for LZW, CMYK, 16-bit, and other TIFF variants that browsers can't display natively via `<img>`
- Added `tiff`/`tif` to `VIEWABLE_EXTS` and `IMAGE_EXTS` in the viewer
- UTIF.js loaded via CDN (`cdn.jsdelivr.net/npm/utif@3.1.0/UTIF.js`) — ~30KB UMD bundle
- TIFF metadata extraction (EXIF/GPS) was already supported — this change adds pixel rendering only

### Video Metadata & Preview (MP4, MOV, M4V)
- New parser: `js/parsers/videoParser.js` — ISO BMFF container box parsing
- Extracts: duration, dimensions, rotation, creation date (Mac epoch → ISO 8601), video/audio codec identification, major brand, track count, timescale
- Recursive box walker handles: `ftyp`, `moov/mvhd`, `trak/tkhd`, `mdia/hdlr`, `stbl/stsd`; supports 64-bit extended-size boxes
- Video viewer: native `<video>` player with metadata summary card (same pattern as audio viewer)
- WebM files are viewable via native `<video>` but don't get ISO BMFF metadata extraction (different container format)
- Video duration mapped to the `extent` field via `normalizeFields()`
- Magic byte detection: ISO BMFF `ftyp` signature at bytes 4–7, with HEIC brand disambiguation to avoid misclassifying HEIC images as video
- 12 video metadata keys added to `DEEP_META_CATALOG` for export mapping
- Video blob URLs cleaned up on viewer close (pause + revoke)

## 2026-03-14

### Web Worker Pool & Two-Tier Processing Pipeline
Major architectural refactoring for scale. Processing is now split into two tiers:

**Tier 1 — Capture (main thread, fast)**
- Files appear in the table within moments of being dropped
- `file.arrayBuffer()` read in parallel batches of 10 (`TIER1_CONCURRENCY`)
- Magic byte detection, skeleton metadata record with `_status: 'captured'`
- Immediately persisted to IDB file cache + batch metadata

**Tier 2 — Deep Processing (worker pool)**
- Full metadata extraction + excerpt generation runs in a pool of Web Workers
- Pool sized to `navigator.hardwareConcurrency` (clamped 2–6)
- ArrayBuffers transferred to workers via zero-copy `Transferable` objects
- Results stream back to main thread; table and IDB updated via debounced refresh (200ms) and save (1s)
- Status transitions: `captured → processing → complete | error`

**New files:**
- `js/workers/parserWorker.js` — module worker entry point; imports shared parsers, loads pdf.js via `import()` and SheetJS via `fetch()+eval()`
- `js/modules/workerPool.js` — pool manager with backpressure queue, crash recovery (1 retry + respawn), graceful shutdown
- `js/modules/pipelineManager.js` — two-tier orchestrator: `captureBatch()`, `processDeep()`, `resumeIncomplete()`

**Crash recovery & resilience:**
- Worker crash detected via `onerror`; task re-queued once, worker respawned
- On page reload, records with `_status !== 'complete'` are re-queued to Tier 2 automatically
- If a file's binary cache was LRU-evicted, record marked as `error` with a note to re-drop
- Falls back to sequential main-thread processing if module workers are unsupported

**Parser adaptations for worker safety:**
- `imageParser.js`: Binary dimension extraction from PNG IHDR, GIF header, BMP DIB, WebP VP8/VP8L/VP8X; new HEIC/HEIF ISOBMFF `ispe` box parser; new `parseImageMetadataFromBuffer()` export; DOM `Image` API now fallback only
- `audioParser.js`: New `parseAudioMetadataFromBuffer()` — binary tag parsers only (skips `AudioContext`); duration available for MP3, WAV, FLAC, OGG, AIFF from headers
- `exifParser.js`: New `parseExifMetadataFromBuffer(buffer, extension)` export
- `rtfParser.js`: Now accepts `File | ArrayBuffer` input
- `excerptExtractor.js`: New `extractExcerptFromBuffer()` — DOCX excerpts now use ZIP XML extraction (strips `word/document.xml` tags) instead of mammoth.js
- `officeParser.js`: `extractFileFromZip()` exported (was private); `parseOfficeMetadata()` accepts optional `extension` parameter
- All parsers (pdf, office, ole2, text, spreadsheet, docTextExtractor) now accept `File | ArrayBuffer` via `input instanceof ArrayBuffer` pattern

**Shared source refactoring:**
- `localProvider.js` gutted from 193-line sequential loop into two pure functions: `dispatchParsers(buffer, ext, category, fileSize)` and `normalizeFields(deepMeta)` — importable by both main thread and worker
- `metadataExtractor.js` rewritten as backward-compatible bridge using shared source
- `utils.js`: `detectFileType()` refactored — shared `matchMagicBytes()` + `detectZipSubtypeFromBuffer()` helpers; new `detectFileTypeFromBuffer(buffer)` export

**UI changes:**
- Table shows hourglass icon for records being analyzed, warning icon for errors
- Progress bar shows two phases: "Captured N of M" then "Analyzed N of M"
- `config.js` gains `WORKER_POOL_MIN/MAX`, `WORKER_SCRIPT`, `TIER1_CONCURRENCY`, CDN URL constants

## 2026-03-06

### Mapping Editor: Fallback Metadata Chains
- Map-from dropdowns now support unlimited fallback keys — press "+" to add more, "−" to remove
- Coalesce logic in `resolveExportMapping()`: tries the primary key first, then each fallback in order; first non-empty value wins
- Drag-and-drop reordering of all map-from rows (primary + fallbacks) via native HTML5 drag events
- Drag handle (⠿) on the left of each row; labels auto-update ("map from" → "or") after reorder
- `field.metadataFallbacks` array stored alongside `field.metadataKey` (backwards compatible)
- `duplicateMapping()` deep-clones fallback arrays

### Mapping Editor: Custom Fields & Fixed Value Mode
- "+" Add custom field" button below the field table — creates `custom_01`, `custom_02`, etc. (zero-padded, auto-incrementing)
- Custom fields support all modes: no change, name change, map metadata, fixed value
- Custom fields have a ✕ delete button (visible on hover) in the Default Label cell
- New mode: **fixed value** — user enters constant text that fills all exported rows for that column
- Fixed value input appears in the Map From column when mode is "fixed value", with green border accent
- Deep Metadata field is now locked — Action dropdown and Export Label are greyed out and disabled; only the Include checkbox is functional

### Excerpt Extraction: Newline Fixes
- **PDF**: Replaced `items.map(item => item.str).join('')` with proper line reconstruction using `item.hasEOL` and Y-coordinate delta detection from `item.transform[5]`. Gaps > 1.5× line height produce paragraph breaks (`\n\n`); smaller gaps produce line breaks (`\n`)
- **RTF**: Fixed false newline injection — the old `next === 'n'` match fired on every RTF keyword starting with "n" (e.g. `\nosupersub`, `\nowidctlpar`). Now only `\par` and `\line` emit newlines, with word-boundary guards to prevent matching longer keywords like `\pard`

### DOCX Deep Metadata Fix
- Rewrote `officeParser.js:extractFileFromZip()` to use the ZIP **Central Directory** instead of walking local file headers
- Fixes DOCX files with data descriptor flags (bit 3 set) where local headers have `compressedSize=0` — common in files generated by Google Docs, Apache POI, and other streaming ZIP writers
- Central Directory always has correct sizes; local header offset is used to locate actual compressed data
- Scan backwards from end of file to find EOCD record (supports ZIP comments up to 65535 bytes)

## 2026-03-05 (cont. 3)

### Export Mapping System
- New module: `js/modules/mappingManager.js` — full CRUD for named export mappings stored in localStorage (`docucata_mappings`)
- New module: `js/modules/mappingEditor.js` — modal editor for mapping fields
- Each mapping contains ordered field configs with: `key`, `defaultLabel`, `customLabel`, `included` (boolean), `mode` (`no change` | `name change` | `map metadata`), and `metadataKey`
- Mapping selector dropdown in the header bar — switch between Default and custom mappings
- Dropdown actions per mapping: Edit (pencil), Rename, Duplicate, Delete
- "New mapping..." button creates a mapping with all 16 default fields included
- **Mapping editor modal** — 5-column table:
  - **Include**: checkbox to include/exclude field from export
  - **Default Label**: read-only original field name
  - **Action**: dropdown with three modes — "no change", "name change", "map metadata"
  - **Export Label**: editable text input for custom column name (disabled when "no change")
  - **Map From**: dropdown of 120+ deep metadata keys grouped by source (PDF, Office, DOC, Sheet, Image, EXIF, GPS, Audio, RTF, Text) — visible only when mode is "map metadata"
- Auto-mode detection: typing in the export label auto-toggles between "no change" and "name change"
- Double-click export label to reset to default
- Excluded rows shown at reduced opacity; "map metadata" rows highlighted with blue accent
- `DEEP_META_CATALOG` constant: 120+ metadata keys across 10 source groups, used for the map-from `<optgroup>` dropdown
- `resolveExportMapping()` returns `{ headers, rowBuilder }` — the single bridge between mappings and exporters
- Both `exportToCsv()` and `exportToJson()` rewritten to consume `resolveExportMapping()` instead of hardcoded headers
- Active mapping stored in `docucata_active_mapping` localStorage key

## 2026-03-05 (cont. 2)

### Word for Macintosh 4.0 Support
- Added magic byte detection for pre-OLE2 Word for Mac 4.0 files (signature: `FE 37 00 1C`)
- New `extractWordForMac4()` text extractor in docTextExtractor.js — reads text directly from the file body (256-byte header, then plain text with `\r` line endings)
- Includes Mac Roman character decoding for accented characters common in pre-OS X files
- Extensionless files from old Mac archives are now identified and their text extracted

### OLE2 Mini Stream Support
- Fixed reading of streams smaller than the mini stream cutoff (typically 4096 bytes)
- Previously, small streams (stored in 64-byte mini sectors inside the Root Entry) were read from the wrong offset, producing garbage or no data
- Added `buildMiniStreamContext()` and `readMiniStreamData()` to both `docTextExtractor.js` and `ole2Parser.js`
- Fixes text extraction and metadata reading for small OLE2 files like Word 6.0/95 documents (e.g. BOGUSKY.DOC)
- `readStream()` now accepts an optional `miniCtx` parameter and automatically routes to mini stream reading when appropriate

### Export Menu (CSV + JSON)
- Replaced "Export CSV" button with an "Export ▾" dropdown menu
- Added JSON export (`exportToJson`) — outputs clean metadata (strips internal `_file`, `_seq` fields)
- Dropdown shows "Export CSV" and "Export JSON" options
- Menu closes on outside click

### ZIP: Skip macOS/Windows Artifacts
- ZIP extraction now skips OS-generated junk files: `__MACOSX/` folder, `._*` resource forks, `.DS_Store`, `Thumbs.db`, `desktop.ini`
- Skipped entries logged as `[skip] OS artifact` in the console

## 2026-03-05 (cont.)

### Legacy .doc Text Extraction & Preview
- New parser: `js/parsers/docTextExtractor.js` — extracts readable text from Word Binary (.doc) files
- Two-tier strategy: piece table extraction first (accurate, reads the FIB → Table stream → CLX → PlcPcd), falls back to scanning for printable character runs
- Handles both ANSI (compressed) and Unicode piece descriptors
- Decodes Word special characters: paragraph marks, line breaks, tabs, page breaks, cell marks, non-breaking spaces/hyphens
- Viewer shows extracted text in a `<pre>` block (plain text, no formatting — full Word formatting would require a massive parser)
- Added `doc` to VIEWABLE_EXTS in tableRenderer.js for the eye/view button
- Excerpt extraction also supports .doc via the same module
- OLE2 infrastructure (FAT chain, directory entries, stream reading) duplicated from ole2Parser.js for module independence

### Text Excerpt Extraction
- New module: `js/modules/excerptExtractor.js` — extracts readable text from files, capped at 100 KB (`MAX_EXCERPT_BYTES` in config.js)
- Supported formats: plain text/code files (direct read), PDF (pdf.js `getTextContent()`), DOCX (mammoth.js `extractRawText()`), DOC (OLE2 piece table), RTF (control code stripping), spreadsheets (SheetJS `sheet_to_csv()`)
- Excerpt stored on `item.excerpt` field, persisted with metadata in IndexedDB
- New "Excerpt" column in Grid.js table (hidden by default, togglable via column selector)
- Table shows first 200 characters with ellipsis; full text stored for CSV export
- CSV export includes full Excerpt column between Notes and Deep Metadata
- `stripRtf()` function extracted from `fileViewer.js` into shared `excerptExtractor.js` to avoid duplication
- Spreadsheet excerpts use CSV format with `--- SheetName ---` separators for multi-sheet workbooks

### IndexedDB Metadata Storage
- Migrated per-batch metadata from localStorage to IndexedDB (hybrid approach)
- Batch registry (tiny) stays in localStorage for synchronous startup
- Per-batch metadata arrays (potentially large) now stored in IndexedDB with no practical size limit
- All metadata functions (`saveBatchMetadata`, `loadBatchMetadata`, `clearBatchMetadata`, `deleteBatch`) are now async
- One-time migration: existing localStorage `docucata_meta_*` keys automatically moved to IndexedDB on first load, then removed from localStorage
- `getLocalStorageUsage()` replaced with async `getStorageUsage()` that measures both localStorage registry and IndexedDB metadata
- IndexedDB database: `docucata_db`, object store: `batch_metadata`, keyed by batch ID

### Cell Editing Fix
- Fixed bug where editing a cell would update the wrong field (the column to the left)
- Root cause: `COL_FIELD_MAP` was an array assuming all columns are visible, but hidden columns (MIME Type, Source) shifted the DOM column indices
- Fix: `tableRenderer.js` now resolves the field ID from `getVisibleColumns()` and passes it to the callback instead of a raw column index
- `COL_FIELD_MAP` in `app.js` changed from array to object keyed by column ID

### PDF Viewer Scroll Fix
- Fixed PDF files not being scrollable in the viewer modal
- Root cause: nested flex containers lacked proper height constraints — `.viewer-body` had `height: 100%` which doesn't resolve in a flex context, and `.viewer-body-wrap` had `min-height: 50vh` preventing shrink
- Fix: applied `flex: 1 1 0` + `min-height: 0` at both `.viewer-body-wrap` and `.viewer-body` levels, with `display: flex; flex-direction: column` on the wrap to propagate the constraint chain

### PDF Metadata via pdf.js
- Rewrote `pdfParser.js` to use pdf.js as the primary metadata extraction method
- pdf.js properly decompresses object streams, solving the problem where modern PDFs (with FlateDecode-compressed info dictionaries) returned no metadata from regex scanning
- Extracts: Info dictionary fields (Title, Author, Subject, Keywords, Creator, Producer, dates, Trapped), structural flags (IsLinearized, IsAcroFormPresent, IsXFAPresent, IsSignaturesPresent, IsEncrypted), page count, Custom info dict entries, and full XMP metadata
- Falls back to regex-based raw byte scanning for environments where pdf.js isn't loaded
- PDF/A conformance combined from `pdfaid:part` + `pdfaid:conformance` into readable string (e.g. "PDF/A-1b")

### In-Page Dialog System
- Replaced all native `alert()`, `confirm()`, `prompt()` calls with in-page modal dialogs
- New module: `js/modules/dialog.js` — promise-based, supports alert/confirm/prompt/danger modes
- Danger mode (delete file, delete batch, clear all) uses red confirm button for visual severity
- Keyboard accessible: Enter to confirm, Escape to cancel, auto-focus on input or confirm button
- Styled consistently with app theme (border-radius, colors, shadows, backdrop blur)

### Spreadsheet Viewer & Deep Metadata (SheetJS)
- Added SheetJS (xlsx) library via CDN for spreadsheet parsing and viewing
- New parser: `js/parsers/spreadsheetParser.js` — extracts sheet-level structural metadata:
  - Sheet names/count, named ranges, per-sheet dimensions and cell counts
  - Formula count and data type distribution (numbers, strings, dates, booleans)
  - Merged cell regions, hidden sheets, auto-filter presence
  - Custom properties from workbook
- Spreadsheet viewer in file modal: renders sheets as HTML tables with tab navigation
  - Sheet tabs with active state highlighting, hidden sheet indicator
  - Sticky header row, striped rows, hover highlighting, cell truncation
- Supports xlsx, xls, ods, and csv formats

### Audio Metadata Parser & Player
- New parser: `js/parsers/audioParser.js` — comprehensive audio metadata extraction:
  - MP3: ID3v2 (v2.3/v2.4) tags with 25+ fields (title, artist, album, composer, BPM, ISRC, etc.), ID3v1 fallback, MPEG frame header (version, layer, bitrate, sample rate, channel mode)
  - WAV: RIFF header (format, channels, sample rate, bits per sample), LIST-INFO metadata
  - FLAC: STREAMINFO (sample rate, channels, bits per sample, duration), Vorbis comments
  - OGG Vorbis: identification header, Vorbis comments with 25+ mapped fields
  - AIFF: COMM chunk (channels, sample rate, bits per sample, duration via IEEE 80-bit float parsing)
  - Web Audio API fallback for duration/channels on any browser-supported format
  - Bitrate estimation from file size and duration
  - Album art presence detection (ID3v2 APIC, FLAC PICTURE)
- Audio viewer: native `<audio>` player with metadata summary card below
- Viewer cleans up audio blob URLs and pauses playback on close

### RTF Parser Expansion
- Added character count (`\nofchars`), characters with spaces (`\nofcharsws`)
- Added total editing time (`\edmins`) displayed as human-readable duration
- Added document ID (`\id`), RTF version from header, default language ID

### Text File Analyzer
- New parser: `js/parsers/textParser.js` — derives structural properties from plain text files
- Encoding detection: UTF-8 (with BOM detection), UTF-16 LE/BE, ASCII, ISO-8859-1 fallback
- Line ending style: CRLF (Windows), LF (Unix/macOS), CR (Classic Mac)
- Content statistics: line count, word count, character count (with and without spaces)
- Non-ASCII byte detection with percentage, longest line length
- Null byte detection for binary content identification
- Supported extensions: txt, md, log, csv, ini, cfg, yaml, yml, toml

### Expanded Metadata Capture — Archive-Complete Coverage
- **PDF parser**: added Linearized (fast web view) flag, Trapped status from both info dict and regex scan, PDF/A conformance level from XMP (`pdfaid:part` + `pdfaid:conformance` combined into e.g. "PDF/A-1b"), XMP rights fields, language, format, document/instance IDs, label, rating, color mode
- **Office OOXML parser**: added `docProps/custom.xml` parsing for user-defined custom properties (key-value pairs used by organizations for document management), plus `app.xml` fields: HiddenSlides, PresentationFormat, SharedDoc, HyperlinksChanged, LinksUpToDate, ScaleCrop, DocSecurity
- **OLE2 legacy parser**: added SummaryInformation PIDs: editTime (displayed as human-readable duration), lastPrinted, security; added DocumentSummaryInformation PIDs: byteCount, lineCount, paragraphCount, slideCount, noteCount, hiddenSlideCount, contentType, contentStatus, language

## 2026-03-05

### File Viewer — Spinner Fix
- Fixed PDF viewer loading spinner not being visible to the user
- Root cause: spinner HTML was injected into `.viewer-body`, which `renderPdf()` immediately cleared with `innerHTML = ''` before rendering pages
- Solution: moved spinner to a persistent DOM element (`.viewer-loading`) as a sibling overlay inside a new `.viewer-body-wrap` container
- Spinner now uses `position: absolute; inset: 0` to overlay the content area independently
- Show/hide controlled via `.hidden` CSS class with a 0.2s opacity fade-out
- `closeViewer()` resets spinner to visible state for the next open

### Batch System
- Added batch management for organizing files into named groups
- New module: `js/modules/batchManager.js` with full CRUD operations
- Each batch stores its metadata in its own localStorage key (`docucata_meta_<batchId>`)
- Batch dropdown UI in the toolbar (left side, above the table) with:
  - "New batch..." button with in-page dialog for naming (default: `batch-YYYY-MM-DD`)
  - List of existing batches — click to switch
  - Rename button (pencil icon) visible on hover per batch row
  - Delete button (trash icon) visible on hover per batch row
- Deletion safety checks:
  - If batch has never been exported to CSV, warns user and offers to export first
  - If files have been added since the last CSV export, warns about unexported data
  - Final confirmation prompt before deletion proceeds
- CSV export tracking: each export records the date and file count on the batch record
- Legacy migration: existing data in `docucata_metadata` is automatically migrated into a batch named "Imported" on first load
- Removed "Save to Storage" and "Load from Storage" buttons (auto-save handles persistence)
- Auto-save now writes to the active batch's storage key

### Column Selector Relocation
- Moved the column toggle from the toolbar into the Grid.js search bar row
- Changed from a text button ("Columns") to an icon-only button (grid icon) with `title` and `aria-label` for accessibility
- Uses a `MutationObserver` to detect when Grid.js renders, then injects the button next to the search input
- Renamed API: `initColumnSelector(container)` → `createColumnSelector()` which returns a detached DOM element
- Dropdown now opens from the left instead of the right

### File Ordering — Newest First
- New files are now prepended (displayed first) in the table rather than appended
- Implemented via a sequential `_seq` counter assigned to each file on arrival
- Table displays files sorted by `_seq` descending (highest/newest first)
- `_seq` persists across sessions (saved to localStorage, only `_file` is stripped)
- `computeNextSeq()` restores the counter from existing metadata on batch load

### CSV Export Return Value
- `exportToCsv()` now returns the number of files exported (was `void`)
- Used by the batch system to record export file counts for deletion safety checks

---

## Earlier (pre-changelog)

### Core Application
- Built Docucata as a pure static web app for file metadata extraction
- ES modules architecture with no build step, no frameworks
- Provider pattern for pluggable data sources (local files now, SharePoint later)
- Grid.js table with sorting, search, pagination, resizable columns
- Drag-and-drop + file picker for file input with recursive folder traversal
- localStorage persistence with merge/dedup by deterministic file ID
- CSV export (RFC 4180 compliant)

### OLE2 Parser
- Full rewrite of `js/parsers/ole2Parser.js` for legacy `.doc`/`.xls`/`.ppt` files
- Proper FAT chain traversal instead of direct sector offset assumptions
- Extracts SummaryInformation and DocumentSummaryInformation property streams
- Fields: title, subject, author, keywords, comments, category, manager, company, etc.

### Deep Metadata & Expandable Rows
- Grid.js detail rows injected via DOM manipulation (Grid.js lacks native sub-rows)
- Consolidated view, metadata, and unpack actions into a single actions column
- SVG icon buttons: eye (view), document (metadata), folder+arrow (unpack)

### File Viewer Modal
- Modal overlay for viewing files: PDFs (pdf.js canvas rendering), images (object URL), text/code (pre block)
- pdf.js loaded as ES module from CDN
- Close via button, backdrop click, or Escape key

### User-Editable Notes Column
- "Notes" column added to Grid.js and CSV export
- Inline editing via `contenteditable` on double-click
- Notes preserved during merge (existing notes kept when re-dropping files)
- ZIP unpack replicates parent archive's notes to extracted files

### IndexedDB File Cache
- `js/modules/fileCache.js` — binary file caching with IndexedDB
- Files persist across page reloads for viewing and unpacking
- Skip-already-cached writes, orphan cleanup on startup
- 500MB LRU eviction cap with `cachedAt` timestamps
- Lazy single-file loading via `loadSingleFile()` for on-demand restoration
- Cache size and count displayed in toolbar
- "Clear Previews" button to wipe cached blobs while keeping metadata
- Fixed critical IndexedDB transaction auto-commit bug (pre-read all ArrayBuffers before write transactions, fire all get requests synchronously)

### ZIP Archive Support
- `js/parsers/zipHandler.js` for extracting ZIP contents
- "Unpack" button on archive rows to extract and add contents to the table
