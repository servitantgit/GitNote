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


### 4.1 Preventive architecture and maintainability

Architecture quality is a continuous responsibility, not cleanup deferred until a defect or large refactor makes it unavoidable.

- Before proposing an implementation, assess the affected architecture: module responsibilities, dependency direction, coupling, data flow, public interfaces, lifecycle ownership, and likely regression surfaces.
- Proactively identify design choices that could create avoidable technical debt, fragile upgrade paths, duplicated logic, hidden side effects, or expensive future migrations. Explain material risks and recommend preventive measures before implementation.
- Organize code by cohesive responsibility. Keep related types, logic and tests together behind clear module boundaries; avoid circular dependencies and unclear ownership.
- Keep files reasonably small and navigable. Split a growing module when it starts to contain multiple independent responsibilities. Do not let central components become dumping grounds for unrelated state or workflows.
- Avoid both extremes: monolithic files and excessive fragmentation into one-file-per-trivial-helper. A module should represent a meaningful responsibility with a clear interface.
- Prefer stable, explicit contracts between layers. Keep domain logic independent of infrastructure details and isolate external libraries, browser APIs and remote services behind appropriate adapters.
- Before dependency or framework upgrades, check release notes, breaking changes, supported versions, API changes and the impact on direct and transitive dependants. Plan compatibility tests for affected behavior; do not upgrade blindly.
- Add or preserve tests at module boundaries and for important end-to-end workflows so that future changes reveal regressions close to their source.
- Record material architectural decisions, constraints and migration implications in the appropriate documentation. Keep documentation aligned with the actual code, not aspirations.
- The agent must proactively propose worthwhile structural or preventive improvements when evidence from the current code supports them. Separate recommendations from the requested implementation scope; do not silently perform broad refactors or add abstractions without approval.
- Do not optimize for hypothetical future requirements at the expense of current clarity. Choose the simplest design that safely supports approved product direction and known extension points.

- Before implementing a capability that may already exist in the separate MD-Editor project, inspect its current source, tests and documented behavior. Reuse or adapt proven implementations and architectural patterns where they fit GitNotes; do not reinvent an equivalent feature merely because this is a separate repository. Treat MD-Editor as a reference implementation, not as permission to copy blindly: verify current behavior, dependencies, compatibility, security, licensing and fit with GitNotes' domain boundaries. Keep MD-Editor itself untouched.
- Apply the same reuse-first rule to standard UI primitives and workflows: dialogs, confirmation dialogs, prompts, alerts, menus, tooltips, dropdowns and similar common components. Check what MD-Editor already uses and what suitable components are already installed in GitNotes. Prefer reusing or importing a mature, maintained, accessible component/library over writing a basic replacement from scratch.
- Do not add a new UI dependency automatically. If no suitable existing component is available, assess a well-maintained library for compatibility, accessibility, bundle impact, licensing and API stability; explain the choice before adding it when the dependency meaningfully expands project scope.
- Build a custom component only when the required behavior or product design is genuinely specific and cannot be expressed cleanly by an existing implementation. Keep product-specific logic separate from reusable UI primitives.

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

## 8. Controlled task execution protocol

Apply this protocol to every implementation task. The goal is to make changes predictable, reviewable and reversible without preventing the agent from identifying defects in the task specification.

### 8.1 Preflight analysis

Before editing:

1. Read this file and `docs/PROJECT_DOCS.md` completely, then inspect the relevant implementation, tests, and recent history.
2. Confirm the current branch and HEAD. Do not base changes on stale summaries or an earlier checkout.
3. Classify the task as small, medium, complex or architectural. Identify high-risk areas, cross-module dependencies and likely regression surfaces.
4. Prepare an explicit scope:
   - files to modify and the intended change in each;
   - files and behavior that must remain untouched;
   - expected structural impact and relevant existing behavior to preserve.
5. Trace the affected behavior through its callers, data flow and tests. Identify edge cases and failure modes before choosing an implementation.
6. Define verification before coding: tests to add or update, existing tests to run, browser scenarios, build checks and any manual visual inspection required.

Do not start implementation while a material product or architecture decision remains ambiguous. Ask one focused question when the missing decision cannot be resolved from approved project requirements.

### 8.2 Change boundaries

- Preserve the existing file structure and unrelated code.
- Make the smallest coherent change that solves the requested problem.
- Do not rewrite whole files when a localized edit is sufficient.
- Do not reformat untouched code, reorder unrelated imports, remove comments, rename public symbols, add dependencies or perform neighboring refactors unless explicitly required and approved.
- Do not create files outside the agreed scope. If investigation proves an additional file is necessary, explain why and obtain approval before expanding scope.
- For high-risk files or broad changes, split implementation into reviewable atomic steps. These steps do not require separate commits.
- Inspect the diff after each meaningful step. Stop if unexpected deletions, unrelated changes or a substantial unexplained reduction in file content appears.

### 8.3 Specification deviation protocol

The agent is expected to identify mistakes in requirements and assumptions, not blindly implement known defects.

If the actual code, existing behavior or repository contract conflicts with the task description:

1. Stop before applying the conflicting change.
2. State what the task says and what the repository actually contains.
3. Explain the impact and why a deviation may be necessary.
4. Propose the smallest correction.
5. Wait for user approval before changing the agreed scope or product behavior.

Correcting an obvious locator typo is not permission to redesign adjacent code. Never silently reinterpret requirements, change expected behavior or weaken a test to make implementation pass.

### 8.4 Verification discipline

- Tests are part of the implementation, not optional cleanup. Add a regression test for each fixed defect when practical.
- A regression test must exercise the actual defect and should fail against the pre-fix behavior for the intended reason.
- Never change an assertion merely because the implementation disagrees. First establish the expected behavior from approved requirements, existing contracts and independent evidence. If the test is wrong, explain why and correct only that test.
- Do not remove, skip, loosen or make tests flaky to obtain a green result.
- Run the narrowest relevant tests during development, then the complete required suite: `npm test`, `npm run test:e2e` and `npm run build`, when the environment supports them.
- Check adjacent workflows and regression surfaces, not only the exact line changed.
- For UI changes, inspect the actual browser state. For visual defects, use screenshots or pixel-level comparison where possible; a passing DOM assertion alone does not prove visual correctness.
- If local execution is unavailable, state that explicitly. Use CI evidence and inspect failure logs, screenshots and traces. Never claim a check passed unless its result was observed.
- A CI result counts only when every required job has completed successfully for the exact latest commit being reported.

### 8.5 Diff review and commit policy

Before committing:

- Review the complete diff, not just the intended hunk.
- Confirm only scoped files changed and no generated files, secrets, unrelated formatting or accidental dependency changes are included.
- Confirm documentation accurately describes the resulting implementation and test status.
- Confirm all required local checks passed, or clearly record which checks could not be run.
- Prepare one logical commit for the completed task. Do not create intermediate commits and then a chain of avoidable corrective commits.
- If verification fails, diagnose the first failure and its root cause before editing again. Do not make speculative patches or repeatedly change assertions.
- After pushing, verify the branch head and all required CI jobs for that exact commit before reporting completion.

### 8.6 Failure and rollback

If a step fails or produces an unexpected result:

1. Stop further edits.
2. Record the failing step, exact error, affected files and expected versus actual behavior.
3. Determine whether the cause is the implementation, the test, the environment or an incorrect assumption.
4. Preserve the last known-good state. Revert only the task's changes when rollback is needed.
5. Report the diagnosis and proposed next action before attempting a materially different fix.

Do not conceal partial completion. Report what changed, what was verified, what failed or remains unverified, the commit SHA (if committed), and the specific rollback point.
