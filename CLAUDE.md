# Docucata

Pure static web app for extracting and exporting file metadata. Runs entirely in the browser — no build step, no frameworks, no server-side code. Served by Apache at `http://localhost/docucata/`.

## Architecture

- **ES modules** (`type="module"`) with no bundler — all imports are relative paths
- **Two-tier processing pipeline**: Tier 1 (capture) runs on main thread for instant UI feedback; Tier 2 (deep metadata extraction) runs in a Web Worker pool for parallelism
- **Worker pool**: 2–6 module workers share parser code with the main thread via ES module imports. Libraries loaded in workers: pdf.js via `import()`, SheetJS via `fetch()+eval()`
- **Shared source pattern**: `localProvider.js` exports pure, DOM-free functions (`dispatchParsers`, `normalizeFields`) importable by both main thread and workers — no code duplication
- **Provider pattern**: data sources are pluggable (`js/providers/localProvider.js` for local files; SharePoint planned)
- **Grid.js** for the data table (loaded via CDN UMD bundle)
- **pdf.js** for PDF rendering and metadata extraction (CDN ES module)
- **SheetJS (xlsx)** for spreadsheet viewing and deep metadata (CDN script)
- **No other external dependencies** — all other parsers are hand-written binary parsers

## Project Structure

```
docucata/
├── index.html                     # Single-page app shell
├── css/styles.css                 # All styling — CSS custom properties, light theme
├── js/
│   ├── app.js                     # Entry point — wires modules to DOM, batch UI, state, pipeline init
│   ├── modules/
│   │   ├── utils.js               # formatBytes, formatDate, generateFileId, classifyFile, detectFileTypeFromBuffer
│   │   ├── fileHandler.js         # Drag-and-drop + file picker (recursive folder traversal)
│   │   ├── metadataExtractor.js   # Backward-compatible bridge to shared source (used by unpack flow)
│   │   ├── pipelineManager.js     # Two-tier orchestrator: captureBatch, processDeep, resumeIncomplete
│   │   ├── workerPool.js          # Worker pool manager: spawn, queue, dispatch, crash recovery
│   │   ├── tableRenderer.js       # Grid.js table, column selector, detail panels, actions, status indicators
│   │   ├── storage.js             # localStorage merge/dedup helpers
│   │   ├── csvExport.js           # CSV + JSON export with download trigger
│   │   ├── batchManager.js        # Batch CRUD, IndexedDB metadata, export safety
│   │   ├── fileCache.js           # IndexedDB binary cache (500MB LRU cap)
│   │   ├── fileViewer.js          # Modal viewer: PDF, spreadsheet, image, audio, text
│   │   ├── config.js              # Centralised constants (excerpt cap, page size, cache limit, worker pool, CDN URLs)
│   │   ├── excerptExtractor.js    # Text excerpt extraction for all readable formats (File + ArrayBuffer)
│   │   ├── dialog.js              # In-page dialog system (replaces alert/confirm/prompt)
│   │   ├── mappingManager.js      # Export mapping CRUD, active mapping, resolveExportMapping()
│   │   ├── mappingEditor.js       # Modal editor for mapping fields (include/action/label/map-from)
│   │   └── infoPages.js           # About and Guide modal pages (markdown → HTML renderer)
│   ├── providers/
│   │   └── localProvider.js       # Shared source: dispatchParsers() + normalizeFields() (worker-safe)
│   ├── workers/
│   │   └── parserWorker.js        # Module worker entry point — imports shared parsers, loads CDN libs
│   └── parsers/
│       ├── pdfParser.js           # PDF metadata via pdf.js + regex fallback (File | ArrayBuffer)
│       ├── officeParser.js        # DOCX/XLSX/PPTX (docProps XML) + ODF (File | ArrayBuffer)
│       ├── ole2Parser.js          # Legacy .doc/.xls/.ppt (OLE2 binary format) (File | ArrayBuffer)
│       ├── spreadsheetParser.js   # Sheet-level metadata via SheetJS (File | ArrayBuffer)
│       ├── imageParser.js         # Universal image metadata — binary dimensions + DOM fallback
│       ├── exifParser.js          # EXIF/GPS/IFD tag parsing for JPEG/TIFF (File | ArrayBuffer)
│       ├── audioParser.js         # MP3 (ID3v1/v2), WAV, FLAC, OGG, AIFF (File | ArrayBuffer)
│       ├── rtfParser.js           # RTF \info group parsing (File | ArrayBuffer)
│       ├── textParser.js          # Plain text encoding/stats analysis (File | ArrayBuffer)
│       ├── docTextExtractor.js    # .doc text extraction (OLE2 piece table + Word for Mac 4.0)
│       └── zipHandler.js          # ZIP extraction with OS artifact filtering
├── CHANGELOG.md
└── requirement.md
```

## Key Patterns

- **Two-tier pipeline**: Files drop → Tier 1 (`pipelineManager.captureBatch`) reads `arrayBuffer()` in parallel, builds skeleton records with `_status: 'captured'`, renders in table immediately → Tier 2 (`pipelineManager.processDeep`) enqueues to worker pool, results stream back via callbacks, records updated to `_status: 'complete'`. Falls back to sequential main-thread processing if workers unavailable
- **Worker pool**: `workerPool.js` manages 2–6 module workers (`{ type: 'module' }`). Backpressure queue feeds workers one task at a time. ArrayBuffers transferred via zero-copy `Transferable`. Crash recovery: `onerror` → re-queue once + respawn. `parserWorker.js` imports `localProvider.js` directly — shared source, no duplication
- **Processing status**: `_status` field on metadata records: `captured` (Tier 1 done), `processing` (in worker), `complete` (done), `error` (failed). On reload, incomplete records are re-queued via `resumeIncomplete()`. Old records without `_status` are treated as `complete`
- **Metadata flow**: File → `localProvider.dispatchParsers()` routes to parser(s) → `normalizeFields()` extracts canonical fields → Grid.js table with expandable detail panel
- **Dual-use libraries**: pdf.js and SheetJS each serve both viewing (in the modal) and metadata extraction — prefer this pattern when adding new format support
- **Binary parsers**: For formats without a library (images, audio, OLE2, RTF, text), we parse raw bytes directly using `ArrayBuffer` / `Uint8Array`
- **OLE2 mini stream**: Streams smaller than `miniStreamCutoff` (4096 bytes) are stored in 64-byte mini sectors inside the Root Entry's data. Both `ole2Parser.js` and `docTextExtractor.js` handle this via `buildMiniStreamContext()` + `readMiniStreamData()`
- **Dual-input parsers**: All parsers accept `File | ArrayBuffer` — when given ArrayBuffer they skip `file.arrayBuffer()` and work directly on the buffer. This lets the same parser code run on main thread (File) and in workers (ArrayBuffer). DOM-dependent parsers (imageParser, audioParser) have separate `FromBuffer` exports that skip DOM APIs
- **Magic byte detection**: `utils.js:detectFileType()` delegates to `detectFileTypeFromBuffer()` via shared `matchMagicBytes()` + `detectZipSubtypeFromBuffer()` helpers. Both File-based and buffer-based entry points share 100% of matching logic
- **ZIP artifact filtering**: `zipHandler.js:isOsArtifact()` skips `__MACOSX/`, `._*` resource forks, `.DS_Store`, `Thumbs.db`, `desktop.ini` during extraction
- **Excerpt extraction**: `excerptExtractor.js` pulls readable text from files (text, PDF, DOCX, DOC, RTF, spreadsheets) capped at 100 KB. PDF excerpts use Y-position delta + `hasEOL` for line breaks and paragraph detection. RTF uses word-boundary-checked `\par`/`\line` matching. Spreadsheets get CSV output. Stored on `item.excerpt`
- **Export mapping system**: `mappingManager.js` stores named mappings in localStorage (`docucata_mappings`). Each mapping has ordered fields with `mode` (`no change` | `name change` | `map metadata` | `fixed value`), `customLabel`, optional `metadataKey` + `metadataFallbacks[]` for coalesce-style fallback chains, and `fixedValue`. `resolveExportMapping()` returns `{ headers, rowBuilder }` consumed by both CSV and JSON exporters. `mappingEditor.js` renders a 5-column modal table (Include / Default Label / Action / Export Label / Map From) with `DEEP_META_CATALOG` (120+ keys across 10 source groups) powering the map-from dropdown via `<optgroup>` elements. Users can add unlimited custom fields (`custom_01`, `custom_02`, …) and drag-reorder fallback metadata keys. The Deep Metadata field is locked (include/exclude only)
- **OOXML ZIP parsing**: `officeParser.js:extractFileFromZip()` uses the Central Directory (not local headers) for reliable extraction — handles data descriptor flags (bit 3) where local headers have zero sizes
- **Batch system**: Registry in localStorage (`docucata_batches`), per-batch metadata in IndexedDB (`docucata_db` → `batch_metadata`). Active batch in `docucata_active_batch`. All metadata functions are async
- **Grid.js quirks**: `forceRender()` destroys and rebuilds `.gridjs-head`, so custom DOM must live outside Grid.js's managed tree. Resize and sort conflict — resolved with capture-phase event interception on `.gridjs-resizable`
- **Sequential ordering**: `_seq` counter on each file, table sorted by `_seq` descending (newest first)
- **Dialog system**: `dialog.confirm()`, `dialog.danger()`, `dialog.prompt()` return Promises. Use `await` in async functions or `.then()` in sync handlers. Never use native `alert()`/`confirm()`/`prompt()`

## Supported File Types for Deep Metadata

| Category | Extensions | Parser(s) |
|----------|-----------|-----------|
| PDF | pdf | pdfParser (pdf.js primary, regex fallback) |
| Office (modern) | docx, xlsx, pptx, odt, ods, odp | officeParser + spreadsheetParser for xlsx/xls/ods |
| Office (legacy) | doc, xls, ppt, dot, xlt, pps | ole2Parser (with mini stream) + spreadsheetParser for xls |
| Word for Mac 4.0 | (extensionless, detected via magic bytes `FE 37`) | docTextExtractor (direct text read) |
| Images | jpg, jpeg, tiff, tif, heic, heif, png, gif, webp, svg, bmp, ico | imageParser + exifParser |
| Audio | mp3, wav, flac, ogg, oga, aif, aiff, m4a, aac, opus | audioParser |
| RTF | rtf | rtfParser |
| Text | txt, md, log, csv, ini, cfg, yaml, yml, toml | textParser |
| Archives | zip | zipHandler (unpack only) |

## Viewer Support

| Format | Renderer |
|--------|----------|
| DOC/DOT (legacy) | Extracted plain text via OLE2 piece table (with mini stream support) |
| PDF | pdf.js canvas pages |
| Spreadsheets (xlsx, xls, ods, csv) | SheetJS → HTML table with sheet tabs |
| Audio (mp3, wav, flac, ogg, etc.) | Native `<audio>` player + metadata card |
| Images | Native `<img>` via object URL |
| Text/code | `<pre>` block |

## User Preferences

- Clean & minimal UI, light theme
- No external dependencies where avoidable (native `fetch()`, hand-written parsers)
- Archive-first philosophy: capture ALL available metadata — don't filter by perceived importance
- In-page UI over native browser dialogs
- No build step — everything runs as static files
