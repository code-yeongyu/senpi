# Changelog

## [Unreleased]

### Breaking Changes

### Added

### Changed

- The eval prompt's dependency-graph section is now `<workflow>` and states its contract directly:
  define the workflow spec in code, one node per logically distinct step, rather than hand-authoring
  the graph as a single opaque call.

### Fixed

- The JavaScript kernel persistence transform no longer truncates declarations whose multi-line
  initializers contain interior `//` comments (previously emitted unparseable code such as
  `globalThis["jobs"] = {;`, failing cells with `Unexpected token ';'. Expected a property name.`),
  and no longer re-evaluates comment-bearing initializers when persisting bindings — such
  declarations are kept verbatim and their bindings persisted by reference.
- Last-expression capture no longer inserts `return` before continuation lines (`else`/`catch`/`finally`
  clauses and leading-`.`/operator method-chain lines), and now scans template literals (including
  nested templates in interpolations), regexes, and comments with the same literal-aware scanner as
  the persistence transform — fixing `return else …`, `return .replace(…)`, and mid-argument
  `return )` corruption of valid cells.
- Last-expression capture now follows real ASI statement semantics: a parenthesized/bracketed/template
  line after a closed block starts a new statement (echo restored), expressions split after a trailing
  operator or `await` stay one statement, tagged templates split across lines invoke the tag, regexes
  directly after a control-structure condition no longer desync the scanner, and labeled final
  statements are left uncaptured instead of emitting invalid `return label: …`.
- Destructuring patterns carrying interior line comments now persist their bindings, and declarations
  with a dangling trailing comma are left untransformed so the original syntax error surfaces instead
  of being silently "repaired".
- Rewritten destructuring assignments are emitted with a leading defensive semicolon so they can no
  longer ASI-merge into a preceding unterminated expression statement as a bogus call
  (`foo()\n({…} = …)` previously became `foo()({…} = …)`).

### Removed

## [2026.8.29] - 2026-08-29

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.28-2] - 2026-08-28

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.28] - 2026-08-28

### Breaking Changes

### Added

### Changed

### Fixed

- JavaScript and Python eval kernels resolve worker and prelude assets from the executable sidecar in Bun-compiled distributions instead of passing unusable `$bunfs` paths to `Worker` and `python3`.

### Removed

## [2026.8.27] - 2026-08-27

### Breaking Changes

### Added

### Changed

- Eval tool description examples are now a JS-first mixed set: set up once in JavaScript, fan out batched `Promise.all` session-tool calls in the next cell, then hop to Python when the JS kernel is busy with a detached cell. The detach paragraph now states in the same sentence that another language can continue.

### Fixed

- Detached-eval same-language busy errors now name each idle enabled kernel and tell the agent to continue the step there (`continue this step in an idle kernel: js`), instead of only pointing at peek and the output tail. A busy Python kernel no longer reads as "eval is unavailable", which previously sent agents to `bash`+`python3` while JavaScript (or another idle kernel) was free. Single-language sessions and fully-busy sessions omit the idle-kernel claim.
- JavaScript eval cells now persist only top-level declarations, including destructuring bindings and uninitialized variables, without rewriting declaration-shaped text inside literals or comments.
- Eval completion and detached-cell handling retain explicit lifecycle observability: nested tool counts, wall/kernel timing, detach state, `peek`, `stop`, hard limits, and crash recovery remain bounded and machine-readable for hosts and telemetry consumers.

### Removed

## [2026.8.26-2] - 2026-08-26

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.26] - 2026-08-26

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.25] - 2026-08-25

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.24] - 2026-08-24

### Breaking Changes

### Added

### Changed

### Fixed

- Detached eval cell overflow notices now point at the absolute spill file path (`…/local/detached-eval-<id>.log`) instead of a `local://detached-eval-<id>.log` URI. `local://` is resolved only by the in-cell kernel helpers, not by the agent `read` tool, so following the old notice failed with `ENOENT …/local:/detached-eval-<id>.log`. This restores the documented contract that spill notices carry plain absolute paths.

### Removed

## [2026.8.23] - 2026-08-23

### Breaking Changes

### Added

### Changed

### Fixed

- Detached eval cell completion notices no longer enter the user-input steering queue. They were delivered via `sendUserMessage`, so hosts projecting that queue (e.g. the OmO desktop composer) rendered the raw `<system-reminder>Detached eval cell …</system-reminder>` notice under the STEERING heading as if the user had typed and queued it. Notices now deliver via `sendMessage` with `customType: "senpi-codemode:notification"` and `display: false` — model-visible, never painted as user input — matching the terminal and monitor notification contract.

### Removed

## [2026.8.22-2] - 2026-08-22

### Breaking Changes

### Added

- Eval headers now display the kernel runtime identity, e.g. `eval py (3.14.7, ~/.venv/bin/python3)` and `eval js (node 26.7.0, /opt/…/bin/node)`; the same `runtime` info rides `EvalToolDetails` and its `cells` so RPC consumers receive it, interpreter detection resolves absolute executable paths from PATH, and the eval prompt host line names the JS runtime (`node`/`bun` with version).

### Changed

- Running eval cell headers now tick their elapsed time in real time (`eval py running · 13s`) instead of freezing between kernel update events; the renderer derives elapsed time from a render-time clock while a cell is pending/running/detached and repaints once per second, while settled cells keep their exact final duration. `EvalCellResult` gains an additive `startedAt` so RPC consumers can compute the same live value.

### Fixed

- A host tool call from inside an eval cell no longer suspends the cell's timeout indefinitely. The idle watchdog previously cleared its timer for the entire duration of a bridge call, so a call that never returned (e.g. an awaited `dag-wait`) left the cell pending — and the agent loop parked, queueing user messages invisibly — until the 1800s hard limit. The pause is now bounded by a max pause grace (default 600s, floored at the cell's own `timeout`): a long bridge call such as a 5-minute build still runs to completion, but a stuck one now trips the cell's `on_timeout` handling and releases the loop.

### Removed

## [2026.8.22] - 2026-08-22

### Breaking Changes

### Added

### Changed

### Fixed

- Ruby and Julia eval cells now wait for the subprocess `ready` signal before execution timeouts begin, so interpreter startup under load cannot time out a state-setting cell and silently restart the kernel before the next cell runs.

### Removed

## [2026.8.21-3] - 2026-08-21

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.21-2] - 2026-08-21

### Breaking Changes

### Added

### Changed

### Fixed

- `js` eval cells now accept `local://` paths in `read()` and `write()` like every other kernel. The session manager computed the session local root only after its `language === "js"` early return, so the JavaScript kernel was constructed without `localRoots` or `artifactsDir` and every `local://` helper call failed with `Protocol paths are not supported by write()`, even though the JavaScript prelude documents `local://` as the session local root. `py`/`rb`/`jl` behavior is unchanged.

### Removed

## [2026.8.21] - 2026-08-21

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.20-2] - 2026-08-20

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.20] - 2026-08-20

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.19] - 2026-08-19

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.18-3] - 2026-08-18

### Breaking Changes

### Added

### Changed

### Fixed

- Eval cells that initiated no tool calls no longer render a `0 calls · 0.00 calls/s`
  throughput badge; the footer shows only the elapsed time. Positive call counts are
  unchanged.

### Removed

## [2026.8.18-2] - 2026-08-18

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.18] - 2026-08-18

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.17] - 2026-08-17

### Breaking Changes

### Added

- Show exact nested tool-call count and calls-per-second in completed eval TUI headers, using true wall-clock elapsed time for both the visible duration and throughput denominator while preserving kernel-reported timing separately ([#916](https://github.com/code-yeongyu/senpi/pull/916)).

### Changed

### Fixed

### Removed

## [2026.8.16] - 2026-08-16

### Breaking Changes

### Added

- Published one versioned `senpi.eval.execution` event per settled eval cell: the in-process bus receives bounded rich call details, while the external RPC projection exposes only byte-capped timing/count metadata for safe OMO analytics; total wall time, kernel runtime, pending calls, exact aggregate totals, and overflow accounting are reported separately ([#897](https://github.com/code-yeongyu/senpi/pull/897)).

### Changed

### Fixed

### Removed

## [2026.8.14] - 2026-08-14

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.13-2] - 2026-08-13

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.13] - 2026-08-13

### Breaking Changes

### Added

- Gave every eval cell a wall-clock hard limit (`hardLimitSeconds`, default 1800s, overridable with `SENPI_CODEMODE_HARD_LIMIT_SECONDS`) so a detached or tool-call-heavy cell can no longer run unbounded: the deadline survives `detach()` and is never paused by bridge tool calls, and a cell it kills reports itself to the agent as killed at the hard limit ([#857](https://github.com/code-yeongyu/senpi/pull/857)).

### Changed

### Fixed

### Removed

## [2026.8.12-4] - 2026-08-12

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.12-3] - 2026-08-12

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.12-2] - 2026-08-12

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.12] - 2026-08-12

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.11-6] - 2026-08-11

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.11-5] - 2026-08-11

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.11-4] - 2026-08-11

### Breaking Changes

### Added

### Changed

### Fixed

- Ruby and Julia `eval` kernels launched from standalone Bun binaries now
  resolve their external runner files from the shipped codemode sidecar when
  the embedded `$bunfs` module path has no physical asset
  ([#818](https://github.com/code-yeongyu/senpi/pull/818)).

### Removed

## [2026.8.11-3] - 2026-08-11

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.11-2] - 2026-08-10

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
