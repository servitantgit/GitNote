# GitNote architecture

## Principles

1. Local-first editing: typing and ordinary note operations update local state/storage only.
2. Git operations are explicit and separate from local persistence.
3. Repository context is carried with every document/change. Remote operations must not depend on a mutable global repository pointer.
4. Modules communicate through small contracts; do not introduce plugin infrastructure without a concrete need.
5. UI styles are scoped by module, with shared tokens in `src/shared/styles`.

## Current implementation

- `src/app`: application shell and local workspace orchestration.
- `src/modules/editor`: CodeMirror 6 editor surface, mode selector, and an inline decoration-based Live Preview subset.
- `src/infrastructure/storage`: Dexie database and local note/draft stores.
- `src/core/domain`: repository capabilities, globally scoped workspace tabs, and Working Tree model.

## Workspace manager

`WorkspaceManager` keeps repository registrations, globally open document tabs, active-tab selection, and active remote-repository focus as separate state.

- Selecting a tab does not silently activate its repository.
- Tabs belonging to inactive repositories remain open and locally editable.
- Remote read/sync/commit/push operations are permitted only for the explicitly active repository.
- Every tab carries its repository ID and branch; callers must use that context for document operations.
- Removing a repository also removes its tabs from the workspace snapshot. Local note data is not deleted by this domain operation.
- The manager is a pure domain service. Persistence and UI integration are separate layers.

## Local note persistence

Notes are stored in IndexedDB in the `notes` table. Each note has a stable ID, repository ID, title, content, and timestamps. The current starter UI still opens a single local workspace. The workspace manager is now implemented and tested as a domain layer; repository registration UI, durable workspace snapshot persistence, and remote Git operations remain future work.

## Planned boundaries

- `git-engine`: local Working Tree journal, tree construction, commit batching, conflict detection and GitHub transport.
- `attachments`: note-scoped attachment lifecycle and format-handler registry.
- `documents`: format adapters for Markdown and office documents.
- `settings`, `help`, `search`: independent modules with versioned data/configuration.

These are planned boundaries, not claims that they are implemented.
