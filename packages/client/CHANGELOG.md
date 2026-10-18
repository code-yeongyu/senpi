# Changelog

## [Unreleased]

### Breaking Changes

- Replaced `SessionSummary` with durable `SessionMetadata` for `PiClient.listSessions()` and server snapshots; runtime state is available only from acquired session snapshots ([#7708](https://github.com/earendil-works/pi/pull/7708)).

### Added

- Added the experimental transport-neutral `PiClient` and multi-session `PiSessionHandle` APIs with structured `PiServerError` responses.

### Changed

- Updated the test runner to Vitest 5.0.1. ([#1895](https://github.com/code-yeongyu/senpi/issues/1895))
