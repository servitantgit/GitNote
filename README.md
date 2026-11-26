# GitNotes

[![CI](https://github.com/servitantgit/GitNote/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/servitantgit/GitNote/actions/workflows/ci.yml)

GitNotes is a local-first workspace for notes and documents with Git-based version control. It is developed independently from MD-Editor.

## Current foundation

- React + TypeScript + Vite application shell.
- CodeMirror 6 editor with Source / Live Preview / Preview modes.
- Markdown formatting toolbar for emphasis, links, headings, lists, blockquotes and separators.
- CodeMirror undo/redo, standard keyboard editing commands, search and bracket matching.
- GitHub-Flavored Markdown preview rendered through Marked and sanitized with DOMPurify.
- Live Preview preserves code inside fenced blocks and inline code spans instead of formatting Markdown markers inside examples.
- Local note creation, selection, renaming, deletion and autosaving through IndexedDB (Dexie).
- Global document tabs with close/select behavior.
- Workspace repository registrations, active repository context and open tabs persist in IndexedDB.
- Selecting a tab does not activate remote access for its repository; remote operations require explicit repository activation.
- No GitHub authentication or remote repository operations are enabled yet.

## Development

```sh
npm install
npm run dev
npm test
npm run build
```

## Scope and data compatibility

GitNotes keeps the existing IndexedDB database identifier `gitnote-local` so notes created by the earlier GitNote foundation remain available after the product rename. Local note and workspace operations do not create Git commits or make network requests.
