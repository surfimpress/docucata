# Docucata

Purpose - this utility will have a web front end, but could have a node back end if need be. If possible to run purely in a static page, that would be fantastic.

# Suggested approaches
*Here is a potential route to developing a static web app for extracting and exporting file metadata*

The sharepoint aspect is important for the use case, but starting with local files within my own machine is a valid test case

---

## Table of Contents
1. [Product Overview](#product-overview)
2. [Key Features](#key-features)
3. [Technical Stack](#technical-stack)
4. [User Workflow](#user-workflow)
5. [Data Schema](#data-schema)
6. [Security and Privacy](#security-and-privacy)
7. [Installation and Deployment](#installation-and-deployment)
8. [Roadmap](#roadmap)
9. [Example Code Snippets](#example-code-snippets)
10. [Dependencies](#dependencies)
11. [UI Wireframe](#ui-wireframe)
12. [Getting Started for Developers](#getting-started-for-developers)
13. [License](#license)
14. [Support](#support)
15. [Complete Code](#complete-code)

---

## Product Overview
**File Metadata Extractor for SharePoint** is a **pure static web application** (HTML, CSS, JavaScript) designed to help users extract **basic metadata** (e.g., file names, sizes, dates, types) from files stored in **SharePoint** or **OneDrive**. In subsequent phases, it will also parse **PDF and image metadata** (e.g., EXIF, XMP, PDF properties) and allow users to **save extracts to local storage** and **export to CSV**.

The app is designed to be **self-contained**, requiring **no server or backend**, and leverages the **Microsoft Graph API** for direct SharePoint access. It prioritizes **privacy and security** by running entirely in the user’s browser, with optional **Node.js integration** for advanced use cases.

---

## Key Features

### Phase 1: Basic Metadata Extraction
- **Pure Static App**: Runs entirely in the browser with **no server dependencies**.
- **SharePoint Integration**: Connects directly to SharePoint/OneDrive via the **Microsoft Graph API**.
- **User Authentication**: Uses **MSAL.js** for secure Microsoft 365 login.
- **File Metadata Display**: Shows a table of files with:
  - File name
  - Size
  - Last modified date
  - File type (e.g., PDF, JPG, DOCX)
  - SharePoint URL
- **Local Storage**: Saves extracted metadata to the browser’s `localStorage` for persistence across sessions.
- **Export to CSV**: Allows users to export the metadata table to a **CSV file** for further analysis.

### Phase 2: PDF and Image Metadata Parsing
- **PDF Metadata Extraction**:
  - Title, author, creation date, and modification date.
  - Text content (optional).
  - Uses **PDF.js** or **pdf-lib** for in-browser parsing.
- **Image Metadata Extraction**:
  - EXIF data (e.g., camera model, GPS coordinates, date taken).
  - IPTC and XMP metadata.
  - Uses **exif-js** for in-browser parsing.
- **Local Storage Updates**: Appends extracted metadata to `localStorage`.
- **CSV Export**: Includes PDF/image metadata in the exported CSV.

### Phase 3: Advanced Features (Optional Node.js Backend)
- **Legacy File Support**: Optional Node.js backend for converting/parsing legacy files (e.g., QuarkXPress, FrameMaker) to PDF.
- **Batch Processing**: Process large numbers of files efficiently.
- **Automated Reports**: Generate summarized reports of metadata trends.

---

## Technical Stack

### Front-End (Pure Static)
| Component       | Technology                  | Purpose                                      |
|-----------------|-----------------------------|----------------------------------------------|
| UI Framework    | Vanilla HTML/CSS/JS         | Lightweight, no dependencies.                |
| Authentication  | [MSAL.js](https://github.com/AzureAD/microsoft-authentication-library-for-js) | Secure Microsoft 365 login.               |
| API Calls       | [Axios](https://axios-http.com/) | Fetch data from Microsoft Graph API.        |
| PDF Parsing     | [PDF.js](https://mozilla.github.io/pdf.js/) or [pdf-lib](https://pdf-lib.js.org/) | Extract PDF metadata and text.          |
| Image Parsing   | [exif-js](https://github.com/exif-js/exif-js) | Extract EXIF/IPTC/XMP from images.       |
| CSV Export      | Vanilla JS                  | Generate CSV files from metadata.           |
| Local Storage   | `localStorage` API          | Save and retrieve extracted metadata.       |

### Optional Backend (Node.js)
| Component       | Technology                  | Purpose                                      |
|-----------------|-----------------------------|----------------------------------------------|
| Server          | [Express.js](https://expressjs.com/) | Optional backend for legacy file support.   |
| File Conversion | [LibreOffice](https://www.libreoffice.org/) or custom scripts | Convert legacy files to PDF. |
| Advanced Parsing| [PyMuPDF](https://pymupdf.readthedocs.io/) or [ExifTool](https://exiftool.org/) | Server-side metadata extraction. |

---

## User Workflow

### Phase 1: Basic Metadata Extraction
1. **Sign In**: User clicks "Sign In with Microsoft" and authenticates with their organizational account.
2. **Select Folder**: User enters the path to a SharePoint/OneDrive folder (e.g., `Shared Documents/ProjectFiles`).
3. **List Files**: App fetches and displays file metadata in a table.
4. **Save to Local Storage**: User clicks "Save to Local Storage" to persist the metadata.
5. **Export to CSV**: User clicks "Export to CSV" to download the metadata as a CSV file.

### Phase 2: PDF and Image Metadata Parsing
1. **Select Files**: User selects specific PDF/image files from the table.
2. **Extract Metadata**: App parses the files in the browser and appends metadata to the table.
3. **Update Local Storage**: New metadata is saved to `localStorage`.
4. **Export Updated CSV**: User exports the enriched metadata to CSV.

---

## Data Schema

### Local Storage Structure
```javascript
{
  "metadata": [
    {
      "id": "unique-file-id",
      "name": "document.pdf",
      "size": 1024,
      "type": "application/pdf",
      "modified": "2023-10-01T12:00:00Z",
      "url": "https://graph.microsoft.com/.../content",
      "pdfMetadata": {
        "title": "Annual Report",
        "author": "John Doe",
        "created": "2023-09-01T09:00:00Z",
        "text": "Extracted text content..."
      },
      "imageMetadata": {
        "exif": {
          "Make": "Canon",
          "Model": "EOS 5D",
          "DateTimeOriginal": "2023-08-15T14:30:00Z"
        }
      }
    }
  ]
}


