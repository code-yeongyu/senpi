# Changelog

## [Unreleased]

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.11] - 2026-08-10

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.10] - 2026-08-10

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.9-2] - 2026-08-09

### Breaking Changes

### Added

### Changed

- Detached eval cells now emit the shared `wake_source_state` event under source `senpi-codemode` when they detach, complete, stop, or are disposed. The optional host event passthrough remains guarded, synchronous cells emit no lifecycle transition, and per-cell snapshot metadata is preserved.

### Fixed

### Removed

## [2026.8.9] - 2026-08-09

### Breaking Changes

### Added

- Detached eval cells now publish their liveness as a `resumption_channel_state` event (source `eval-detached`) on the
  host event bus: a full per-source snapshot with `activeCount` and per-cell `id`/`description`/`startedAtMs` entries is
  emitted whenever a cell detaches, settles, is stopped, or is disposed, and once on `session_start`. The goal builtin
  consumes this to hold its hidden continuation while detached cells are still computing instead of nagging immediately
  at turn end. Hosts without an event bus are unaffected (emission is a no-op), and the footer/status rendering is
  unchanged.

### Changed

### Fixed

### Removed

## [2026.8.7] - 2026-08-07

### Breaking Changes

### Added

### Changed

### Fixed

- Formatted completed eval durations in the simple-result transcript branch with the same compact human-readable units
  used by detailed cell headers and nested tool widgets, so sub-second, seconds, minutes, and hours values render as
  labels such as `<1s`, `12s`, `3m 5s`, or `1h 2m` instead of raw millisecond counts. Live footer, working-status, and
  thinking-duration policies are unchanged ([#743](https://github.com/code-yeongyu/senpi/pull/743)).

### Removed

## [2026.8.6] - 2026-08-06

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.5-2] - 2026-08-05

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.5] - 2026-08-05

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.4-2] - 2026-08-04

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.4] - 2026-08-04

### Breaking Changes

- Replaced the eval tool's optional presentation `title` with a required user-language `summary`: every eval call must now describe the cell's purpose in the user's language, callers using `title` must migrate to `summary`, and the generated tool schema, prompt contract, README examples, bridge fixtures, and test corpus all enforce the new argument ([#695](https://github.com/code-yeongyu/senpi/pull/695)).

### Added

- Rendered each eval summary inside its transcript cell frame and used the same summary to label detached cells and their completion notices, so concurrent or long-running JavaScript and Python work remains identifiable after detachment and when results arrive asynchronously ([#695](https://github.com/code-yeongyu/senpi/pull/695)).

### Changed

### Fixed

### Removed

## [2026.8.3-3] - 2026-08-03

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.3-2] - 2026-08-03

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.3] - 2026-08-03

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.1] - 2026-08-01

### Breaking Changes

### Added

### Changed

### Fixed

- Preserve rich live and terminal `eval` details when peeking detached cells,
  including code, title, output, phase, status events, tool-call summaries,
  duration, and structured displays; cancellation now remains authoritative
  over late completion races
  ([#603](https://github.com/code-yeongyu/senpi/pull/603)).

### Removed

## [2026.7.31-2] - 2026-07-31

### Breaking Changes

### Added

### Changed

- Include a live elapsed label in detached `eval` footer status. The ticker updates only when the rendered duration
  changes and is disposed when the cell completes, fails, or is stopped.

### Fixed

### Removed

## [2026.7.31] - 2026-07-31

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.30-2] - 2026-07-30

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.30] - 2026-07-30

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.29-6] - 2026-07-29

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.29-5] - 2026-07-29

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.29-4] - 2026-07-29

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.29-3] - 2026-07-29

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.29-2] - 2026-07-29

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.29] - 2026-07-29

### Breaking Changes

### Added

- Show every live detached eval cell in the interactive footer, using a highlighted `↗ <language> · <title>` status for one cell and a bounded packed summary for multiple cells; clear the status immediately when the final detached cell settles ([#483](https://github.com/code-yeongyu/senpi/pull/483)).

### Changed

### Fixed

- Route reserved `agent()`, `output()`, and `tool_schema()` bridge calls from Python and other subprocess kernels through the reserved HTTP handler instead of attempting to execute nonexistent `__agent__`, `__output__`, and `__schema__` tools; ordinary bridge tool calls remain unchanged ([#462](https://github.com/code-yeongyu/senpi/pull/462)).

### Removed

## [2026.7.28-3] - 2026-07-28

### Breaking Changes

### Added

- Add nested tool-call widgets that render the real call shape of tools invoked from eval cells, with truthful status, duration, and sanitized previews ([#444](https://github.com/code-yeongyu/senpi/pull/444)).

### Changed

### Fixed

### Removed

## [2026.7.28-2] - 2026-07-28

### Breaking Changes

### Added

### Changed

### Fixed

- Start a fresh eval cell when a caller reuses the ID of a terminal cell, preventing completed or failed results from being replayed as though new code had executed ([#439](https://github.com/code-yeongyu/senpi/pull/439)).
- Omit the eval `took` duration when timing metadata is unavailable, avoiding misleading zero-duration status output for detached or restored cell results ([#439](https://github.com/code-yeongyu/senpi/pull/439)).

### Removed

## [2026.7.28] - 2026-07-28

### Breaking Changes

### Added

- Add `tool_schema()` and return parameter schemas from failed eval tool calls so cells can inspect and self-correct tool invocations ([#407](https://github.com/code-yeongyu/senpi/pull/407)).

### Changed

- Allow eval cells and extensions to activate named searchable tools lazily on the calling surface without globally widening the active tool set ([#408](https://github.com/code-yeongyu/senpi/pull/408)).

### Fixed

### Removed

## [2026.7.26] - 2026-07-26

### Breaking Changes

- Remove the separate GPT-only `exec`/`wait` runtime; GPT models now compose active tools through the persistent `eval` surface.

### Added

- Detach interactive `eval` cells on timeout, inject completion notifications, and support `peek`/`stop` actions without blocking other language kernels.
- Report whether Python kernel state survived an interrupt or timeout, with a real-surface QA driver covering the contract.

### Changed

- Bound each cell's retained status history and summarize omitted events ([#334](https://github.com/code-yeongyu/senpi/pull/334) by [@minpeter](https://github.com/minpeter)).
- Make task-output lookups non-blocking and document detached-cell state, output, and artifact behavior.

### Fixed

- Preserve Python state when interruption succeeds, report truthful state when it does not, and tolerate kernels predating the interrupt-outcome contract.
- Stop normal bridge-request completion from aborting still-running host tool calls.

### Removed

## [2026.7.25-2] - 2026-07-25

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.25] - 2026-07-25

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.24] - 2026-07-24

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.23] - 2026-07-23

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
