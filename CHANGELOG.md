# Changelog

All notable changes to GitNotes are documented here.

## [Unreleased]

### Added
- Desktop minimap for Markdown documents, with Lezer-based structure marks, cursor and viewport indicators, and click/drag navigation synchronized across Source, Live Preview and Preview.
- Chromium regression coverage for minimap navigation in all three editor modes.
- Separate 50/50 Split mode with simultaneous editable Source and rendered Preview panes, using the existing bidirectional scroll coordinator.
- Chromium regression coverage for Split layout, live rendering and bidirectional scroll synchronization.

### Fixed
- Split Preview no longer drops small, slow mouse-wheel increments when they fall within the scroll coordinator's echo-suppression tolerance.

### Changed
- Tightened scroll echo detection and added unit and Chromium regression coverage for fractional wheel movement in Split mode.
- Updated editor architecture and project documentation for the Split mode and its shared scroll-coordinator integration.
