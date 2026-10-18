# Changelog

## [Unreleased]

### Added

- Added the callback-based telemetry context contract, shared no-op context, deterministic in-memory reference adapter, reusable adapter conformance suite, typed serializable schema utilities, and multi-schema typed span starters with explicit child propagation.
- Adopted telemetry into Senpi's private CalVer workspace and owned `@code-yeongyu/senpi-telemetry` publish alias;
  coding-agent tarballs now bundle its real runtime files instead of relying on an upstream registry artifact.

### Changed

- Updated the test runner to Vitest 5.0.1. ([#1895](https://github.com/code-yeongyu/senpi/issues/1895))

- Updated the development dependencies: @types/node 26.2.0 -> 26.6.2. ([#1895](https://github.com/code-yeongyu/senpi/issues/1895))
