# GitNotes architecture

## Principles

1. Local-first editing: typing and ordinary note operations update local state/storage only.
2. Git operations are explicit and separate from local persistence.
3. Repository context is carried with every document/change. Remote operations must not depend on a mutable global repository pointer.
4. Modules communicate through small contracts; do not introduce plugin infrastructure without a concrete need.
5. UI styles are scoped by module, with shared tokens in `src/shared/styles`.

## Current implementation

- `src/app`: application shell, local note list, document tabs and workspace orchestration.
- `src/modules/editor`: CodeMirror 6 editor with Source, Live (simultaneous 50/50 Source and rendered Preview) and Preview modes, Markdown formatting commands, selection-aware editing, reading statistics and document navigation.
- `src/infrastructure/storage`: Dexie database, local `DocumentSource`, local `WorkspaceFileSystem`, draft and workspace stores.
- `src/core/domain/document-source.ts`: transport-independent document metadata, synchronization state, source contract and attachment metadata.
- `src/core/domain/workspace-file-system.ts`: repository-scoped virtual file tree contract, path validation and path helpers.
- `src/core/domain`: repository capabilities, globally scoped workspace tabs and Working Tree model.
- `e2e`: Playwright browser-level regression tests.

## Editor behavior

- Source and Live share one persistent CodeMirror 6 instance. Switching to Preview hides the editor without destroying its undo history or selection.
- `src/modules/editor/navigation/scroll-position.ts` defines the logical document position (line plus fractional offset) and adapters for CodeMirror 6 and rendered Markdown Preview. Preview mapping derives paragraph, heading and image anchors from the Lezer Markdown syntax tree so rendered block spacing and tall content do not distort document position. Per-tab CodeMirror `EditorState` is retained independently from the logical scroll position.
- `src/modules/editor/navigation/scroll-coordinator.ts` coordinates registered scroll surfaces around one position, reports position changes through the owning document callback, and exposes `scrollTo`/`subscribe` so the minimap can drive and observe the same navigation state. On detach it never reads the surface: React may already have hidden a still-connected element or reused its DOM for another document, so its scroll offset may be reset or clamped. The coordinator retains the last position captured by a scroll event.
- The formatting toolbar supports bold, italic, strikethrough, inline code, links, headings, lists, blockquotes and horizontal rules. CodeMirror's `EditorView.lineWrapping` extension wraps long source lines in both Source and Live without introducing a second scroll container or changing the logical scroll coordinator.
- Live keeps the Markdown source editable beside the rendered Preview; Marked renders Markdown and DOMPurify sanitizes the generated HTML.
- Undo/redo use CodeMirror history. CodeMirror's standard editing keymaps and search panel remain available.
- Preview renders GitHub-Flavored Markdown through Marked and sanitizes generated HTML with DOMPurify before insertion.
- The logical per-document scroll position is the single source of truth across tab switches and editor modes. The coordinator maps positions between Source/Live and rendered Preview; Preview translates between rendered pixels and logical document lines using paragraph/heading/image anchors, with proportional fallback only when rendered blocks cannot be matched. Native CodeMirror scroll snapshots are not used, avoiding competing restoration owners.
- `src/modules/editor/Minimap.tsx` renders a canvas minimap beside the active editor surface. It uses Lezer Markdown syntax-tree ranges for heading, code and list marks, displays the logical viewport/cursor, and sends click/drag navigation through the existing per-document scroll coordinator. It does not own scroll synchronization or persist separate position state.
- The minimap is optional, hidden by default and available on desktop; its toggle and panel are hidden on narrow mobile layouts. Chromium coverage exercises click navigation in Source, Live and Preview, plus dragging in Preview.
- Live mode keeps the same CodeMirror Source surface and rendered Preview mounted side by side at equal widths. Both register with the existing per-document scroll coordinator, so scrolling either pane updates the other without a second synchronization mechanism. Switching modes retains the same editor instance and per-tab EditorState.
- Editor content is read and written through the `DocumentSource` contract. The current implementation is `LocalIndexedDbDocumentSource`; it performs no network or Git operations.
- Document metadata carries an optional repository-relative `path`, optional remote `baseSha`, and `syncState` (`local`, `clean`, `dirty` or `conflict`).

## Automated quality gates

Every feature change must include regression coverage appropriate to its behavior:

- Unit tests cover pure functions, domain rules, state transitions and error cases.
- Component/integration tests cover React interactions and storage boundaries where practical.
- Playwright tests cover user-visible workflows and regressions that depend on the browser, DOM, IndexedDB, keyboard input, layout or navigation.
- CI runs unit tests, Chromium browser tests and the production build independently. A change is not considered verified until all three jobs pass.
- Bug fixes should add a regression test that fails before the fix and passes after it.
- Browser-test failures retain traces/screenshots as CI artifacts to make diagnosis reproducible.
- Scroll regression coverage exercises Source/Live/Preview transitions, Live's simultaneous bidirectional synchronization including fractional slow-wheel input, independent per-note positions, Preview image-load/resize notifications, and minimap click/drag navigation across all three single-pane editor modes.

## Workspace manager and UI integration

`WorkspaceManager` keeps repository registrations, globally open document tabs, active-tab selection and active remote-repository focus as separate state.

- Open tabs and repository context are persisted in the `workspaces` IndexedDB table.
- Selecting a tab does not silently activate its repository.
- Tabs belonging to inactive repositories remain open and locally editable.
- Remote read/sync/commit/push operations are permitted only for the explicitly active repository.
- Every tab carries its repository ID and branch; callers must use that context for document operations.
- Removing a repository does not silently activate another repository.
- Closing a tab does not delete its note. Deleting a note removes it from local note storage and closes its corresponding tab.
- The current UI integrates local-workspace notes. GitHub repository registration and loading notes from remote repositories remain future work.

## Local persistence and compatibility

Documents are stored in IndexedDB in the `notes` table through `LocalIndexedDbDocumentSource`. File and folder nodes are stored in `fileNodes` through `LocalWorkspaceFileSystem`; file nodes reference their document by ID, and document paths are repository-relative. Folder rename/move updates descendant paths and linked document metadata in one IndexedDB transaction. Removing a file or folder removes its linked local documents. Workspace snapshots are stored in the `workspaces` table. The Dexie database name remains `gitnote-local` to preserve data created by the previous GitNote foundation. Schema version 4 adds document path and synchronization-state indexes and backfills existing notes as `local`; schema version 5 adds the `fileNodes` store and migrates existing notes into a `Notes` folder with stable document IDs. These upgrades do not recreate the existing notes store.

Attachment metadata includes a path relative to the directory containing its parent note. The attachment storage/lifecycle module is not implemented yet; no attachment files are being written by this change.

## Planned boundaries

- `git-engine`: repository-scoped operation journal, tree construction, commit batching, conflict detection and GitHub transport.
- `attachments`: note-scoped attachment lifecycle and format-handler registry.
- `documents`: format adapters for Markdown and office documents.
- `settings`, `help`, `search`: independent modules with versioned data/configuration.

These are planned boundaries, not claims that they are implemented.
