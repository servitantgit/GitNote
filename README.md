# GitNotes

[![CI](https://github.com/servitantgit/GitNote/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/servitantgit/GitNote/actions/workflows/ci.yml)

GitNotes is a local-first, multi-format workspace inspired by OneNote Online, with Git-based version control. It is intended for notes and documents across Markdown, Office formats, PDF, HTML and other file types. Markdown is one supported format, not the product's primary identity. GitNotes is developed independently from MD-Editor.

## Product direction

GitNotes aims to combine a OneNote Online-style workspace for organizing notes and documents with Git version history and user-owned repository storage. It is not a Markdown-first editor. Different formats are intended to use appropriate viewing and editing experiences: Office documents (DOCX, XLSX, PPTX), PDF, HTML, Markdown and additional file types. Exact editing, conversion and export capabilities are defined per format and are not all implemented yet.

## Current foundation

- React + TypeScript + Vite application shell.
- Markdown source editor based on CodeMirror 6 with Source / Live / Preview modes (Live shows editable Markdown and rendered output side by side).
- Markdown formatting toolbar for emphasis, links, headings, lists, blockquotes and separators.
- CodeMirror undo/redo, standard keyboard editing commands, search and bracket matching.
- GitHub-Flavored Markdown preview rendered through Marked and sanitized with DOMPurify.
- Live keeps the Markdown source editable beside the rendered document.
- Local note creation, selection, renaming, deletion and autosaving through IndexedDB (Dexie).
- Global document tabs with close/select behavior.
- Workspace repository registrations, active repository context and open tabs persist in IndexedDB.
- Selecting a tab does not activate remote access for its repository; remote operations require explicit repository activation.
- No GitHub authentication or remote repository operations are enabled yet.

## Quality checks

The CI workflow runs three independent checks on every push to `main` and every pull request:

- **Unit tests:** Vitest tests for domain logic and editor helpers.
- **Browser tests:** Playwright end-to-end tests in Chromium for application startup, note creation, autosave and reload persistence, editor modes, Markdown toolbar actions and note deletion.
- **Production build:** TypeScript project checks and Vite production build.

Browser tests record screenshots and traces on failure. The CI job uploads the report and test artifacts for seven days.

### Run locally

```sh
npm install
npm run dev
npm test
npm run build
```

Playwright is pinned to `@playwright/test@1.65.1` in CI. To run browser tests locally, install the same runner and Chromium:

```sh
npm install --no-save --package-lock=false @playwright/test@1.65.1
npx playwright install chromium
npm run test:e2e
```

## Scope and data compatibility

GitNotes keeps the existing IndexedDB database identifier `gitnote-local` so notes created by the earlier GitNote foundation remain available after the product rename. Local note and workspace operations do not create Git commits or make network requests.
