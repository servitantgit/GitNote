# Changelog

All notable changes to GitNotes are documented here.

## [Unreleased]
- Add Java and Python syntax highlighting for Markdown fenced code blocks, selected by the fence language tag; no IDE features are included.
- Add an HTML-specific bidirectional scroll adapter between the source pane and rendered document pane, isolated from Markdown navigation synchronization.
- Constrain the HTML viewer to its host area so its source and rendered panes scroll internally instead of expanding the document layout.
- Add Chromium regression coverage for scrolling HTML source and rendered panes in both directions.

### Added
- Add local import, listing, opening and deletion for DOCX, XLSX, PPTX, Markdown, HTML and SVG, with browser-local editing and Blob saves through `@p10node/office-engine`.
- Add Chromium coverage for importing a document, verifying its Blob-backed VFS record and reopening it after reload.
- Add DOCX and XLSX Chromium roundtrip tests for real editor changes, explicit save callbacks and reopening the edited files after reload.
- Add PPTX Chromium roundtrip coverage for editing slide text, saving the presentation and reopening the edited file after reload.
- Blob-preserving IndexedDB storage for binary workspace documents, separate from text notes, with transactional VFS registration and lifecycle updates.
- Chromium regression coverage for binary Blob persistence, update, VFS rename and recursive deletion.
- Optional Markdown Outline panel with Lezer-based ATX/Setext heading navigation, active-section tracking and synchronized scrolling in Source, Live and Preview.
- Unit and Chromium regression coverage for Outline parsing, navigation and live updates.
- Default line wrapping for long Markdown source lines in Source and Live modes, with Chromium regression coverage for horizontal overflow.
- Desktop minimap for Markdown documents, with Lezer-based structure marks, cursor and viewport indicators, and click/drag navigation synchronized across Source, Live and Preview.
- Chromium regression coverage for minimap navigation in all three editor modes.
- Live mode with editable Source and rendered Preview panes side by side, using the existing bidirectional scroll coordinator.
- Chromium regression coverage for Live layout, live rendering and bidirectional scroll synchronization.

### Fixed
- Preview scroll mapping now uses rendered paragraph boundaries as well as heading and image anchors, preventing drift in long heading-free Markdown documents.
- CodeMirror scroll restoration now applies each synchronized position in one measured write, avoiding an intermediate scroll event that could cancel small Preview wheel movements.

### Changed
- Kept the existing scroll echo tolerance and added Chromium regression coverage for fractional wheel movement in Live mode.
- Consolidated the editor to exactly three modes: Source, Live and Preview; removed the former inline-formatting Live Preview mode.
- Updated editor architecture and project documentation for Live mode and its shared scroll-coordinator integration.
