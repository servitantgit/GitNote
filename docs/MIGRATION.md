# MD-Editor to GitNotes: migration notes

GitNotes is a separate application. MD-Editor must remain unchanged and continue to deploy independently.

| Existing capability | GitNotes direction | Current state |
| --- | --- | --- |
| GitHub OAuth login | Reuse the proven server-side OAuth pattern after reviewing its lifecycle; configure a separate OAuth application and callback. | Not implemented |
| GitHub repository client | Reimplement behind an infrastructure adapter; keep secrets server-side. | Not implemented |
| Autosave and draft store | Preserve local-first behavior with IndexedDB/Dexie behind a document-source contract. | `DocumentSource` contract and IndexedDB implementation integrated; debounced autosave remains local-only |
| Working Tree and batch commits | Expand into a repository-scoped operation journal supporting text and binary changes. | Initial in-memory domain model only; no Git transport |
| Tabs and repository switching | Keep tabs globally open; inactive-repository tabs remain locally editable but cannot sync/commit/push. | Workspace manager integrated with UI and IndexedDB for current local workspace; remote repository loading and switching UI not yet implemented |
| File operations | Stage create, rename, move, delete and attachment changes locally; commit explicit batches atomically. | Note CRUD is local-only; repository file operations not implemented |
| EasyMDE / CodeMirror 5 | Replace with CodeMirror 6. | CodeMirror 6 integrated |

## Implemented in the current foundation

- Local note creation, selection, renaming, deletion and debounced autosave.
- Documents read and written through the transport-independent `DocumentSource` contract, currently backed only by IndexedDB/Dexie.
- Document metadata includes repository-relative path, base blob SHA and explicit local/clean/dirty/conflict state. Existing records are migrated to `local`.
- Attachment metadata defines paths relative to the parent note directory; attachment storage and UI remain future work.
- Global open document tabs with selection and closing.
- Workspace snapshot persistence, including repository and branch context.
- Explicit separation of active tab and active repository for remote capability checks.
- No GitHub API calls and no automatic commits.

This document describes current scope. Planned capabilities are not represented as implemented.
