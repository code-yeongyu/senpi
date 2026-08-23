# senpi-codemode fork changes

## Detached-eval spill notices carry absolute paths (2026-08-23)

### What changed

- `packages/senpi-codemode/src/tool/detached-cell-notification.ts` now writes the plain absolute spill path into the oversized-output notice (`Buffered output overflowed; full output: <absolute path>`) instead of a `local://…` URI. The `localUri` helper and the unused `artifactsDir` parameter on `buildDetachedCellNotification` are gone; `DetachedNotificationQueue` no longer stores `artifactsDir`.
- `test/eval-detach.test.ts` locks the contract: the notice must contain `join(artifactsDir, "local", "detached-eval-<id>.log")` and must not contain `local://`.

### Why

- `local://` is a kernel-helper scheme resolved from the session artifact root inside eval cells (`read()`/`write()` prelude helpers). The agent-facing `read` tool resolves plain paths only, so a model that followed the notice's `local://detached-eval-<id>.log` got `ENOENT: <cwd>/local:/detached-eval-<id>.log`. This reproduces the documented invariant: spill notices contain plain absolute paths, not a custom URI scheme.

### Why an extension could not handle it

- The spill notice text is composed inside this package's notification builder; no downstream hook can rewrite the notice before it is queued to the notifier.

### Expected merge conflict zones

- LOW in `src/tool/detached-cell-notification.ts` around the spill-notice composition and the removed helper.
- LOW in `src/tool/detached-notification-queue.ts` around the constructor and flush mapping.
- LOW in `test/eval-detach.test.ts` around the crash-spill assertions.

## Detached-cell notices deliver as internal custom messages (2026-08-23)

### What changed

- `packages/senpi-codemode/src/extension/eval-notifier.ts` now delivers detached-cell completion notices through `sendMessage` with the new `EVAL_NOTIFICATION_CUSTOM_TYPE` (`senpi-codemode:notification`) and `display: false`, instead of `sendUserMessage`. Wake/next-turn mode still selects `steer` vs `followUp`, and delivery stays once-per-cell per session generation.
- `CodemodeExtensionAPI` requires `sendMessage` in place of `sendUserMessage`; the host binding forwards to `pi.sendMessage`.

### Why

- `sendUserMessage` enqueues into the same steering queue that holds real user input, and that queue carries no provenance. A host projecting it (the OmO desktop composer) rendered the raw `<system-reminder>Detached eval cell ... cancelled.` notice under its STEERING heading as if the user had typed and queued it.
- The sibling injectors already solved this: terminal (`senpi-terminal:notification`), monitor (`senpi-monitor:notification`), and loop-guard notices all use `sendMessage` with a `customType`, documented as "deliver a model-visible notification without rendering synthetic user input". The eval notifier was the sole caller still using the user-input door, so this aligns it with the existing contract rather than adding a new mechanism.

### Why an extension could not handle it

- The notifier is owned by this package and constructed during its extension factory wiring; the delivery door it calls is chosen inside `senpiCodemode`, so no downstream extension can redirect it.

### Expected merge conflict zones

- LOW in `src/extension/eval-notifier.ts` around the deps interface and the notify body.
- LOW in `src/index.ts` around the `CodemodeExtensionAPI` surface and the notifier construction.
- LOW in the codemode test fakes that implement the host API surface.

## Subprocess readiness gates cell execution (2026-08-21)

### What changed

- `packages/senpi-codemode/src/kernels/shared/subprocess-kernel.ts` now keeps Ruby and Julia cells queued until the active subprocess emits `ready`; only then does it write the `run` frame and arm that cell's timeout.
- An `init-failed` frame now fails queued work immediately as a kernel startup error instead of leaving it to an unrelated cell timeout.

### Why

- The shared kernel previously sent `init` and immediately started the first cell's timeout without observing readiness. Under load, interpreter and prelude startup could consume the entire cell budget, time out the state-setting cell, restart into a clean process, and make the following state-read cell fail nondeterministically.

### Why an extension could not handle it

- Subprocess generation ownership, protocol readiness, run queue dispatch, and timeout arming are private to the shared kernel implementation; an extension cannot safely order those lifecycle transitions from outside the package.

### Expected merge conflict zones

- LOW in `packages/senpi-codemode/src/kernels/shared/subprocess-kernel.ts` around process startup and protocol-message dispatch.
- LOW in the Ruby subprocess lifecycle tests that now emit the protocol readiness event explicitly.

## Eval completion throughput badge (2026-08-17)

### What changed

- Final single-cell eval frames now append the exact initiated nested tool-call count, a two-decimal
  calls-per-second rate, and true wall-clock elapsed time to the completed header, for example
  `eval py done ✓ · 2 calls · 1.00 calls/s · 2s · timeout 420s`.
- `EvalToolDetails` carries `wallDurationMs` and `toolCallCount` alongside the existing
  kernel-reported `durationMs`; the renderer uses wall time for final elapsed and throughput while
  preserving kernel duration for consumers that need interpreter timing.
- A cell that initiated no tool calls renders no throughput badge at all: both the count and the
  rate segments are dropped, so the header reads `eval py done ✓ · <1s` instead of
  `eval py done ✓ · 0 calls · 0.00 calls/s · <1s`. Positive calls without a positive wall duration
  render `n/a calls/s`, so the TUI never displays `Infinity` or `NaN`.
- Partial, pending, running, error, and synthetic multi-cell frames do not show a misleading final
  aggregate. The legacy no-cells result path renders the same final metadata when the new fields are
  available and preserves old output when they are absent.

### Why

- The eval extension already measures every nested tool invocation and true end-to-end wall time,
  but users could only see completion duration and per-call rows. Surfacing count and throughput in
  the final header makes eval composition efficiency observable without opening an analytics view.
- Dividing by kernel-reported duration would overstate throughput whenever host tool calls wait
  outside interpreter timing, so the visible elapsed label and the rate denominator share the same
  wall-clock source.

### Why this cannot be expressed externally

- The completed frame is owned by the eval renderer, while exact initiated-call counts and cell
  start time are owned by the eval runtime before the generic tool result reaches any external
  extension. An external renderer cannot reconstruct both facts reliably.

### Expected merge conflict zones

- MEDIUM in `src/tool/render.ts` around `cellHeader`, `renderDetailedLines`, and final result metadata.
- LOW in `src/tool/types.ts` and `src/tool/cell-runtime.ts` around `EvalToolDetails` construction.
- LOW in eval renderer and execution-event tests.

## Eval execution metadata event (2026-08-16)

### What changed

- Every settled eval cell now publishes one versioned `senpi.eval.execution` event. The in-process
  event bus receives the full bounded payload, while the external RPC channel receives a
  metadata-only projection that excludes prompts, arguments, call ids, errors, and result previews.
- The payload records producer timestamps, true end-to-end eval wall time, kernel-reported runtime,
  terminal status, detached status, every initiated nested tool-call count (including calls still
  pending when an error cell settles), distinct tool names, and per-tool aggregate durations.
- Generic and MCP tools retain the existing 30-call enrichment cap while every call still
  contributes to exact counts and aggregates. Reserved agent/output calls now receive the same
  bounded argument and duration capture; internal schema bridge calls preserve their legacy shape.
- Captured names and identifiers are length-bounded, at most 64 distinct names receive individual
  aggregates, excess names roll into an exact overflow aggregate, and the RPC projection has a
  final 32 KiB serialized-byte ceiling with a deterministic aggregate-only fallback.
- Session-generation fencing suppresses events from retired codemode runtimes.

### Why

- OMO needs producer-side timing data to determine whether eval composition and parallel tool calls
  actually reduce round trips and wall-clock time, rather than relying on model-side assumptions.
- OMO can consume rich metadata from the in-process event bus and later publish an explicitly
  redacted or capability-gated desktop projection. The current desktop adapter decodes but ignores
  unknown extension event names, so desktop rendering remains a separate consumer change.

### Why this cannot be expressed externally

- The eval extension owns kernel message dispatch, per-call bridge timing, bounded argument/result
  capture, detached settlement, and session-generation fencing. An external extension cannot
  reconstruct those facts accurately after the eval tool result has returned.

### Expected merge conflict zones

- MEDIUM in `src/index.ts`, `src/tool/eval-tool.ts`, and `src/tool/cell-handler.ts` around runtime
  registration, settlement, and nested tool-call capture.
- LOW in `src/tool/cell-runtime.ts`, `src/tool/eval-tool-options.ts`, and the new event builder.

## Eval cell hard limit (2026-08-13)

### What changed

- A cell now carries a wall-clock kill deadline resolved from the new `hardLimitSeconds` setting
  (default 1800s, `SENPI_CODEMODE_HARD_LIMIT_SECONDS` override), raised per call by an explicit
  larger `timeout`.
- `EvalDetachedCellManager` arms that deadline when the cell is created and clears it only on
  settlement, so it survives `detach()` and is never paused by bridge tool calls. On expiry the cell
  is interrupted, settles as cancelled, and the detached-cell notification tells the main agent it
  was killed at the hard limit.

### Why

- `cellTimeoutSeconds` only feeds the idle watchdog: `CellExecution.detach()` disposes that watchdog
  and `withBridgeTimeoutPause` pauses it for the whole duration of every host tool call, so a
  detached or tool-call-heavy cell had no upper bound at all — one observed cell ran 1h13m. The bash
  tool has enforced a kill deadline since `bash-timeout/timeout.ts`; eval now matches it.

### Why this cannot be expressed externally

- Cell lifetime, kernel interruption, and the detached-cell notification queue all live inside the
  package; an extension cannot observe a detached cell, let alone kill it.

### Expected merge conflict zones

- MEDIUM in `src/tool/detached-cell-manager.ts` around cell creation and settlement.
- LOW in `src/config/settings.ts` schema/defaults and the prompt timeout wording.

## Compiled binary runner sidecar resolution (2026-08-11)

### What changed

- Ruby and Julia kernels now preserve their normal module-relative runner path
  in source/npm execution but fall back to the standalone executable's
  `node_modules/@code-yeongyu/senpi-codemode/src/kernels/...` sidecar when the
  embedded `$bunfs` path does not exist.
- Focused tests pin Ruby, Julia, and non-compiled local-path behavior.

### Why

- The compiled coding-agent embeds the codemode factory and JavaScript
  dependency graph, but Ruby and Julia execute external runner files that Bun
  does not expose at the embedded module's `import.meta.dirname`.

### Why this cannot be expressed externally

- Runner paths are selected inside kernel construction before user code or an
  extension wrapper can replace the subprocess arguments.

### Expected merge conflict zones

- `src/kernels/rb/kernel.ts` and `src/kernels/jl/kernel.ts` runner arguments.
- `src/kernels/shared/runtime-asset.ts` compiled sidecar layout.

## Detached eval cell wake-source contract (2026-08-09)

### What changed

- The duplicated cross-package event literal is now `wake_source_state`, with source `senpi-codemode` and optional per-cell `items` metadata.
- Detached-cell detach, completion, stop, and session-dispose transitions publish the current active count through the optional host `events` passthrough; synchronous cells do not emit a lifecycle transition.
- The focused wiring suite pins event-bus delivery, completion-to-zero, bus-less compatibility, and the exact duplicated literal.

### Why

Goal continuation now aggregates every producer under one wake-source contract, so codemode must use the same event and a stable package-owned source key rather than the retired resumption-channel name.

### Why this cannot be expressed externally

Detach and settlement ownership lives inside `EvalDetachedCellManager`, and only the extension entry has access to the host event bus.

### Expected merge conflict zones

- MEDIUM in `src/index.ts` and `src/tool/detached-cell-manager.ts` around lifecycle snapshot wiring.
- LOW in the duplicated event contract and focused tests.

## Detached eval cell resumption-channel liveness (2026-08-08)

### What changed

- New `src/extension/resumption-channel.ts` duplicates the cross-package `resumption_channel_state` event literal and
  payload type locally; senpi-codemode is a separate package and must not import from packages/coding-agent, so a
  sentinel test pins the literal to catch drift.
- `src/tool/detached-cell-manager.ts`: new optional `onChannelState` callback fires a full per-source snapshot
  (`{ source: "eval-detached", activeCount, channels: [{ id, description, startedAtMs }] }`) on the same transitions as
  the existing `#emitStatus` footer seam (detach / settle / stop / dispose). `description` mirrors the footer label
  fallback (`summary` else cell id). A public `publishChannelState()` re-publishes the current snapshot.
- `src/index.ts`: the local `CodemodeExtensionAPI` widens with an optional `events?: { emit(name, data) }`; emission
  goes through `pi.events?.emit(...)` so hosts without an event bus are a harmless no-op. Both cell-manager
  constructions wire the callback, and the `session_start` handler re-publishes the snapshot because the consuming
  goal builtin clears its per-session counts there.
- `test/eval-resumption-channel.test.ts`: pins the single-cell snapshot, the two-cells-settling count sequence, the
  bus-less host no-op, the `session_start` re-emit plus bus transport, and the event-name sentinel.

### Why

- The goal builtin delays its hidden "keep going" continuation while a live resumption channel is on duty, but it only
  ever learned about terminal monitors. Detached eval cells are a real live channel that reported nothing, so the goal
  nagged itself immediately at turn end while a cell was still computing. This change makes codemode EMIT its liveness;
  a sibling lane owns the consuming side in the goal builtin.
- The legacy `terminal_monitor_state` event keeps its single-owner full-snapshot semantics; emitting it from a second
  source would clobber the terminal's count, so only the new source-keyed event is used.

### Why this cannot be expressed externally

- The liveness transitions live inside the detached-cell manager and the extension entry; an external extension cannot
  observe detach/settle/dispose without reimplementing the cell lifecycle.

### Expected merge conflict zones

- LOW: `src/index.ts` around the cell-manager constructions and the `session_start` handler.
- LOW: `src/tool/detached-cell-manager.ts` around `#emitStatus`.
- MEDIUM: `CHANGELOG.md` `[Unreleased]` when sibling lanes land entries; keep both bullets.

## Compact elapsed labels for simple eval results (2026-08-06)

### What changed

- `src/tool/render.ts`: final eval results without detailed cell records now route `durationMs` through the same compact formatter already used by cell headers, agent progress, and nested tool-call widgets.
- `test/eval-result-duration.test.ts`: focused coverage pins sub-second, seconds, minutes, and hours output plus the surrounding status/summary/phase/output frame.
- Existing renderer-state expectations now preserve the compact `<1s` label for very short completed and failed evaluations.

### Why

- The simple-result branch was the only eval duration surface that interpolated raw milliseconds, producing labels such as `took 3720000ms` while the detailed branch rendered the same duration as `1h 2m`.
- Consistent compact labels make completed tool-call timing readable without changing live footer, working-status, or thinking-duration policies.

### Why this cannot be expressed externally

- The inconsistency lives inside the eval tool's result renderer and must be corrected at the branch that builds transcript metadata.

### Expected merge conflict zones

- LOW: `src/tool/render.ts` around `resultMetadata()`.
- LOW: `test/eval-render-state.test.ts` and `test/eval-result-duration.test.ts`.

## Eval `summary` replaces `title` (2026-08-04)

### What changed

- `title` removed from the eval input surface entirely (schema, `EvalToolInput`, `EvalCellResult`, `EvalToolDetails`, renderers, detached surfaces, prompt, README, tests, QA scripts). Phase/status-event `title` is a different concept and is untouched.
- `summary` is now REQUIRED for run requests: schema property stays optional because the flat schema object is shared with the peek/stop actions, so required-ness is enforced in `parseEvalRequest` exactly like `language`/`code`, with the teaching error: `eval run requires summary — one line in the user's language: what this cell does and for what purpose`.
- The 80-char clamp runs in the `ToolDefinition`'s `prepareArguments` hook, which executes BEFORE schema validation, so an over-long summary can never become a validation error.
- The schema description carries the user-language WHAT+WHY writing guide the model reads at call time.
- Rendering: title-less header, muted summary line beneath it in transcript frames and live-update text; detached footer label is `summary ?? cellId`.
- Back-compat: callers still sending `title` keep validating (value ignored); legacy stored results (title-only details) re-render without a label and without crashing.

### Why

- `title` was decorative metadata the model rarely populated meaningfully; `summary` forces a one-line, user-language description of intent at every run, improving transcript readability and downstream debugging.
- Enforcing required-ness in the parser (not the schema) keeps the shared flat schema valid for peek/stop while still rejecting run requests that omit `summary`.

### Why this cannot be expressed externally

- The change spans the tool schema, request parser, type definitions, renderers, detached-cell manager, status events, prompt instructions, README, and all QA scripts — a single coordinated fork commit.

### Expected merge conflict zones

- `src/tool/types.ts`, `src/tool/eval-request.ts`, `src/tool/eval-tool.ts`, `src/tool/cell-runtime.ts`, `src/tool/render.ts`, `src/tool/detached-cell-manager.ts`, `src/tool/detached-cell-snapshot.ts`, `src/extension/eval-status.ts`, `src/prompt/eval-prompt.ts`, `README.md`, `test/`, `scripts/`.

## Backfill: persistent eval lifecycle and tool surface (2026-08-01)

### What changed

- Eval cells can detach, report state-aware timeouts, and reuse neither active nor completed detached cell IDs.
- Eval now has one normalized tool surface with bounded current-main status history and rich detached-cell peeks.
- Bridge aborts, reserved bridge routing, tool-schema feedback, and tool widgets are handled explicitly.

### Why

- Long-running eval work must remain observable, addressable, and safe across retries, timeouts, and UI rendering.

### Why this cannot be expressed externally

- The contracts span the persistent kernel manager, bridge routing, tool schema, detached notification state, and renderer.

### Expected merge conflict zones

- `src/tool/eval-tool.ts`, detached cell manager/state/notification files, bridge code, status events, and eval rendering/tests.

## Live elapsed footer for detached eval cells (2026-07-31)

- `src/tool/detached-cell-manager.ts`: `ManagedCell` and `EvalDetachedCellStatusEntry` gain
  `startedAtMs` (epoch ms at cell creation); the manager accepts an injectable `now`.
- `src/extension/eval-status.ts`: `formatEvalCellStatus(entries, nowMs)` appends the oldest
  cell's goal-style elapsed label (`↗ py · title (45s)`, `↗ eval 2: a, b (3m)`); the 48-char
  budget and `+N more` packing are preserved.
- `src/extension/eval-status-ticker.ts` (new): `EvalStatusTicker`, same shape as the terminal
  builtin's `MonitorStatusTicker` — 1s unref'd interval, label dedupe, stop-and-clear when the
  last detached cell settles. `src/index.ts` routes `showDetachedCells` through the ticker and
  stops it in `dropRuntime`; `SenpiCodemodeOptions` gains an optional `now` clock for tests.
- Tests: `test/eval-status.test.ts` (elapsed rendering + budget), `test/eval-status-ticker.test.ts`
  (new; interval discipline), `test/eval-status-wiring.test.ts` (footer advances 1s→2s→3s while
  a cell stays detached, clears on completion).


- `src/extension/eval-status.ts` (new): `formatEvalCellStatus(entries)` — undefined when
  no cell is detached, `↗ <lang> · <title>` for one (cellId fallback when untitled),
  `↗ eval N: <packed titles>` for many, 48-char budget with whole-label packing and a
  `+N more` tail. `EVAL_CELLS_STATUS_KEY = "eval-cells"`. Semantics mirror the terminal
  extension's monitor-status so both live watches read the same in the footer.
- `src/tool/detached-cell-manager.ts`: `EvalDetachedCellStatusEntry` plus the
  `onStatusChange` option. Emissions happen only inside `#transition` (the single
  detach/terminal boundary) and in `detach()`, so the listener always observes the
  exact live detached set; an empty array means "clear the status".
- `src/index.ts`: `showDetachedCells` publishes the formatted status through
  `ctx.ui.setStatus("eval-cells", ...)`, highlighted with `selectedBg` in tui mode and
  left plain elsewhere. Hosts that hand a partial ui surface (no theme) fall back to
  plain text instead of breaking the cell lifecycle.
- Tests: `test/eval-status.test.ts` (formatter), new `eval detached cell status
  emissions` block in `test/eval-detach.test.ts` (manager contract), and
  `test/eval-status-wiring.test.ts` (extension → footer wiring through session_start).
