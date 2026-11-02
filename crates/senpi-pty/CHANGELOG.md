# Changelog

## [Unreleased]

### Added

- `NativePtySession` exposes `pid` and `processGroupId` getters for the spawned child. ([#2108](https://github.com/code-yeongyu/senpi/issues/2108))

### Changed

- Updated the native build CLI to @napi-rs/cli 3.10.4. ([#1895](https://github.com/code-yeongyu/senpi/issues/1895))

### Fixed

- `PtySession::write` no longer blocks its caller while the child is not reading input. Input goes to a per-session writer thread, so a child that floods output without reading stdin can no longer freeze the JavaScript host in a two-way wait with the output reader. ([#3857](https://github.com/code-yeongyu/senpi/issues/3857))
