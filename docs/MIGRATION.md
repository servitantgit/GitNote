# MD-Editor to GitNotes: migration notes

GitNotes is a separate application. MD-Editor must remain unchanged and continue to deploy independently.

| Existing capability | GitNotes direction | Current state |
| --- | --- | --- |
| GitHub OAuth login | Reuse the proven server-side OAuth pattern after reviewing its lifecycle; configure a separate OAuth application and callback. | Not implemented |
| GitHub repository client | Reimplement behind an infrastructure adapter; keep secrets server-side. | Not implemented |
| Autosave and draft store | Preserve local-first behavior with IndexedDB/Dexie behind a document-source contract. | `DocumentSource` contract and IndexedDB implementation integrated; debounced autosave remains local-only |
| Working Tree and batch commits | Expand into a repository-scoped operation journal supporting text and binary changes. | Initial in-memory domain model only; no Git transport |
| Tabs and repository switching | Keep tabs globally open; inactive-repository tabs remain locally editable but cannot sync/commit/push. | Workspace manager integrated with UI and IndexedDB for current local workspace; remote repository loading and switching UI not yet implemented |
| File operations | Stage create, rename, move, delete and attachment changes locally; commit explicit batches atomically. | Local VFS contract and IndexedDB adapter implemented for folders/files, rename, move and recursive delete; tree UI and remote Git operations remain future work |
| EasyMDE / CodeMirror 5 | Replace with CodeMirror 6. | CodeMirror 6 integrated |

## Implemented in the current foundation

- Local note creation, selection, renaming, deletion and debounced autosave.
- Documents read and written through the transport-independent `DocumentSource` contract, currently backed only by IndexedDB/Dexie.
- Repository-scoped local VFS with folder/file nodes, safe relative paths, and atomic rename/move path updates in IndexedDB.
- Existing notes migrated into the local `Notes` folder without changing their document IDs.
- Document metadata includes repository-relative path, base blob SHA and explicit local/clean/dirty/conflict state. Existing records are migrated to `local`.
- Note-scoped attachments are stored as Blob records in `noteAttachments`, keyed by the parent note ID. The manager supports add/list/download/remove, and note/folder deletion cleans up owned files transactionally. Markdown images can be added by toolbar, clipboard paste or drag-and-drop; stable attachment IDs are rendered in Live/Preview through temporary object URLs.
- Global open document tabs with selection and closing.
- Workspace snapshot persistence, including repository and branch context.
- Explicit separation of active tab and active repository for remote capability checks.
- No GitHub API calls and no automatic commits.

This document describes current scope. Planned capabilities are not represented as implemented.
