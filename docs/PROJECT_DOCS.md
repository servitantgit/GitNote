# GitNotes project reference

Last reviewed: 2026-11-27
Authoritative branch: main
Repository: https://github.com/servitantgit/GitNote
Deployment: https://gitnotes.pages.dev/

This document records the repository's current implementation and approved direction. Source code and tests on main remain authoritative if this document becomes stale.

## Product

GitNotes is a local-first workspace for notes and documents with Git version control and storage in user-owned GitHub repositories. The product direction is OneNote + Git. It is not primarily a collaborative Google Docs clone, an Obsidian graph, or a code IDE.

Desktop/laptop is the primary work environment. Mobile is intended mainly for quick notes and reading. MD-Editor is a separate existing product; do not modify its repository or deployment as part of GitNotes work.

## Approved product and technical decisions

- React, TypeScript and Vite.
- CodeMirror 6 as the editor engine.
- IndexedDB with Dexie for local persistence; database name is gitnote-local.
- Vitest for unit tests and Playwright/Chromium for browser tests.
- DocumentSource separates editor/document operations from storage and remote transport.
- WorkspaceFileSystem defines repository-scoped file and folder operations.
- Local-first behavior: typing, autosave and file operations do not create GitHub commits.
- GitHub repository manager, GitHub API transport and OAuth are intentionally deferred until the editor/local workspace is ready.
- Keep Live Preview as inline Markdown-formatted editing. A separate 50/50 Split mode is planned, not a replacement.
- Per-tab CodeMirror state is retained so text, selection and undo history do not cross-contaminate documents.
- Tabs remain globally open. Inactive-repository tabs remain locally editable; remote operations are disabled until that repository is explicitly active.
- No automatic commit, push or sync.
- Note attachments are note-scoped, not stored in one shared global assets folder.

## Current implementation

### Application shell and notes

- React application shell with local note list, global document tabs and a document title field.
- Create, select, rename and delete local notes.
- Debounced local autosave through IndexedDB/Dexie.
- Local-only status is shown; GitHub authentication and remote repository selection are not implemented.
- Startup safely handles the React StrictMode double invocation: if another initialization pass creates the `Notes` folder first, the second pass confirms the folder exists and continues.
- Search, settings and attachment controls are placeholders/disabled.
- The current UI does not yet expose a navigable folder tree, even though the VFS storage layer exists.

### Editor

- CodeMirror 6 with Source, Live Preview and Preview modes.
- Markdown language extension and basic editor facilities: line numbers, fold gutter, active line, bracket matching, close brackets, autocomplete and indentation.
- Formatting toolbar: bold, italic, strikethrough, inline code, link, H1/H2, bullet/numbered lists, quote, horizontal rule, undo and redo.
- Keyboard shortcuts for common inline formatting.
- Preview uses Marked with GFM and DOMPurify sanitization.
- Live Preview decorates Markdown syntax. Lezer syntax-tree ranges identify fenced and inline code so formatting does not alter code contents; remaining presentation transformations are line-oriented.
- A map keyed by document ID retains CodeMirror EditorState between tab switches, including undo history and selection. Scroll restoration must be verified/finished separately.
- No split-pane editor, Outline, minimap, language-by-extension selection, wiki-link completion, search/replace UX, interactive preview checkboxes or image-management workflow yet.

### Document domain and storage

- src/core/domain/document-source.ts defines DocumentSource, document metadata/records, attachment metadata and sync-state types.
- src/infrastructure/storage/local-document-source.ts implements local document CRUD through Dexie.
- Document metadata includes repository ID, optional relative path, optional baseSha, and sync state: local, clean, dirty or conflict.
- src/core/domain/workspace-file-system.ts defines VFS contracts and path helpers.
- src/infrastructure/storage/local-workspace-file-system.ts implements local folder/file listing, folder creation, document registration, rename, move and recursive deletion.
- File/folder nodes live in Dexie fileNodes; file nodes reference documents by stable document ID.
- Folder/file rename and move update descendant paths and linked document metadata in one IndexedDB transaction.
- Removing a file/folder removes linked documents from local note storage.
- Existing notes are migrated into a Notes directory with stable document IDs. The Dexie schema is currently version 5; migrations are additive and retain the existing gitnote-local database.
- Attachment metadata shape exists, but attachment bytes, lifecycle operations, UI and preview handlers are not implemented.

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
- GitHub Actions workflow: .github/workflows/ci.yml, with independent Unit tests, Browser tests (Chromium), and Production build jobs.
- Playwright failure artifacts include HTML report, screenshots and traces.
- Do not mark a commit verified unless all three latest CI jobs pass.

## Roadmap and status

### Stage 0: local workspace/editor foundation

- [x] Introduce DocumentSource and local IndexedDB adapter.
- [x] Add document path, base SHA and sync-state metadata.
- [x] Introduce local VFS domain contract and IndexedDB implementation.
- [x] Add folder creation, file registration, rename, move and recursive delete operations.
- [x] Preserve CodeMirror EditorState per document tab.
- [x] Use Lezer syntax-tree information to protect code ranges in Live Preview.
- [ ] Verify and complete migration coverage for all pre-VFS IndexedDB states.
- [ ] Verify per-tab cursor, selection, scroll and undo history in Chromium.
- [ ] Add/verify visual browser regression coverage for Source and Live Preview.
- [ ] Fix all failures in the latest CI browser-test run.
- [x] Show local database initialization failures in the shared workspace shell, including when no active note exists.
- [ ] Keep project documentation synchronized with actual implementation.

### Stage 1: editor core

- [ ] Language mode selected by file extension.
- [ ] Line wrapping.
- [ ] Outline.
- [ ] Minimap.
- [ ] Separate 50/50 Split mode with synchronized scrolling.
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

### Stage 4: document viewers/adapters

- [ ] PDF viewer.
- [ ] DOCX viewer.
- [ ] XLSX viewer.
- [ ] PPTX viewing support (not present in MD-Editor baseline).
- [ ] Sandboxed HTML preview.
- [ ] Lazy-load heavy viewers/adapters and add print/export behavior.

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
- Local VFS operations exist as a storage/domain service; they are not yet exposed as normal user-facing file manager workflows.
- The VFS does not yet rewrite Markdown links or maintain backlinks/search indexes.
- Attachments are metadata-only at this stage.
- No remote GitHub repository manager, OAuth, GitHub API integration, commits, pushes or remote conflict UI exists.
- Do not claim roadmap items are implemented until source, tests and user-visible UI confirm them.
- The latest CI run before the StrictMode startup fix (commit `f1d6a45`) passed unit tests and production build but failed all 10 Chromium tests during app initialization. The visible error was `Path already exists: Notes`: React StrictMode invoked the initialization effect twice, and both passes raced to create the same folder. Startup now rechecks the folder after a create conflict. The fix remains unverified until all CI jobs pass on the new commit.