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
- `src/core/domain`: repository capabilities and Working Tree model.
- `src/core/contracts`: module contract types.

## Local note persistence

Notes are stored in IndexedDB in the `notes` table. Each note has a stable ID, repository ID, title, content, and timestamps. The current starter uses a single local workspace ID. Autosave is debounced and does not create commits or contact GitHub.

## Planned boundaries

- `git-engine`: local Working Tree journal, tree construction, commit batching, conflict detection and GitHub transport.
- `attachments`: note-scoped attachment lifecycle and format-handler registry.
- `documents`: format adapters for Markdown and office documents.
- `settings`, `help`, `search`: independent modules with versioned data/configuration.

These are planned boundaries, not claims that those modules are implemented.
