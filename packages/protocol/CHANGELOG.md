# Changelog

## [Unreleased]

### Breaking Changes

- Restricted assistant and tool transcript lifecycle schemas to valid state combinations and terminal items.
- Replaced `SessionSummarySchema` and `SessionSummary` with durable `SessionMetadataSchema` and `SessionMetadata` for session lists; runtime state remains in acquired `SessionSnapshot` values ([#7708](https://github.com/earendil-works/pi/pull/7708)).

### Added

- Added transport-neutral CBOR protocol schemas, codecs, and length-prefixed framing for remote pi sessions.
- Added `not_implemented` and `internal_error` protocol error codes for sanitized server failures ([#7644](https://github.com/earendil-works/pi/pull/7644)).

### Changed

- Updated the test runner to Vitest 5.0.1. ([#1895](https://github.com/code-yeongyu/senpi/issues/1895))

- Updated the bundled dependencies: typebox 1.3.27 -> 1.3.34. ([#1895](https://github.com/code-yeongyu/senpi/issues/1895))

- Updated the shared TypeBox runtime to 1.3.18, keeping RPC schemas aligned with all runtime consumers.
