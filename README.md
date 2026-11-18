# GitNote

GitNote is a local-first workspace for notes and documents with Git-based version control. It is a separate product from MD-Editor.

## Current foundation

- React + TypeScript + Vite application shell.
- CodeMirror 6 editor integration.
- Source / Live Preview / Preview modes. Live Preview currently renders common Markdown syntax inline (headings, emphasis, strike-through, inline code, links, quotes and list markers); it is an initial subset, not full WYSIWYG editing.
- Local note creation, selection, renaming, deletion and autosaving through IndexedDB (Dexie).
- Local Working Tree domain model, not yet connected to GitHub.
- No GitHub authentication or remote repository operations are enabled in this foundation.

## Development

```sh
npm install
npm run dev
npm test
npm run build
```

## Scope and safety

GitNote is developed independently. It does not modify the existing MD-Editor project. Local note operations do not create Git commits or make network requests.
