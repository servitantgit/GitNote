# GitNotes architecture

## Principles

1. Local-first editing: typing and ordinary note operations update local state/storage only.
2. Git operations are explicit and separate from local persistence.
3. Repository context is carried with every document/change. Remote operations must not depend on a mutable global repository pointer.
4. Modules communicate through small contracts; do not introduce plugin infrastructure without a concrete need.
5. UI styles are scoped by module, with shared tokens in `src/shared/styles`.

## Current implementation

- `src/app`: application shell, local note list, document tabs and workspace orchestration.
- `src/modules/editor`: CodeMirror 6 editor with Source, Live Preview and Preview modes, Markdown formatting commands, selection-aware editing and reading statistics.
- `src/infrastructure/storage`: Dexie database and local note/draft/workspace stores.
- `src/core/domain`: repository capabilities, globally scoped workspace tabs and Working Tree model.
- `e2e`: Playwright browser-level regression tests.

## Editor behavior

- Source and Live Preview share one persistent CodeMirror 6 instance. Switching to Preview hides the editor without destroying its undo history or selection.
- The formatting toolbar supports bold, italic, strikethrough, inline code, links, headings, lists, blockquotes and horizontal rules. Source mode keeps the text surface free of active-line highlighting; the CodeMirror scroller is the only scroll container to keep pointer coordinates and text selection aligned.
- Live Preview preserves Markdown syntax inside fenced code blocks and inline code spans.
- Undo/redo use CodeMirror history. CodeMirror's standard editing keymaps and search panel remain available.
- Preview renders GitHub-Flavored Markdown through Marked and sanitizes generated HTML with DOMPurify before insertion.
- Editor content remains controlled by the active local note and is autosaved by the local note store.

## Automated quality gates

Every feature change must include regression coverage appropriate to its behavior:

- Unit tests cover pure functions, domain rules, state transitions and error cases.
- Component/integration tests cover React interactions and storage boundaries where practical.
- Playwright tests cover user-visible workflows and regressions that depend on the browser, DOM, IndexedDB, keyboard input, layout or navigation.
- CI runs unit tests, Chromium browser tests and the production build independently. A change is not considered verified until all three jobs pass.
- Bug fixes should add a regression test that fails before the fix and passes after it.
- Browser-test failures retain traces/screenshots as CI artifacts to make diagnosis reproducible.

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

Notes are stored in IndexedDB in the `notes` table. Workspace snapshots are stored in the `workspaces` table. The Dexie database name remains `gitnote-local` to preserve data created by the previous GitNote foundation. Schema version 3 adds workspace snapshots without recreating the existing notes store.

## Planned boundaries

- `git-engine`: repository-scoped operation journal, tree construction, commit batching, conflict detection and GitHub transport.
- `attachments`: note-scoped attachment lifecycle and format-handler registry.
- `documents`: format adapters for Markdown and office documents.
- `settings`, `help`, `search`: independent modules with versioned data/configuration.

These are planned boundaries, not claims that they are implemented.
