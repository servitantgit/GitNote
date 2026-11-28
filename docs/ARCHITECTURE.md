# GitNotes architecture

## Principles

1. Local-first editing: typing and ordinary note operations update local state/storage only.
2. Git operations are explicit and separate from local persistence.
3. Repository context is carried with every document/change. Remote operations must not depend on a mutable global repository pointer.
4. Modules communicate through small contracts; do not introduce plugin infrastructure without a concrete need.
5. UI styles are scoped by module, with shared tokens in `src/shared/styles`.

## Current implementation

- `src/app`: application shell, local note list, document tabs and workspace orchestration.
- `src/modules/editor`: the Markdown editor module, using CodeMirror 6 with Source, Live (simultaneous 50/50 Source and rendered Preview) and Preview modes, Markdown formatting commands, selection-aware editing, reading statistics and document navigation. It is one format-specific editor, not the workspace's universal document surface.
- `src/modules/documents/OfficeDocumentViewer.tsx`: browser-local Office and non-HTML document integration using the locally vendored engine source in `src/vendor/office-engine`; it receives a stored Blob and returns edited Blob content through the host save callback. The host-owned viewer controller delegates Print to the engine's existing print pipeline.
- `src/modules/documents/PdfDocumentViewer.tsx`: read-only PDF viewer using a Blob URL and the browser's native PDF renderer; print is delegated to the embedded PDF viewer.
- `src/modules/documents/DocumentActions.tsx` and `document-download.ts`: shared workspace Download/Print controls and original-Blob download helper. The controls delegate printing to the active format adapter rather than implementing a universal print renderer.
- `src/modules/documents/markdown-print.ts`: Markdown-specific sanitized HTML print adapter; it uses the existing Markdown renderer and DOMPurify.
- `src/modules/search`: on-demand local workspace content search. Markdown notes are searched directly; DOCX, XLSX and PPTX text extraction reuses the vendored Office engine; HTML/SVG text is read locally without executing document scripts. Search is not persistently indexed. PDF is currently excluded because the native browser viewer does not expose document text to the host application.
- `src/vendor/office-engine`: GitNote-owned copy of the required office-engine runtime source, pinned to upstream `v0.18.0` / `d7126505a00a431529d479c11d8d3372aeaf6cd0`. Vite compiles this source as part of GitNote; there is no package, Git or network dependency on upstream.
- `src/modules/documents/html`: HTML-specific adapter, constrained host sizing, and proportional bidirectional scroll synchronization between the engine's source editor and rendered document surface. This mechanism is deliberately isolated from Markdown's logical-line scroll coordinator.
- `src/infrastructure/storage`: Dexie database, local `DocumentSource`, local `WorkspaceFileSystem`, draft and workspace stores.
- `src/core/domain/document-source.ts`: transport-independent document metadata, synchronization state, source contract and attachment metadata.
- `src/core/domain/document-format.ts`: format-neutral filename/MIME classifier. Recognized extensions take precedence over browser MIME metadata; MIME lookup is the fallback. It does not imply a viewer/editor exists for every detected format.
- `src/core/domain/workspace-file-system.ts`: repository-scoped virtual file tree contract, path validation and path helpers.
- `src/core/domain`: repository capabilities, globally scoped workspace tabs and Working Tree model.
- `e2e`: Playwright browser-level regression tests.

## Editor behavior

- Source and Live share one persistent CodeMirror 6 instance. Switching to Preview hides the editor without destroying its undo history or selection.
- `src/modules/editor/navigation/scroll-position.ts` defines the logical document position (line plus fractional offset) and adapters for CodeMirror 6 and rendered Markdown Preview. Preview mapping derives paragraph, heading and image anchors from the Lezer Markdown syntax tree so rendered block spacing and tall content do not distort document position. Per-tab CodeMirror `EditorState` is retained independently from the logical scroll position. The CodeMirror adapter applies restoration through CodeMirror's post-layout `requestMeasure` cycle. Cross-mode restoration and line-wrapping behavior are tested independently so a width-induced line-height change is not conflated with per-note position ownership.
- `src/modules/editor/navigation/scroll-coordinator.ts` coordinates registered scroll surfaces around one position, reports position changes through the owning document callback, and exposes `scrollTo`/`subscribe` so the minimap can drive and observe the same navigation state. On detach it never reads the surface: React may already have hidden a still-connected element or reused its DOM for another document, so its scroll offset may be reset or clamped. The coordinator retains the last position captured by a scroll event.
- The formatting toolbar supports bold, italic, strikethrough, inline code, links, headings, lists, blockquotes and horizontal rules. CodeMirror's `EditorView.lineWrapping` extension wraps long source lines in both Source and Live without introducing a second scroll container or changing the logical scroll coordinator.
- Live keeps the Markdown source editable beside the rendered Preview; Marked renders Markdown and DOMPurify sanitizes the generated HTML.
- Undo/redo use CodeMirror history. CodeMirror's standard editing keymaps and search panel remain available.
- Preview renders GitHub-Flavored Markdown through Marked, applies Java/Python fenced-code highlighting through the same lazily loaded CM6/Lezer parsers used by the Source editor, and sanitizes generated HTML with DOMPurify before insertion. The Preview scroll surface is registered only after the highlighted HTML for the current content has committed to the DOM, so scroll restoration never targets an empty preview. Unsupported fence languages retain ordinary escaped code rendering.
- HTML uses a separate proportional scroll adapter because its source editor is a plain-text area and its rendered view is a paginated document surface; it does not share Markdown's Lezer anchors or CodeMirror logical-line coordinator.
- The logical per-document scroll position is the single source of truth across tab switches and editor modes. The coordinator maps positions between Source/Live and rendered Preview; Preview translates between rendered pixels and logical document lines using paragraph/heading/image anchors, with proportional fallback only when rendered blocks cannot be matched. Native CodeMirror scroll snapshots are not used, avoiding competing restoration owners.
- `src/modules/editor/Outline.tsx` renders an optional heading navigation panel. It parses headings through the Lezer-backed `outline.ts` helper, tracks the active heading from coordinator position updates, and navigates with `coordinator.scrollTo()`; it does not create another scroll state or adapter.
- `src/modules/editor/Minimap.tsx` renders a canvas minimap beside the active editor surface. It uses Lezer Markdown syntax-tree ranges for heading, code and list marks, displays the logical viewport/cursor, and sends click/drag navigation through the existing per-document scroll coordinator. It does not own scroll synchronization or persist separate position state.
- The Outline and minimap are optional, hidden by default and available on desktop; their toggles and panels are hidden on narrow mobile layouts. Outline navigation is tested in Source, Live and Preview. Chromium coverage exercises click navigation in Source, Live and Preview, plus dragging in Preview.
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
- The editor exposes a development-only Playwright hook for reading the coordinator's logical position and the active CodeMirror adapter's position; production builds exclude this diagnostic hook.
- Scroll regression coverage exercises Source/Live/Preview transitions, Live's simultaneous bidirectional synchronization including fractional slow-wheel input, independent per-note positions, Preview image-load/resize notifications, and minimap click/drag navigation across all three single-pane editor modes.

## Workspace manager and UI integration

`WorkspaceManager` keeps repository registrations, globally open document tabs, active-tab selection and active remote-repository focus as separate state.

- Open tabs and repository context are persisted in the `workspaces` IndexedDB table.
- Selecting a tab does not silently activate its repository.
- Tabs belonging to inactive repositories remain open and locally editable.
- Remote read/sync/commit/push operations are permitted only for the explicitly active repository.
- Every tab carries its repository ID and branch; callers must use that context for document operations.
- Removing a repository does not silently activate another repository.
- Closing a tab does not delete its document. Closing the final tab leaves `activeTabId` null and persists an empty tab list; startup preserves that intentional empty state. A fresh workspace with no prior snapshot opens its initial welcome note, but a saved workspace with no open tabs remains tabless. Deleting a note removes it from local note storage and closes its corresponding tab.
- The sidebar uses `src/modules/workspace/WorkspaceFileTree.tsx` to render one recursive tree from repository VFS nodes. `WorkspaceFileIcon` maps file extensions to the same colored Lucide icons used by `WorkspaceCreateMenu`. Notes and binary files are siblings in the same hierarchy; format determines the open handler, not folder grouping. The selected folder is the target for new folders, Markdown notes, blank Office documents and supported-file imports. Existing `Notes/` and `Documents/` directories are retained as ordinary legacy folders. Rename/move UI and drag-and-drop remain unimplemented.
- Notes and binary documents use one format-neutral tab strip. Each open binary tab retains its mounted format viewer; Markdown retains per-document CodeMirror EditorState in the editor module. GitHub repository registration and loading notes from remote repositories remain future work.

## Per-tab document lifecycle

`WorkspaceTab` identifies a document by `documentType` (`note` or `binary`) and `documentId`; `noteId` remains readable for older persisted snapshots; helper functions resolve its document type and identity without rewriting existing records. `WorkspaceManager` owns the shared ordered tab collection and active-tab selection. The app retains one binary record and UI/action state per open binary document. Format-specific viewers are keyed by tab and stay mounted in hidden panels while inactive, preserving their editor/controller/iframe state. Closing a tab releases only its in-memory viewer state; it does not delete the underlying document. Closing a binary tab with unsaved edits requires confirmation. Reload restores persisted tab identities and reloads their binary Blob records from IndexedDB.

## Local persistence and compatibility

Text notes are stored in IndexedDB in the `notes` table through `LocalIndexedDbDocumentSource`. Binary documents are stored as Blob records in the separate `binaryDocuments` table through `LocalIndexedDbBinaryDocumentSource`; binary content is never coerced into the text-note `content` field. The workspace imports and opens supported documents in format-specific viewers: Office/HTML use the locally vendored `DocViewer`, while PDF uses the browser-native PDF renderer. Office edits are written back to the same binary record as a Blob. Shared workspace actions download the original/current Blob and delegate printing to Markdown, Office/HTML or PDF-specific mechanisms. File and folder nodes are stored in `fileNodes` through `LocalWorkspaceFileSystem`; file nodes reference text or binary documents by ID, and document paths are repository-relative. Folder rename/move updates descendant paths and linked text/binary document metadata in one IndexedDB transaction. Removing a file or folder removes its linked local text/binary documents. Workspace snapshots are stored in the `workspaces` table. The Dexie database name remains `gitnote-local` to preserve data created by the previous GitNote foundation. Schema version 4 adds document path and synchronization-state indexes and backfills existing notes as `local`; schema version 5 adds the `fileNodes` store and migrates existing notes into a `Notes` folder with stable document IDs; schema version 6 adds `binaryDocuments` without rewriting existing records. These upgrades do not recreate the existing notes store.

Attachment metadata includes a path relative to the directory containing its parent note. Binary workspace file bytes are now stored as Blobs, with atomic VFS registration, rename/move path updates and recursive deletion. Note-scoped attachment ownership and lifecycle remain separate planned work.

## Planned boundaries

- `git-engine`: repository-scoped operation journal, tree construction, commit batching, conflict detection and GitHub transport.
- `attachments`: note-scoped attachment lifecycle and format-handler registry.
- `documents`: shared document-opening contract, format detection/capabilities and format-specific adapters. Markdown, Office (DOCX/XLSX/PPTX), PDF and HTML require appropriate independent viewers/editors; do not route every format through the Markdown editor.
- `settings`, `help`: independent modules with versioned data/configuration. Persistent search indexing remains planned; the current search module scans local content on demand.

These are planned boundaries, not claims that they are implemented.


## Markdown fenced-code syntax highlighting

The Markdown CodeMirror 6 language extension registers Java and Python through `src/modules/editor/code-languages.ts`. Markdown fenced-code info strings (`java`, `python`, `py`, `python3`) select the corresponding Lezer language parser and syntax highlighting. These language packages are used only for highlighting; GitNotes does not expose language-specific completion, diagnostics, compilation or code execution. Language modules are dynamically imported when their fenced language is encountered. The rendered Preview uses `@lezer/highlight` with Lezer's shared token classes, so it does not introduce a second syntax-highlighting engine. Unsupported languages remain unhighlighted. No language-specific completion, diagnostics, compilation or code execution is provided.

## Vendored Office engine boundary and updates

The office-engine runtime source lives inside `src/vendor/office-engine` and is imported directly by GitNote's format adapters. This keeps the code required for Office document handling in the GitNote repository and removes the upstream npm package as a build/runtime dependency. React and React DOM are host-provided peer dependencies. Vite compiles the vendored TypeScript source; upstream package build tooling is not part of GitNote's build.

The vendored directory contains only the runtime source needed by GitNote plus its provenance and license files. Do not import the upstream repository wholesale: its server-side `packages/convert`, Docker services, playground, examples, tests and development tooling are outside this integration boundary. Do not use a tarball, package dependency or automatic subtree/HEAD tracking for updates.

Updates are selective and manual. Review upstream changes against GitNote's actual needs, import only relevant runtime changes, inspect dependency/API/license changes, and update `src/vendor/office-engine/UPSTREAM.md` with the exact source tag and commit. Keep GitNote-specific format adapters and scroll behavior in `src/modules/documents`, not in the upstream vendor copy. Every engine update must pass unit tests, the TypeScript/Vite production build and Chromium tests for DOCX, XLSX, PPTX and HTML.
