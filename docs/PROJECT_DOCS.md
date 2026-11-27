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

- React application shell with local note list, global document tabs and a document title field.
- Create, select, rename and delete local notes. New note records and their VFS file nodes are created in one IndexedDB transaction.
- Debounced local autosave through IndexedDB/Dexie.
- Local-only status is shown; GitHub authentication and remote repository selection are not implemented.
- Startup safely handles the React StrictMode double invocation: if another initialization pass creates the `Notes` folder first, the second pass confirms the folder exists and continues.
- Search, settings and attachment controls are placeholders/disabled.
- The current UI does not yet expose a navigable folder tree, even though the VFS storage layer exists.

### Markdown editor

- CodeMirror 6 with Source, Live and Preview modes. Long Markdown lines wrap in the editable Source pane in both Source and Live modes; horizontal scrolling is not required for ordinary prose.
- Markdown language extension and basic editor facilities: line numbers, fold gutter, active line, bracket matching, close brackets, autocomplete and indentation.
- Formatting toolbar: bold, italic, strikethrough, inline code, link, H1/H2, bullet/numbered lists, quote, horizontal rule, undo and redo.
- Keyboard shortcuts for common inline formatting.
- Preview uses Marked with GFM and DOMPurify sanitization.
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
- `src/modules/documents/OfficeDocumentViewer.tsx` adapts `@p10node/office-engine` to the workspace: imported files are opened from their stored Blob and the editor's save callback writes the edited Blob back to IndexedDB.
- Document metadata includes repository ID, optional relative path, optional baseSha, and sync state: local, clean, dirty or conflict.
- `src/core/domain/workspace-file-system.ts` defines VFS contracts and path helpers.
- `src/infrastructure/storage/local-workspace-file-system.ts` implements local folder/file listing, folder creation, document registration, rename, move and recursive deletion.
- File/folder nodes live in Dexie fileNodes; file nodes reference text or binary documents by stable document ID.
- Folder/file rename and move update descendant paths and linked document metadata in one IndexedDB transaction.
- Removing a file/folder removes linked documents from local note storage.
- Existing notes are migrated into a Notes directory with stable document IDs. Dexie schema version 6 adds a separate `binaryDocuments` table; the migration is additive and retains the existing gitnote-local database.
- Binary workspace file storage preserves imported bytes as Blob records, separate from text notes. The sidebar can import supported Office and text/document formats into `Documents/`, list them, reopen them after reload, and remove them through the VFS.
- `@p10node/office-engine` 0.18.0 (MIT) provides browser-local viewing/editing for DOCX, XLSX and PPTX. GitNotes currently exposes DOCX, XLSX, PPTX, Markdown, HTML and SVG in its import picker and persists edited output through the `onSave` Blob callback. Legacy Office/OpenDocument and CSV/plain-text conversions are not exposed yet because the engine can save those formats under a different extension; GitNotes still needs atomic VFS path updates for format conversion. This is a format-specific adapter, not the shared document-opening contract for every format. Attachment metadata shape exists, but note-scoped attachment ownership/lifecycle and UI remain unimplemented.

### Workspace model

- WorkspaceManager separates registered repositories, globally open tabs, active-tab selection and active repository.
- Local workspace repository is registered by the app.
- Workspace snapshots are persisted in Dexie.
- The UI currently works with the local workspace only; multi-repository UI and remote loading are not implemented.
- Remote capability checks exist in the domain model, but there is no GitHub transport to execute remote operations.

## Current automated quality gates

- npm test: Vitest unit tests.
- npm run test:e2e: Playwright browser tests; CI installs Chromium and runs them.
- npm run build: TypeScript project build and Vite production build.
- GitHub Actions workflow: .github/workflows/ci.yml, with independent Unit tests, Browser tests (Chromium) and Production build jobs.
- Playwright failure artifacts include HTML report, screenshots and traces.
- Scroll regression coverage checks Source and Live continuity, Preview synchronization, independent positions for separate notes, Preview image-load/ResizeObserver notifications, Live's simultaneous bidirectional Source/Preview synchronization, and small fractional mouse-wheel increments in Live. Office Chromium coverage builds minimal valid DOCX/XLSX fixtures and verifies import, in-editor content changes, explicit Save callbacks, IndexedDB persistence and edited content after reload. Minimap coverage verifies Lezer-derived line marks, pointer mapping, click navigation and dragging in Source, Live and Preview. Outline unit tests cover ATX/Setext parsing and code exclusion; Chromium coverage verifies outline navigation in all three modes and live updates after editing. Line-wrapping coverage checks long lines in Source and Live and guards against horizontal overflow. Cross-mode scroll restoration compares the coordinator's logical position with the CodeMirror 6 adapter's `readPosition()` result through a development-only E2E hook; it does not infer editor position from DOM line geometry.
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

- [ ] Language mode selected by file extension.
- [x] Line wrapping in Source and Live, enabled by default through CodeMirror 6.
- [x] Outline navigation with Lezer-based headings and synchronized scrolling across Source, Live and Preview.
- [x] Minimap with synchronized click/drag navigation and Chromium coverage.
- [x] Live mode with side-by-side Source and Preview panes and bidirectional synchronized scrolling.
- [ ] Interactive task-list checkboxes that update Markdown source.
- [ ] [[ suggestions.
- [ ] Insert URL on selected text.
- [ ] Print support.
- [ ] Search/replace UX and explicit heading folding behavior as needed.

### Stage 2: file management and navigation

- [ ] Visible file/folder tree.
- [ ] Rename/move with Markdown-link rewriting.
- [ ] Search index (MiniSearch or equivalent).
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
- [x] Separate Blob-preserving IndexedDB storage for binary workspace documents, including atomic VFS registration, path updates and recursive deletion.
- [ ] PDF viewer and defined PDF interaction scope.
- [x] DOCX viewer and editing strategy: browser-local editing through `@p10node/office-engine`.
- [x] XLSX viewer and editing strategy: browser-local editing through `@p10node/office-engine`.
- [x] PPTX viewing/editing scope: browser-local editing through `@p10node/office-engine`.
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

- The visible UI is still a flat notes list, not the VFS tree.
- The initial document import/open workflow currently lists binary documents separately from Markdown notes; the full navigable VFS tree and shared multi-format tab model are not implemented.
- Legacy Office/OpenDocument, CSV and plain-text conversion imports are intentionally not exposed until converted output names/extensions can be updated atomically in the VFS. PDF viewing is not implemented.
- Local VFS operations exist as a storage/domain service; they are not yet exposed as normal user-facing file manager workflows.
- The VFS does not yet rewrite Markdown links or maintain backlinks/search indexes.
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
