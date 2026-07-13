# Changelog

## [Unreleased]

### Added

### Changed

### Fixed

## [2026.7.13] - 2026-07-13

### Added

- Added the source-only `@code-yeongyu/senpi-codemode` workspace package scaffold.
- Added codemode settings loading, interpreter detection, prompt generation, loopback bridge helpers, and persistent JS/Python/Ruby/Julia kernel building blocks.
- Added structured kernel status events from the bridge through TUI rendering.
- Added `agent()` and `output()` bridges that delegate through configured task-tool contracts.
- Added bounded streaming output with session-adjacent spill files and plain-path notices.
- Added eval render parity for highlighted cells, status rows, task progress, JSON displays, truncation warnings, and image fallbacks.
- Added JavaScript import rewriting for persistent eval cells.

### Changed

- Activated the exported extension factory so the bundled package registers and reconfigures the persistent-kernel `eval` tool in Senpi sessions.
- Improved `eval` TUI rendering with streaming status and timing, bounded expandable previews, width-safe ANSI/CJK/emoji reflow, nested tool-call state, and terminal-aware image fallbacks.
- Re-register the eval prompt and schema at session start after settings, interpreter availability, and active task-tool names resolve.
- Recorded the completed oh-my-pi eval-port provenance for this extension; task delegation and artifact handling follow Senpi extension boundaries.

### Fixed

- Prevented image MIME labels from injecting terminal control sequences through eval text fallbacks.
- Fixed eval cancellation and timeout handling across JavaScript, Python, Ruby, and Julia kernels: aborts now interrupt active work, unresponsive subprocesses escalate to bounded hard termination, queued Python cells cannot execute after cancellation, persistent Python state survives graceful interrupts, timeout/death durations remain truthful, and late bridge or retired-process output cannot keep an eval hung or contaminate the next cell.
- Fixed the bundled `eval` extension failing to load in packaged installs: `completion/handler.ts` imported peer symbols via the monorepo source path `../../../ai/src/*`, which only resolves inside the workspace and threw `Cannot find module` once packed. It now imports from the `@earendil-works/pi-ai/compat` package entry, so `eval` loads in the shipped Node package.
- Fixed a temporal-dead-zone crash in the `eval` tool: subprocess kernels (py/rb/jl) emit their `ready` frame synchronously during kernel startup, which invoked the message handler before the `kernel` binding initialized and crashed the whole agent process. The self-referential binding is now hoisted so startup frames no longer throw.
- Fixed cell-output misattribution on reused persistent kernels: `getKernel` now rebinds the per-cell `onMessage` on every call, so a second (and later) cell's streamed `text`/`display`/`log` output is delivered to that cell instead of the previous one.
- Fixed the Ruby kernel corrupting its JSONL protocol channel: user `puts`/`print` output is now captured via a redirected `$stdout` and emitted as `text` frames instead of being written directly onto the shared stdout stream.
- Fixed the Ruby kernel raising `ArgumentError: unknown keywords` on Ruby 3.0+ (e.g. CI's Ruby 3.x, while local Ruby 2.6 masked it): `env()`/`read()`/`write()` passed braceless string-keyed hashes to `__senpi_emit_status`, which Ruby 3 parses as keyword arguments against its `force:` keyword parameter instead of the positional `fields` hash. The field hashes are now wrapped in explicit braces so status emission and final-expression auto-display work identically across Ruby 2.6–3.4.
