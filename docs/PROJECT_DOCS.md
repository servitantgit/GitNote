# GitNotes project reference

Last reviewed: 2026-11-28
Authoritative branch: main
Repository: https://github.com/servitantgit/GitNote
Deployment: https://gitnotes.pages.dev/

This document records the repository's current implementation and approved direction. Source code and tests on main remain authoritative if this document becomes stale.

## Product

GitNotes is a local-first, multi-format workspace inspired by OneNote Online, combined with Git version control and storage in user-owned GitHub repositories. It is not a Markdown-first editor, a collaborative Google Docs clone, an Obsidian graph or a code IDE. Markdown is one supported format among several.

The intended workspace covers structured notes and pages plus format-appropriate handling of Office documents (DOCX, XLSX, PPTX), PDF, HTML and other file types. The product must not force all content through the Markdown editor: each format needs an appropriate viewer and, where in scope, editor. Exact per-format editing, conversion and export behavior remains to be specified; planned capabilities must not be described as implemented.

Desktop/laptop is the primary work environment. Mobile is intended mainly for quick notes and reading. MD-Editor is a separate existing product; do not modify its repository or deployment as part of GitNotes work.

## Approved product and technical decisions

- React, TypeScript and Vite.
- CodeMirror 6 as the Markdown source editor engine; it is not the universal editor for all document formats.
- A multi-format document architecture with format-specific viewers/editors for Markdown, Office files, PDF, HTML and additional supported file types.
- IndexedDB with Dexie for local persistence; database name is gitnote-local.
- Vitest for unit tests and Playwright/Chromium for browser tests.
- DocumentSource separates editor/document operations from storage and remote transport.
- WorkspaceFileSystem defines repository-scoped file and folder operations.
- Local-first behavior: typing, autosave and file operations do not create GitHub commits.
- GitHub repository manager, GitHub API transport and OAuth are intentionally deferred until the editor/local workspace is ready.
- Keep exactly three editor modes: Source, Live (side-by-side editable Source and rendered Preview with bidirectional synchronized scrolling), and Preview. There is no separate inline-formatting Live mode.
- Per-tab CodeMirror state is retained so text, selection and undo history do not cross-contaminate documents.
- Tabs remain globally open. Inactive-repository tabs remain locally editable; remote operations are disabled until that repository is explicitly active.
- No automatic commit, push or sync.
- Note attachments are note-scoped, not stored in one shared global assets folder.
- The Office engine is vendored as source inside GitNote; no upstream npm package, GitHub repository or runtime network access is required to build or run it.
- Upstream engine updates are deliberate and selective. Do not automatically track upstream HEAD, add a package/git dependency, or import unrelated upstream repository components.


## Architecture maintenance principles

- Design changes with maintainability and safe future evolution in mind, not only immediate behavior.
- Keep one cohesive responsibility per module, with clear interfaces and dependency direction. Avoid circular dependencies and hidden coupling.
- Split files when they begin accumulating independent responsibilities; keep central application/editor components focused rather than using them as general-purpose containers.
- Avoid both oversized monoliths and excessive fragmentation into trivial helper files. Module boundaries should reflect meaningful responsibilities.
- Evaluate dependency upgrades for breaking changes and downstream effects before adopting them; verify affected behavior with targeted regression tests.
- Proactively identify and explain technical risks and preventive improvements. Recommendations do not authorize unapproved scope expansion or broad refactoring.
- Reuse-first for capabilities: inspect the current MD-Editor implementation and tests before recreating a feature that may already exist there. Adapt proven code or patterns when appropriate, while checking compatibility, security, licensing and GitNotes' architecture; never modify the separate MD-Editor repository as part of GitNotes work.
- Reuse-first for standard UI: prefer existing MD-Editor patterns or suitable components already installed in GitNotes for dialogs, confirmations, prompts, alerts, menus, tooltips, dropdowns and other common controls. If needed, prefer a mature, maintained and accessible importable library over a hand-built generic component. Evaluate any new dependency before proposing it; custom-build only genuinely product-specific behavior that existing components cannot reasonably cover.

## Current implementation

### Application shell and notes

- React application shell with a unified VFS file tree, global document tabs and format-specific document surfaces. Binary documents use a compact shared action row because the Office/HTML/PDF surface already presents its own filename and format controls.
- Create, select, rename and delete local notes. New note records and their VFS file nodes are created in one IndexedDB transaction.
- Debounced local autosave through IndexedDB/Dexie.
- Local-only status is shown; GitHub authentication and remote repository selection are not implemented.
- Startup safely handles the React StrictMode double invocation: if another initialization pass creates the `Notes` folder first, the second pass confirms the folder exists and continues.
- The top-bar Search control opens a global search across every local Markdown note, including closed notes, plus saved DOCX, XLSX, PPTX, HTML and SVG documents. Extracted text and unique trigrams are persisted per document in the `searchDocuments` Dexie store; a multi-entry IndexedDB index narrows exact substring queries to candidate documents. The index is populated lazily, refreshed when a source document's `updatedAt` changes, and stale entries are removed when source documents disappear. Current in-memory Markdown edits are reflected in the index; unsaved Office edits are not included. Office extraction reuses the vendored engine's parsers; HTML/SVG are read locally without executing page scripts. PDF is not indexed because the current native browser viewer does not expose its text to the application. Short queries under three characters use a full indexed-text scan.
- Settings and attachment controls remain placeholders/disabled.
- The sidebar renders one recursive VFS tree for notes and binary files. File icons are format-specific and color-coded consistently with the Create menu. The Create menu uses an explicitly controlled, keyboard-dismissable popover with accessible menu-item actions; it creates Markdown notes and blank DOCX, XLSX and PPTX files in the selected folder, or the legacy `Notes/` / `Documents/` defaults when no folder is selected. Imported supported files go to the selected folder, or `Documents/` by default. Closing the last open tab leaves the workspace with no active document; this empty tab state is persisted and restored after reload, without deleting the underlying file.

### Markdown editor

- CodeMirror 6 with Source, Live and Preview modes. Long Markdown lines wrap in the editable Source pane in both Source and Live modes; horizontal scrolling is not required for ordinary prose.
- Markdown language extension with fenced Java and Python syntax highlighting selected by code-fence language tags, plus basic editor facilities: line numbers, fold gutter, active line, bracket matching, close brackets and indentation. Java/Python support is syntax highlighting only, not IDE functionality.
- Formatting toolbar: bold, italic, strikethrough, inline code, link, H1/H2, bullet/numbered lists, quote, horizontal rule, undo and redo.
- Keyboard shortcuts for common inline formatting.
- Preview uses Marked with GFM and DOMPurify sanitization. Java and Python fenced blocks are highlighted in the rendered Preview with the same lazily loaded CodeMirror 6 / Lezer language parsers used by Source and Live; unsupported fence languages remain plain code. Preview scroll synchronization attaches after the current rendered content is ready.
- Live keeps Markdown source editing and rendered output visible together; Markdown formatting is handled by the rendered Preview pane.
- A map keyed by document ID retains CodeMirror EditorState between tab switches, including undo history and selection. Scroll position has one owner: the logical per-document position map and scroll coordinator. CodeMirror and Preview adapters restore that shared position, avoiding competing native and logical restoration mechanisms.
- An in-memory map keyed by document ID stores a logical document line and fractional offset for cross-surface mode switches (it is not a browser-reload persistence feature). `src/modules/editor/navigation/scroll-position.ts` adapts this position to CodeMirror 6 and rendered Preview; Lezer-derived paragraph, heading and image blocks are anchors for content-aware mapping, with proportional fallback only when rendered blocks cannot be matched.
- `src/modules/editor/navigation/scroll-coordinator.ts` owns scroll-surface registration, bidirectional propagation, echo suppression, retaining the last scroll-event position on detach without re-reading a surface that React may already have hidden or reused, CodeMirror restoration scheduled through its measurement cycle after layout, and the shared `scrollTo`/`subscribe` contract. The Minimap component uses this contract to control and observe scrolling without owning a second synchronization implementation. The CodeMirror adapter restores logical positions through CodeMirror's measurement cycle after layout. Cross-mode restoration tests use stable line geometry; line wrapping is covered independently by a focused Source/Live overflow test.
- The Outline is implemented as an optional desktop navigation panel. Its heading parser is isolated in `src/modules/editor/outline.ts`; the panel subscribes to the existing coordinator and never owns a separate scroll mechanism. ATX and Setext headings are supported, and fenced code is excluded by Lezer structure.
- The canvas minimap is implemented as an optional desktop panel. It shows Markdown structure, cursor and logical viewport; clicking or dragging it drives all registered surfaces through the existing scroll coordinator. The minimap is not shown by default and is hidden on narrow mobile layouts.
- Live displays the editable Source and rendered Preview simultaneously. Both visible surfaces register with the existing per-document scroll coordinator. The optional Outline panel lists ATX and Setext headings parsed from the Lezer Markdown syntax tree, highlights the heading at the current logical scroll position, and navigates through the existing per-document scroll coordinator in Source, Live and Preview. It is hidden on narrow mobile layouts. Language-by-extension selection, wiki-link completion, search/replace UX, interactive preview checkboxes and image-management workflow are not implemented yet.

### Document domain and storage

`src/core/domain/document-format.ts` classifies Markdown, HTML, DOCX, XLSX, PPTX, PDF, text, CSV, common image/audio/video formats and archives. Recognized filename extensions take precedence over MIME metadata; MIME lookup is used when the filename has no recognized extension. This is a detection contract only and does not imply that a viewer/editor for every listed format is implemented.


- `src/core/domain/document-source.ts` defines the text DocumentSource, binary document storage contracts, document metadata/records, attachment metadata and sync-state types.
- `src/infrastructure/storage/local-document-source.ts` implements local text document CRUD and Blob-preserving binary document CRUD through Dexie.
- `src/modules/documents/OfficeDocumentViewer.tsx` adapts the locally vendored engine in `src/vendor/office-engine` for Office and other non-HTML binary documents. `src/modules/documents/html/HtmlDocumentViewer.tsx` is a separate HTML adapter with its own bidirectional source/rendered-pane scroll synchronization. Its root fills and constrains the available document-viewer area so the source and preview panes own their intended scroll surfaces.
- Document metadata includes repository ID, optional relative path, optional baseSha, and sync state: local, clean, dirty or conflict.
- `src/core/domain/workspace-file-system.ts` defines VFS contracts and path helpers.
- `src/infrastructure/storage/local-workspace-file-system.ts` implements local folder/file listing, folder creation, document registration, rename, move and recursive deletion.
- File/folder nodes live in Dexie fileNodes; file nodes reference text or binary documents by stable document ID.
- Folder/file rename and move update descendant paths and linked document metadata in one IndexedDB transaction.
- Removing a file/folder removes linked documents from local note storage.
- Existing notes are migrated into a Notes directory with stable document IDs. Dexie schema version 6 adds a separate `binaryDocuments` table; the migration is additive and retains the existing gitnote-local database.
- Binary workspace file storage preserves file bytes as Blob records, separate from text notes. The unified sidebar tree displays notes and binary files together and supports folder selection, folder creation, Markdown note creation, blank DOCX/XLSX/PPTX creation and supported-file import. New Office documents are generated locally through the vendored engine's `parasToDocx`, `rowsToXlsx` and `blankPptx` builders, then registered atomically in the VFS and opened in their format-specific editor. The default destinations remain `Notes/` for new notes and `Documents/` for Office creation/import when no folder is selected.
- `src/vendor/office-engine` contains the runtime TypeScript source required by GitNotes from upstream `p10node/office-engine` tag `v0.18.0` (MIT), pinned to commit `d7126505a00a431529d479c11d8d3372aeaf6cd0`. GitNotes imports and compiles this source directly; `@p10node/office-engine` is not an npm dependency, and neither build nor runtime requires access to the upstream GitHub repository or npm. React and React DOM are provided by GitNotes. DOCX, XLSX and PPTX use the local engine; HTML uses a dedicated GitNotes adapter over the same engine, with separate proportional bidirectional scroll synchronization between its source pane and rendered document pane. GitNotes currently exposes DOCX, XLSX, PPTX, Markdown, HTML, SVG and PDF in its import picker and persists imported files as Blob records. Imported filenames are validated as single path segments; digits including `0` are valid, while path separators and NUL are rejected. Editable formats persist changes through the `onSave` Blob callback; PDF remains read-only. Legacy Office/OpenDocument and CSV/plain-text conversions are not exposed yet because the engine can save those formats under a different extension; GitNotes still needs atomic VFS path updates for format conversion. This is a format-specific adapter, not the shared document-opening contract for every format. Attachment metadata shape exists, but note-scoped attachment ownership/lifecycle and UI remain unimplemented.

### Workspace model

- WorkspaceManager separates registered repositories, globally open tabs, active-tab selection and active repository.
- Local workspace repository is registered by the app.
- Workspace snapshots are persisted in Dexie.
- The UI currently works with the local workspace only; Markdown notes and binary documents now share one format-neutral tab strip. Multi-repository UI and remote loading are not implemented.
- Remote capability checks exist in the domain model, but there is no GitHub transport to execute remote operations.

## Current automated quality gates

- npm test: Vitest unit tests.
- npm run test:e2e: Playwright browser tests; CI installs Chromium and runs them.
- npm run build: TypeScript project build and Vite production build.
- GitHub Actions workflow: .github/workflows/ci.yml, with independent Unit tests, Browser tests (Chromium) and Production build jobs.
- Playwright failure artifacts include HTML report, screenshots and traces.
- Scroll regression coverage checks Source and Live continuity, Preview synchronization, independent positions for separate notes, Preview image-load/ResizeObserver notifications, Live's simultaneous bidirectional Source/Preview synchronization, and small fractional mouse-wheel increments in Live. Office Chromium coverage builds minimal valid DOCX/XLSX/PPTX fixtures and verifies import, in-editor content changes, explicit Save callbacks, IndexedDB persistence and edited content after reload. HTML Chromium coverage verifies independent bidirectional proportional scrolling between the source and rendered document panes, including that both panes overflow within the constrained viewer area. Minimap coverage verifies Lezer-derived line marks, pointer mapping, click navigation and dragging in Source, Live and Preview. Outline unit tests cover ATX/Setext parsing and code exclusion; Chromium coverage verifies outline navigation in all three modes and live updates after editing. Line-wrapping coverage checks long lines in Source and Live and guards against horizontal overflow. Cross-mode scroll restoration compares the coordinator's logical position with the CodeMirror 6 adapter's `readPosition()` result through a development-only E2E hook; it does not infer editor position from DOM line geometry.
- Do not mark a commit verified unless all three latest CI jobs pass.

## Roadmap and status

### Stage 0: local workspace/editor foundation

- [x] Introduce DocumentSource and local IndexedDB adapter.
- [x] Add document path, base SHA and sync-state metadata.
- [x] Introduce local VFS domain contract and IndexedDB implementation.
- [x] Add folder creation, atomic document-plus-file creation, file registration, rename, move and recursive delete operations.
- [x] Preserve CodeMirror EditorState per document tab.
- [x] Use Lezer syntax-tree information for Markdown-aware minimap structure and preview scroll anchors.
- [x] Verify per-tab cursor, selection, scroll and undo history in Chromium.
- [x] Add/verify visual browser regression coverage for Source and Live.
- [x] Fix all failures in the latest CI browser-test run.
- [x] Keep project documentation synchronized with actual implementation.

### Stage 1: Markdown editing experience

- [x] Syntax highlighting for Java and Python in Markdown fenced code blocks, selected by the language tag after the opening fence. This is highlighting only; no language-specific completion, diagnostics, compilation or execution.
- [x] Line wrapping in Source and Live, enabled by default through CodeMirror 6.
- [x] Outline navigation with Lezer-based headings and synchronized scrolling across Source, Live and Preview.
- [x] Minimap with synchronized click/drag navigation and Chromium coverage.
- [x] Live mode with side-by-side Source and Preview panes and bidirectional synchronized scrolling.
- [ ] Interactive task-list checkboxes that update Markdown source.
- [ ] [[ suggestions.
- [ ] Insert URL on selected text.
- [x] Markdown print support through a sanitized, format-specific browser print document.
- [ ] Search/replace UX and explicit heading folding behavior as needed.

### Stage 2: file management and navigation

- [x] Initial visible file/folder tree backed by the repository VFS; folder selection, folder creation, note creation and supported-file import work within the selected folder. Rename/move controls and broader format handlers remain planned.
- [ ] Rename/move with Markdown-link rewriting.
- [x] On-demand global content search across local Markdown notes, DOCX, XLSX, PPTX, HTML and SVG files.
- [x] Persistent IndexedDB search index using per-document extracted text and a multi-entry trigram index for exact substring candidate selection.
- [ ] Backlinks.
- [ ] Hide only GitNotes-owned marker files; keep user dotfiles visible.

### Stage 3: images and attachments

- [ ] Note-scoped attachment manager and storage lifecycle.
- [ ] Image insertion, drag/drop, resize and context menu.
- [ ] External images and safe handling.
- [ ] Deleting a note and its owned attachments as one logical operation, with safeguards for shared references.

### Stage 4: multi-format document support

The goal is format-appropriate experiences within one workspace, not a single Markdown editor with file previews bolted on.

- [ ] Shared document-opening contract and format capability model (view, edit, import, export, print), without assuming every format supports every operation.
- [x] Shared workspace Download and Print actions for Markdown and imported binary documents; each format delegates printing to its own renderer.
- [x] Separate Blob-preserving IndexedDB storage for binary workspace documents, including atomic VFS registration, path updates and recursive deletion.
- [x] Read-only PDF viewer using the browser's native PDF renderer; system print and original-file download only.
- [x] DOCX viewer and editing strategy: browser-local editing through the locally vendored office-engine source.
- [x] XLSX viewer and editing strategy: browser-local editing through the locally vendored office-engine source.
- [x] PPTX viewing/editing scope: browser-local editing through the locally vendored office-engine source.
- [x] Create blank DOCX, XLSX and PPTX files locally through the vendored engine and open them in the matching editor.
- [ ] Sandboxed HTML preview and HTML editing strategy.
- [x] Initial filename/MIME format detection for common text, Office, PDF, media and archive types. Format-specific dispatch remains planned.
- [ ] Lazy-load heavy viewers/editors and define import/export behavior per format.

### Stage 5: GitHub integration

Only after editor and local workspace foundations are ready:

- [ ] GitHub repository registration and repository picker.
- [ ] Separate OAuth App and server-side authorization flow.
- [ ] GitHub API adapter implementing document source/remote repository contracts.
- [ ] Repository-scoped Working Tree and explicit change review.
- [ ] Batch/atomic commits for multi-file operations.
- [ ] Branch SHA conflict detection and conflict resolution.
- [ ] History and explicit push/sync actions.
- [ ] Queue/rate-limit remote mutations and never overwrite remote changes automatically.

## Known limitations and cautions

- The sidebar now renders one recursive VFS tree for notes and binary files; the separate Notes and Documents lists have been removed. Users can select a folder, create a child folder, create a Markdown note or blank DOCX/XLSX/PPTX document in that folder, and import currently supported file formats into it. File-type icons are color-coded consistently in the tree and Create menu. Existing `Notes/` and `Documents/` paths remain intact and visible as ordinary folders.
- File-tree rename/move controls, drag-and-drop, recursive delete from the tree, and a general format-handler/opening contract are not implemented yet. Existing VFS rename/move/delete operations remain available at the storage layer.
- Legacy Office/OpenDocument, CSV and plain-text conversion imports are intentionally not exposed until converted output names/extensions can be updated atomically in the VFS. PDF is read-only and relies on browser-native PDF support.
- The VFS does not yet rewrite Markdown links or maintain backlinks. Global search currently scans local content on demand rather than maintaining a persistent index. PDF content is not indexed; the native browser PDF viewer does not expose its text layer to the application.
- Attachments are metadata-only at this stage.
- No remote GitHub repository manager, OAuth, GitHub API integration, commits, pushes or remote conflict UI exists.
- Do not claim roadmap items are implemented until source, tests and user-visible UI confirm them.
- CI run `45925386493` on commit `060a43a` passed unit tests and production build but reported 2 failed, 2 flaky and 6 passed Chromium tests. Trace review showed several browser tests began typing immediately after clicking the asynchronous Create Note action, before the new tab became active. Browser tests now wait for the new tab before editing. New note and VFS file creation are also one IndexedDB transaction. CI run `45925981117` on commit `a6f51de` passed all three required jobs (unit tests, Chromium browser tests and production build).
- CI run `45926418333` on commit `ab3f8cd`: unit tests and production build passed; all four new IndexedDB migration browser tests failed before reaching the app because their fixture used `about:blank`, where Chromium denies IndexedDB access for the opaque origin. The fixture was moved to an inert same-origin document in commit `70d38e1`.
- CI run `45929669574` on commit `70d38e1`: unit tests and production build passed; 3 migration browser tests failed because the fixture opened raw IndexedDB versions `1`–`4`, but Dexie schema versions `1.0`–`4.0` map to native IndexedDB versions `10`–`40`. The fixture therefore did not represent the historical Dexie databases and some tests were false positives. Commit `810a21b` changed the seed helper to use `version * 10` and check the native DB version.
- CI run `45930037415` on commit `810a21b`: unit tests and production build passed; 12 browser tests passed and 2 migration tests failed. The v3 migration itself preserved the workspace; its UI assertion matched both the tab label and breadcrumb, so it now uses an exact text match. The v4 migration preserved all three records, but the test incorrectly expected the oldest note to open first; the app sorts notes by updatedAt descending, so the newest note (`Traversal`) is active. The v1 migration test now also asserts the final native IndexedDB version is 50, rather than relying only on the welcome-note UI.
- CI run `45930326700` on commit `c07bcc9`: unit tests and production build passed; 13 of 14 Chromium tests passed. The remaining v3 migration failure was an incorrect expected path in the test: migration fallback paths use the normalized title plus the first eight characters of the document ID, matching the version 2 migration test. The expected path is `Notes/workspace-note-legacy-n.md`; no migration implementation change is required.
- CI run `45939534273` on commit `816748e`: unit tests and production build passed, but Chromium failed the per-note scroll-restoration workflow. A later attempt to use CodeMirror 6 native scroll snapshots also failed the same browser scenario; native snapshots were removed so the logical coordinator remains the sole scroll-position owner.

- CI run `45931056613` on commit `e99dc0e`: all three required jobs passed (Unit tests, Browser tests (Chromium), Production build). The v3 migration browser assertion was corrected to expect the normalized fallback path produced by the migration.
- CI run `45942368099` on PR merge commit `fafedc6`: unit tests and production build passed; 14 of 15 Chromium tests passed. The per-note scroll-restoration test failed after switching away from and back to a note (expected scrollTop above 1549, received 7). The StrictMode coordinator-lifecycle hypothesis did not resolve it. CI run `45946180242` on PR merge commit `5696b3c`: unit tests and production build passed; 14 of 15 Chromium tests passed. The same test now failed earlier, on the first Source-to-Preview switch (Preview scrollTop remained 0). Trace/code inspection identified the cause: cleanup read the Source surface after React had hidden it; `isConnected` remained true, but its scroll offset had reset. The coordinator must not read any surface during detach and must retain the last scroll-event position. Preview DOM is keyed by document ID to prevent reuse across notes.

## Vendored office-engine maintenance policy

- The source in `src/vendor/office-engine` is the authoritative engine code used by GitNote. Do not replace it with an npm dependency, Git dependency, remote runtime import or build-time download.
- The current baseline is upstream `p10node/office-engine` tag `v0.18.0`, commit `d7126505a00a431529d479c11d8d3372aeaf6cd0`, under the MIT license. Keep the upstream provenance and license files with the vendored code.
- Updates are manual, selective and controlled. Review upstream releases/commits and import only changes that fix a relevant defect, address a security issue or provide a capability GitNote actually needs. Do not follow upstream `HEAD` automatically.
- Do not import unrelated upstream components such as `packages/convert`, server/Docker services, playgrounds, examples, upstream tests or build infrastructure unless a separately approved GitNote requirement needs them.
- For each update, record the exact upstream tag/commit in `src/vendor/office-engine/UPSTREAM.md`; inspect the changed files, dependency and license implications, and adapt only the required runtime source. Preserve GitNote-specific adapters and integration code outside the vendored engine.
- Verify the production TypeScript/Vite build, unit tests and Chromium workflows for DOCX, XLSX, PPTX and HTML. A vendor update is complete only after all three required CI jobs pass for the resulting `main` commit.
