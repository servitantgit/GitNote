# Changelog

All notable changes to GitNotes are documented here.

## [Unreleased]

### Added
- Desktop minimap for Markdown documents, with Lezer-based structure marks, cursor and viewport indicators, and click/drag navigation synchronized across Source, Live Preview and Preview.
- Chromium regression coverage for minimap navigation in all three editor modes.
- Separate 50/50 Split mode with simultaneous editable Source and rendered Preview panes, using the existing bidirectional scroll coordinator.
- Chromium regression coverage for Split layout, live rendering and bidirectional scroll synchronization.

### Changed
- Updated editor architecture and project documentation for the Split mode and its shared scroll-coordinator integration.
