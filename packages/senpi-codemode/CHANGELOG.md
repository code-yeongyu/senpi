# Changelog

## [Unreleased]

### Added

- Added the source-only `@code-yeongyu/senpi-codemode` workspace package scaffold.
- Added codemode settings loading, interpreter detection, prompt generation, loopback bridge helpers, and persistent JS/Python/Ruby/Julia kernel building blocks.

### Changed

- Documented that the current exported extension factory is still a no-op until the `eval` tool and bundled host loading land.

### Fixed

- Fixed eval cancellation and timeout handling across JavaScript, Python, Ruby, and Julia kernels: aborts now interrupt active work, unresponsive subprocesses escalate to bounded hard termination, queued Python cells cannot execute after cancellation, persistent Python state survives graceful interrupts, timeout/death durations remain truthful, and late bridge or retired-process output cannot keep an eval hung or contaminate the next cell.
- Fixed the bundled `eval` extension failing to load in packaged installs: `completion/handler.ts` imported peer symbols via the monorepo source path `../../../ai/src/*`, which only resolves inside the workspace and threw `Cannot find module` once packed. It now imports from the `@earendil-works/pi-ai/compat` package entry, so `eval` loads in the shipped Node package.
- Fixed a temporal-dead-zone crash in the `eval` tool: subprocess kernels (py/rb/jl) emit their `ready` frame synchronously during kernel startup, which invoked the message handler before the `kernel` binding initialized and crashed the whole agent process. The self-referential binding is now hoisted so startup frames no longer throw.
- Fixed cell-output misattribution on reused persistent kernels: `getKernel` now rebinds the per-cell `onMessage` on every call, so a second (and later) cell's streamed `text`/`display`/`log` output is delivered to that cell instead of the previous one.
- Fixed the Ruby kernel corrupting its JSONL protocol channel: user `puts`/`print` output is now captured via a redirected `$stdout` and emitted as `text` frames instead of being written directly onto the shared stdout stream.
