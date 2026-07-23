# Changelog

## [Unreleased]

### Breaking Changes

### Added

- Added the GPT-only Code Mode runtime with `exec` and `wait` tools, plus model-aware GPT eval routing ([#301](https://github.com/code-yeongyu/senpi/pull/301)).

### Changed

### Fixed

### Removed

## [2026.7.22-2] - 2026-07-22

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.22] - 2026-07-22

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.20-2] - 2026-07-20

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.20] - 2026-07-20

### Breaking Changes

### Added

### Changed

### Fixed

- Fixed the Python kernel's `tool.<name>()` proxy injecting an omp-only `i` ("py prelude") intent field into every bridged tool call. Senpi tool schemas never declare `i`, so strict tools (`additionalProperties: false`, e.g. `web_search`) rejected every eval-bridged call with `Validation failed for tool …: must not have additional properties`. Args now pass through verbatim, matching the JS/Ruby/Julia preludes.

### Removed

## [2026.7.17-5] - 2026-07-17

### Breaking Changes

### Added

### Changed
- Changed the Kimi K-series eval prompt dialect to make eval-first, whole-step parallel batching the default: strong positive emphasis now directs multi-call work into one `eval` cell, parallelizes independent calls, handles failures in-kernel, and returns distilled facts.

### Fixed

### Removed

## [2026.7.17-4] - 2026-07-17

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.17-3] - 2026-07-17

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.17-2] - 2026-07-17

### Added

- Added a host-sizing note to the `eval` prompt: the extension now passes a preformatted host line (platform, arch, CPU model, core count) at registration so the prompt tells the model to size `parallel(thunks)` pools to the local cores and keep shell commands platform-appropriate.
- Added model-aware eval-first batching emphasis: the `eval` tool description and its system-prompt guideline now render in a dialect selected by the active model id (Claude/GLM, OpenAI, Kimi, and a maximum-emphasis default fallback), re-registering on `model_select` so mid-session model switches pick up the matching dialect.

### Changed

### Fixed

## [2026.7.17] - 2026-07-17

### Added

### Changed

### Fixed

- Fixed `eval` tool calls rendering duplicate stacked boxes after a result arrived; the pending, running, and completed states now update in one in-place frame ([#223](https://github.com/code-yeongyu/senpi/pull/223)).

## [2026.7.16-3] - 2026-07-16

### Added

### Changed

### Fixed

## [2026.7.16-2] - 2026-07-16

### Added

### Changed

### Fixed

## [2026.7.16] - 2026-07-16

### Added

### Changed

### Fixed

## [2026.7.14-3] - 2026-07-14

### Added

### Changed

### Fixed

## [2026.7.14-2] - 2026-07-14

### Added

### Changed

### Fixed

## [2026.7.14] - 2026-07-14

### Added

### Changed

- Improved the `eval` prompt instructions and reuse-chain examples to teach persistent-state reuse, batch file processing, and parallel session-tool fan-out within a single cell.

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
