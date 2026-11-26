# MD-Editor to GitNote: migration notes

GitNote is a separate application. MD-Editor must remain unchanged and continue to deploy independently.

| Existing capability | GitNote direction | Current state |
| --- | --- | --- |
| GitHub OAuth login | Reuse the proven server-side OAuth pattern after reviewing its lifecycle; configure a separate OAuth application and callback. | Not implemented |
| GitHub repository client | Reimplement behind an infrastructure adapter; keep secrets server-side. | Not implemented |
| Autosave and draft store | Preserve local-first behavior with IndexedDB/Dexie. | Local note storage and debounced autosave implemented; draft/repository synchronization not implemented |
| Working Tree and batch commits | Expand into a repository-scoped operation journal supporting text and binary changes. | Initial in-memory domain model only; no Git transport |
| Tabs and repository switching | Keep tabs globally open; inactive-repository tabs remain locally editable but cannot sync/commit/push. | Workspace domain manager implemented and tested; UI and durable workspace snapshot persistence not yet integrated |
| File operations | Stage create, rename, move, delete and attachment changes locally; commit explicit batches atomically. | Note CRUD is local-only; repository file operations not implemented |
| EasyMDE / CodeMirror 5 | Replace with CodeMirror 6. | CodeMirror 6 integrated |

## Implemented in the current foundation

- Local note creation, selection, renaming and deletion.
- Notes persisted in IndexedDB through Dexie schema version 2.
- Debounced autosave with protection against stale save completions and switching to another note before the save timer fires.
- Source, initial inline Live Preview decorations, and read-only Preview modes.
- Workspace domain manager for globally open tabs and explicit active-repository remote capability gating, with unit tests.
- No GitHub API calls and no automatic commits.

This document describes current scope. Planned capabilities are not represented as implemented.
