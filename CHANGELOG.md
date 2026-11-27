# Changelog

All notable changes to GitNotes are documented here.

## [Unreleased]

### Added
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
