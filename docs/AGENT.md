# Agent instructions for GitNotes

These instructions are mandatory for every task in this repository.

## 1. Start with repository context

1. Read this file (docs/AGENT.md) completely.
2. Read docs/PROJECT_DOCS.md completely.
3. Read relevant source files and tests before proposing or changing implementation.
4. Treat the current repository state on the target branch as authoritative. Do not rely on old chat summaries or assumptions when they contradict the code.
5. Check the current branch head before writing. Use compare-and-swap when advancing a branch; never force-push.
6. If either required document is missing or stale, restore/update it before feature work.

## 2. Scope and change discipline

- Implement only the task explicitly requested.
- Do not refactor unrelated code, redesign adjacent UI, add speculative abstractions, or silently change product behavior.
- Preserve existing working behavior unless the task explicitly changes it.
- Ask one concise clarification only when an essential product decision is genuinely ambiguous. Do not ask the user to repeat decisions already recorded here.
- Keep changes small, reviewable, and grouped by purpose. Avoid unnecessary commits.
- Do not modify the separate MD-Editor repository or deployment.
- Do not claim completion until code, documentation and required verification are complete.

## 3. Product decisions that must be preserved

- GitNotes is a separate product from MD-Editor. Its direction is a local-first workspace for notes and documents with Git version control and user-owned GitHub repositories.
- The intended product analogy is OneNote + Git, not a Google Docs collaboration clone or an Obsidian knowledge-graph clone.
- Desktop/laptop is the primary work environment; mobile is mainly for quick notes and viewing.
- CodeMirror 6 is the selected editor engine. Do not reintroduce CodeMirror 5 APIs or unpinned CDN dependencies.
- Keep the three existing editor modes: Source, Live Preview (inline editing with Markdown formatting), and Preview (reading). A separate 50/50 Split mode is planned; do not silently replace Live Preview semantics.
- Preserve per-tab editor state: text, selection/cursor and undo history; preserve scroll position where implemented. Switching documents must not leak history or content.
- All opened tabs are global. A tab belonging to an inactive repository remains locally editable, but remote Git operations are disabled. Selecting a tab must not silently activate its repository.
- No automatic commit, push or remote synchronization. Local edits and file operations are staged locally; remote Git actions must be explicit and repository/branch scoped.
- Do not implement GitHub repository manager, GitHub API transport or OAuth before the editor and local workspace foundations are ready, unless the user explicitly changes this order.
- Notes own their attachments. Do not introduce one shared global attachment folder. Deleting a note must not leave unmanaged attachment clutter.
- Preserve the IndexedDB database name gitnote-local for compatibility with existing local data.

## 4. Architecture and implementation rules

- Keep React + TypeScript + Vite and CodeMirror 6.
- Keep domain contracts independent from browser storage and GitHub transport.
- Use DocumentSource for document CRUD. The current local IndexedDB implementation is the first adapter; a future GitHub adapter must not require rewriting the editor.
- Use WorkspaceFileSystem for repository-scoped virtual files and folders. Paths are normalized, relative to repository root, and unique within a repository.
- Keep file-tree operations transactional. Rename/move must update descendant paths and linked document metadata atomically. Recursive deletion must remove linked local documents consistently.
- Keep IndexedDB/Dexie schema upgrades additive and migration-safe. Never delete or recreate existing notes to simplify a migration. Add migration tests for existing data.
- Keep remote state explicit: path, optional baseSha, and sync state local | clean | dirty | conflict. A conflict must never be overwritten automatically.
- Use Lezer syntax-tree information for Markdown-aware editor behavior where code regions must be excluded. Regex-only Markdown parsing is not an acceptable substitute for structural syntax information.
- Sanitize rendered HTML. Do not insert unsanitized user-authored HTML into the DOM.
- Keep modules and CSS scoped. Avoid giant monolithic files and unnecessary frameworks or plugin systems.
- Lazy-load heavy format viewers/adapters where practical.
- Hide only GitNotes-owned marker files in a future file tree; do not hide arbitrary user dotfiles.

## 5. Testing and verification

- Unit tests cover pure functions, path rules, domain state transitions, parsers and error cases.
- Integration tests cover IndexedDB migrations, transactional file operations, document-source behavior and React/storage boundaries where practical.
- Playwright covers user-visible workflows, IndexedDB persistence, editor state, keyboard behavior, navigation, responsive layout and browser rendering.
- For visual issues, DOM assertions alone are insufficient. Use screenshots or pixel-level/visual inspection for the affected state, and retain CI artifacts.
- A browser test must wait for the app's actual ready state before interacting with the editor. Do not hide startup failures by weakening selectors or skipping assertions.
- Add a regression test for every fixed defect. The test should fail before the fix for the intended reason.
- Run npm test, npm run test:e2e and npm run build when the environment supports them. CI has independent unit, Chromium browser and production-build jobs.
- A workflow is fully verified only when all required jobs conclude success for the latest commit. Passing unit tests/build does not imply browser tests passed.
- If local browser execution is unavailable, state that explicitly and rely on CI; inspect failed logs, screenshots and traces rather than guessing.
- Do not report a test as passing based on a queued, started, cancelled or earlier-commit run.

## 6. Documentation and commits

- Update docs/PROJECT_DOCS.md whenever implementation, architecture, test setup, migrations or roadmap status changes.
- Update docs/ARCHITECTURE.md for material architecture changes and docs/MIGRATION.md for compatibility/schema migration changes.
- Clearly separate implemented, partially implemented and planned capabilities. Never describe a plan as a working feature.
- Keep this file stable; change it only when project-wide working rules or approved product decisions change.
- Use concise Conventional Commit messages, e.g. fix(editor): preserve per-tab selection.
- Before pushing, inspect the diff and ensure no generated artifacts, secrets, unrelated formatting or accidental lockfile changes are included.
- After pushing, report commit SHA, changed files, test/build status and remaining limitations accurately.

## 7. Security and data safety

- Treat note content, imported documents, filenames, URLs and repository metadata as untrusted input.
- Validate and normalize paths; prevent traversal, duplicate paths and moving a folder into itself/its descendants.
- Do not expose OAuth client secrets or access tokens in client bundles, logs, URLs, screenshots or committed files.
- Keep authorization scopes minimal and remote operations bound to the exact repository and branch.
- Do not force-push or overwrite a changed remote branch. Detect stale base SHAs and surface conflicts.
- Avoid irreversible local data changes without an explicit user action and a tested migration path.