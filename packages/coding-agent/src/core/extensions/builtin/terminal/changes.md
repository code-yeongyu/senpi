# terminal builtin extension — fork surface

The persistent-terminal tool suite (`bash` swapped to PTY-backed + `bash_output`,
`kill_bash`, `bash_input`, `bash_resize`). Backed by `@earendil-works/pi-pty`.

## Live elapsed footer for monitors + enriched monitor state event (2026-07-31)

### What changed

- `monitor-registry.ts`: `MonitorSnapshotEntry` gains `startedAtMs` (epoch ms at registration).
- `monitor-status.ts`: `formatMonitorStatus(snapshot, nowMs)` renders a goal-style compact
  elapsed label (`5s`/`3m`/`2h 30m`) for the oldest live watch, merged with the paused suffix
  as `(3m, paused)` / `(3m, 1 paused)`. 48-char budget and `+N more` packing unchanged.
- `monitor-status-ticker.ts` (new): `MonitorStatusTicker` mirrors the goal builtin's
  `GoalElapsedTicker` — 1s unref'd interval, renders only when the formatted label changes,
  stops and clears the status when the last watch settles. The extension's `onMonitorState`
  sink now drives the ticker instead of formatting inline; `session_shutdown` stops it.
- `builtin/monitor-state-event.ts`: `TerminalMonitorStateEvent` gains an additive optional
  `monitors` array (`{ id, description, paused, startedAtMs }`) so event-bus consumers (and
  RPC clients, which already receive footer statuses through the `setStatus`
  `extension_ui_request` bridge) can render their own elapsed views. `activeCount` and the
  type guard are unchanged; old payloads still validate.

### Tests

- `test/suite/terminal-monitor-footer.test.ts`: elapsed rendering, oldest-watch selection,
  clock-skew clamp, paused-suffix merge, budget preservation, `startedAtMs` in snapshots.
- `test/suite/terminal-monitor-status-ticker.test.ts` (new): unref'd 1s interval, label
  dedupe, stop-on-settle, re-sync without leaking intervals.
- `test/suite/terminal-monitor-state-event.test.ts`: `monitors[]` payload assertions.

## Background sessions and monitors survive session reload (2026-07-29)

### What changed

- `session-bundle.ts` (new): `TerminalSessionBundle` owns the long-lived per-session runtime
  (the `TerminalManager` plus the `MonitorRegistry`) and routes monitor events, monitor-state
  snapshots, and background-exit notifications through mutable sinks the current extension
  instance binds. A module-level parked map (`parkBundle`/`claimParkedBundle`/
  `teardownParkedBundle`, keyed by `ctx.sessionManager.getSessionId()`, at most one parked
  bundle per session) hands the bundle across the extension-runner replacement a reload performs.
- `extension.ts`: `session_shutdown` with `reason:"reload"` parks the bundle instead of tearing
  it down; every other reason (`quit`/`new`/`resume`/`fork`) keeps the full teardown AND sweeps
  any stale parked bundle. `session_start` with `reason:"reload"` claims the parked bundle,
  re-binds sinks to the new instance's notifiers, re-publishes the `monitors` footer status, and
  flushes events buffered during the reload window (bounded: 100 monitor events, 32 exits);
  other reasons keep today's fresh-bundle behavior. `onBackgroundExit` now dispatches through
  the bundle so exit listeners registered before a reload reach the post-reload notifier.
- Result: after `/reload`, existing `bash_N` ids remain addressable (`bash_output`,
  `bash_input`, `kill_bash`), monitors keep injecting events, and background completion
  notifications reach the new runner instead of dying with the old one. Previously reload
  tree-killed every background session and orphaned every watcher the model knew about.
- Known bounds: terminal `maxSessions`/`scrollback` setting changes apply to bundles created
  after a non-reload session start (a preserved bundle keeps its construction-time caps); a
  headless host that skips `session_start` after reload leaves the bundle parked until the next
  real shutdown sweep.
- Tests: `test/suite/terminal-reload-survival.test.ts` (monitor survival + footer re-publish,
  background-session id survival via screen peek, post-reload completion-notification routing,
  quit-teardown characterization pin).

### Why

Observed live: a reload during an active `gh pr checks --watch` monitor orphaned the watcher
(process kept running, session lost the subscription, footer went blank, all bash ids dangled).
Waiting state parked behind a reload must keep waiting, cleanly.

### Expected merge conflict zones on next upstream sync

- LOW: fork-owned `extension.ts` session lifecycle handlers and the new `session-bundle.ts`.

## Theme-aware active-monitor footer (2026-07-29)

### What changed

- Active monitor footer text is wrapped with the current TUI theme's `text` foreground and
  `selectedBg` background before publication through `ctx.ui.setStatus`.
- Styling is restricted to `ctx.mode === "tui"`; RPC, app-server, JSON, and print contexts keep
  the original plain status string, and an empty monitor snapshot still clears with `undefined`.
- The formatter remains unchanged, so the 48-column cap, whole-description packing, watch glyph,
  monitor count, and paused suffix stay independent of ANSI byte length.

### Why

The live `◉ watching …` row could blend into adjacent footer content. Reusing the active theme's
selection background creates a visible but restrained chip in both dark and light themes without
introducing a monitor-specific color token.

### Expected merge conflict zones on next upstream sync

- LOW: the fork-owned monitor registry `onChange` callback in `extension.ts` and its focused footer
  wiring test.

## bash_output ghost wait_for params removed (2026-07-28)

### What changed

- `bash_output` no longer exposes the `wait_for`, `block`, and `timeout` params,
  and the `BASH_OUTPUT_WAIT_REMOVED_GUIDANCE` migration string and
  `GHOST_PARAM_DESCRIPTION` were removed from `tools/bash-output.ts`.
- `BashOutputInput` is now exactly `{ bash_id, filter?, view? }`; any caller still
  sending the removed params gets a generic schema-validation error instead of
  the migration text.
- Tests that pinned the ghost guidance were removed:
  - `test/bash-output-peek.test.ts` `describe("bash_output removed blocking params")` block.
  - `test/suite/terminal-extension.test.ts` `it("wait_for ghost param returns migration guidance …")`.
  - `test/prompt-surface-stale-wait-idioms.test.ts` `it("the ghost guidance exists …")`.
- The negative guards in `prompt-surface-stale-wait-idioms.test.ts` (no surface
  teaches `wait_for` / `block until` / tmux backgrounding) stay in place.

### Why

The ghost params kept the removed `wait_for` idiom visible to the model in the
schema, so it kept being called and returning the guidance text — the migration
message never stopped appearing. Dropping the params from the schema removes the
mention entirely; the monitor/notification model in `terminal/prompt.ts` and
`docs/terminal-tools.md` is already the single taught path.

### Expected merge conflict zones on next upstream sync

- LOW: fork-owned `bash_output` schema and the removed ghost-param tests.

## Hidden agent wake notifications (2026-07-28)

### What changed

- Terminal completion and monitor-event notifications now use `display:false` custom messages
  with `triggerTurn:true`, preserving idle wake and streaming steer/follow-up behavior without
  rendering synthetic `<system-reminder>` blocks as user input.
- Monitor events use `senpi-monitor:notification`; background terminal completion notices use
  `senpi-terminal:notification`.
- App-server extension turns may bootstrap from a custom-message wake, but custom wakes do not
  emit a visible `userMessage` item.

### Expected merge conflict zones on next upstream sync

- LOW: fork-owned terminal notification delivery wiring and app-server extension-turn bootstrap.

## Cache-aware foreground timeout promotion (2026-07-28)

### What changed

- `TerminalToolContext.timeoutAction` now receives the resolved terminal setting from
  `extension.ts`; the previously declared `terminal.timeoutAction` setting is implemented.
- Foreground `bash` calls whose native timeout exceeds the live prompt-cache-safe wait budget
  auto-detach at that budget when `timeoutAction` is `background`. The original native timeout
  remains authoritative, and a bounded post-timeout sweep preserves the existing teardown path.
- Detach consumes the output delta once, wires the normal background completion notifier, and
  returns the persistent `bash_N` handle with instructions for output and termination.

### Why

A foreground wait beyond the prompt-cache-safe deadline risks invalidating the prompt cache.
Promotion preserves the command and its original kill deadline while returning control to the
agent before that cache deadline. `timeoutAction: "kill"`, absent cache budgets, and timeouts at
or below the budget retain their existing foreground behavior.

### Expected merge conflict zones on next upstream sync

- LOW: `tools/bash.ts` foreground lifecycle and `extension.ts` tool-context getters.

## Footer status for active monitors (2026-07-28)

### What changed

- `monitor-registry.ts`: `MonitorRegistry` accepts optional `MonitorRegistryOptions.onChange`, fired
  with a `snapshot()` (`{id, description, paused}[]`) on register, pauseAll (when any paused),
  rearm, settle, and dispose. `snapshot()` is public.
- `monitor-status.ts` (new): `formatMonitorStatus(snapshot)` — undefined when nothing is watched
  (clears the footer status), `watching <desc>` for one, `watching N: <d1>, <d2>` elided to a
  48-char cap for many, `(paused)` / `(k paused)` markers. `MONITOR_STATUS_KEY = "monitors"`.

### Count-forward visibility rework (2026-07-28)

- `formatMonitorStatus` now leads with the `◉` watch glyph (session-selector glyph family) so the
  status is visually distinct from other extension statuses, and packs whole descriptions instead
  of mid-word elision: `◉ watching <desc>` for one, `◉ watching N: <d1>, <d2> +k more` for many.
  The monitor count and the `(paused)` / `(k paused)` suffix always survive truncation; only the
  description list shrinks (whole-name packing first, single-name `…` truncation as last resort).
  48-char cap unchanged. Tests updated in `test/suite/terminal-monitor-footer.test.ts`.
- `extension.ts`: the session monitor registry is created with an onChange that publishes
  `ctx.ui.setStatus(MONITOR_STATUS_KEY, formatMonitorStatus(snapshot))` — the goal-builtin
  footer-status pattern. Non-interactive modes no-op via the optional ctx; settle/shutdown
  dispose clears the status.
- `test/suite/terminal-monitor-footer.test.ts` (new): formatter cases, registry transition
  notifications (register/pause/rearm/settle/dispose with real pipe-forced sessions), and
  extension wiring (fake pi + ui.setStatus spy, real monitor tool execution).

### Why extension system could handle this

- Entirely extension-owned: `ctx.ui.setStatus` is the established footer surface
  (goal/websearch/webfetch precedent); no core or footer-layout changes.

### Expected merge conflict zones on next upstream sync

- LOW: fork-owned `monitor-registry.ts` constructor/notify points, `extension.ts`
  monitorRegistry getter, new `monitor-status.ts`.

## Wait-discipline routing: bash surface redirect + guidance dedup (2026-07-28)

### What changed

- `tools/bash.ts`: the PTY `bash` tool description now carries the wait redirect — waiting on
  observable state (a build finishing, a server coming up, a log line) is never a sleep/poll
  loop; subscribe with the `monitor` tool instead. The bash surface is where a model actually
  types `sleep 30`, and cross-tool routing in the misused tool's description follows the same
  pattern as the grep→rg snippet rule (`test/bash-prompt-snippet.test.ts`). The upstream core
  bash (`src/core/tools/bash.ts`) is deliberately untouched: its toolset has no monitor, and
  guidance must never name a tool the toolset lacks.
- `tools/monitor.ts`: promptGuidelines collapsed to the single when-to-use decision rule. The
  command-shaping sentence duplicated the TERMINAL_PROMPT_SECTION bullet near-verbatim; each
  aspect is now stated once (decision rule → Tool Guidelines; mechanics → terminal section;
  redirect → bash schema; long-run routing → bash-timeout policy).
- `prompt.ts`: the monitor bullet dropped its embedded when-to-use sentence (kept as the monitor
  tool's guideline) and keeps the subscribe framing plus shaping/filtering/rearm mechanics.
- `test/prompt-surface-stale-wait-idioms.test.ts`: the consistency gate now enumerates every
  registered terminal tool surface (description + promptSnippet + promptGuidelines of bash,
  bash_output, monitor, bash_input, bash_resize, kill_bash) plus the bash-timeout prompt
  section; new gates assert the bash description routes waits to monitor, and that no
  agent-facing terminal surface teaches tmux as the backgrounding mechanism — a tmux mention is
  allowed only when the negation targets tmux itself ("do NOT use tmux"), so "use tmux; never
  X" cannot slip through.
- `test/suite/terminal-monitor-notify.test.ts`: the watcher-discipline case now asserts the
  routing rule at its owning surface (the monitor tool's promptGuidelines) instead of
  TERMINAL_PROMPT_SECTION, and the noise-control match is wrap-tolerant.

### Expected merge conflict zones on next upstream sync

- LOW: `tools/bash.ts` description string, `tools/monitor.ts` promptGuidelines, `prompt.ts`
  monitor bullet, gate-test surface list (all fork-owned).

## Monitor flat schema + subscribe-not-poll prompt (2026-07-27)

### What changed

- `monitorSchema` is now a single flat `Type.Object` (action via a string enum; description,
  command, filter, timeout_ms, persistent, bash_id all optional at schema level). Branch
  requirements moved to runtime: create requires description+command, rearm requires bash_id,
  each returning a clear `errorResult` instead of relying on schema-union validation.
- Why: several provider payload paths rebuild tool schemas from top-level `properties` only
  (Anthropic's legacy input_schema conversion in packages/ai `convertTools`), so the previous
  top-level `Type.Union` reached Claude as an EMPTY schema — the model saw a parameterless
  `monitor` tool and fell back to foreground sleep/poll loops.
- Tool description, promptSnippet, promptGuidelines, and the `prompt.ts` monitor bullet were
  rewritten to event-subscription framing (subscribe-not-poll, command shaped by notification
  count), referencing Claude Code's Monitor tool prompt but far shorter.
- `renderMonitorCall` falls back to command/empty when the now-optional description is absent.

### Expected merge conflict zones on next upstream sync

- LOW: `tools/monitor.ts` (fork-owned tool), `tools/render.ts` label line, `prompt.ts` monitor
  bullet, `test/suite/terminal-monitor.test.ts` new schema/validation cases.

## bash_output peek-only (2026-07-26)

### What changed

- `bash_output` is now a pure non-blocking peek: new output since the last read, the status
  line, or `view:"screen"`. The `wait_for` blocking path (plus `block` and the wait
  `timeout`) is removed from the tool and from `TerminalRuntimeSession` (waiter machinery,
  `waitFor()`, exit-settling) — watchers subscribe through `onOutput` (the monitor path)
  instead of blocking inside a read call.
- `wait_for`, `block`, and `timeout` stay in the schema as deprecated ghost params: passing
  any of them returns `BASH_OUTPUT_WAIT_REMOVED_GUIDANCE`, a one-line migration error that
  redirects pattern watches to `monitor({command, filter})`, names the peek-or-relaunch
  fallback for already-running sessions, and notes completion notifications carry the tail.
- The terminal prompt section, `docs/terminal-tools.md`, the senpi-qa skill, and the
  pty-drive self-test now teach the monitor/notification model; a repo consistency-gate
  test (`test/prompt-surface-stale-wait-idioms.test.ts`) fails on any non-ghost `wait_for`
  teaching in shipped prompt surfaces.

### Why

Corpus mining (875 sessions) showed 76% of `bash_output` calls were `wait_for` waits and
30% were empty polls — the notification channel and the monitor tool already do that work.
`bash_input`, `kill_bash`, `run_in_background`, and the notify pipeline are untouched
(plan: `.omo/plans/eval-exec-merge-and-injection-wakeup.md`, todo 13).

### Expected merge conflict zones on next upstream sync

- LOW: `tools/bash-output.ts` schema + execute path (fork-owned tool).
- LOW: `runtime-session.ts` (fork-owned class; waiter removal is additive-safe upstream).
- LOW: `prompt.ts` terminal prompt section.

## Monitor watcher sessions (2026-07-26)

### What changed

- Added the PTY-backed `monitor` terminal-extension tool. `monitor({ description, command,
  filter?, timeout_ms?, persistent? })` starts through the existing `TerminalManager` and returns
  its normal `bash_N` id immediately, so `bash_output` remains the bounded peek surface and
  `kill_bash` terminates the same watcher process tree. `action:"rearm"` deliberately reports a
  no-op for a live non-paused monitor; wake-budget pausing and rearming delivery land with the
  notification layer.
- `monitor-registry.ts` line-buffers terminal output with one bounded unfinished line per live
  watcher, emits only complete stdout lines (optionally regex-filtered), and emits one final
  completion/timeout/kill summary. The terminal runtime retains the bounded full output, so
  filtered and overflow lines remain peekable.
- The permission parser classifies monitor commands in the existing `bash` permission class,
  preserving the same approval path as `bash` rather than creating a parallel executor policy.

### Why

Long-running builds, CI, and log tails should report decision-relevant state changes without
polling. Keeping monitor inside the terminal extension is required because its session manager is
session-scoped private state; a shared cross-tool registry would enlarge the fork surface without
improving the handle contract (plan: `.omo/plans/eval-exec-merge-and-injection-wakeup.md`, todo 3).

### Event delivery (2026-07-26)

- `monitor-notify.ts` batches stdout events for two seconds and applies a per-monitor five-second
  injection limit by default. One session queue coalesces simultaneous monitors, caps each message
  at 50 lines / 4KB with a `bash_output` peek reminder for overflow, and bounds retained queue
  state to that one capped batch.
- The existing terminal notification guard and mode mapping are shared: `wake` steers,
  `next-turn` follows up, `off` suppresses, and `print`/`json` plus sessions without a model never
  inject or create an auth-less turn. Five monitor-only wakes add one pause notice to the fifth
  injection and pause live watchers until `monitor({ action:"rearm", bash_id })` explicitly
  resumes delivery.
- `terminal.monitorCoalesceWindowMs`, `monitorRateLimitMs`, `monitorMaxLinesPerInjection`,
  `monitorMaxCharsPerInjection`, and `monitorWakeBudget` tune the coalescing/rate/batch/budget
  limits. Monitor calls render with their description or rearm handle, and the terminal prompt
  teaches decision-relevant watcher output rather than noisy log forwarding.

### Expected merge conflict zones on next upstream sync

- LOW: `extension.ts` terminal tool registration and session teardown.
- LOW: `settings.ts` terminal notification settings shape.
- LOW: `shared.ts` companion tool list and terminal tool constants.

## Payload-rich background completion notifications (2026-07-26)

### What changed

- `notify.ts` `buildNotice()`: the background-session completion notice now embeds the exit
  status (unchanged) AND the final output tail (sanitized via `sanitizeTerminalOutput`,
  tail-capped at `NOTICE_TAIL_MAX_CHARS` = 2000 chars, with a truncation note that the full
  history is still peekable) INSTEAD of the old `Use bash_output({ bash_id: "..." }) to read
  its output` instruction. Notify modes (`wake`/`next-turn`/`off`) and all guards
  (non-interactive `print`/`json` suppression, no auth-less turn spin, once per session id)
  are unchanged. `bash_output` itself is untouched.

### Why

Real session evidence: session `019f79b8-3bec` received the old reminder, dutifully called
`bash_output`, and got `(no new output)` — a wasted round per background completion. The
notification is authoritative; receiving it must make a follow-up read unnecessary
(plan: `.omo/plans/eval-exec-merge-and-injection-wakeup.md`, todo 1 / lane S1).

### Expected merge conflict zones on next upstream sync

- LOW: `notify.ts` `buildNotice()` body (single function; guards untouched).

## Model-facing output is sanitized and bounded (2026-07-21)

### What changed

- `output-format.ts` (new): `sanitizeTerminalOutput()` strips ANSI escape sequences (OSC/CSI/
  designate/single-char) and folds carriage-return/backspace redraw semantics so spinner and
  progress frames collapse to their final visible state; `formatTerminalToolOutput()` then
  tail-truncates to the core-bash budget (`TERMINAL_TOOL_MAX_LINES` 2000 / `TERMINAL_TOOL_MAX_BYTES`
  50 KB via `core/tools/truncate.ts`) with an "earlier output dropped" marker.
- `tools/bash.ts`: foreground results now go through `formatTerminalToolOutput()` instead of
  returning the raw scrollback (up to 1 MB of ANSI soup) verbatim; truncated results carry
  `details.truncation`. Background start-grace output is formatted the same way.
- `tools/bash.ts` + `tools/spawn.ts` + `shared.ts`: foreground spawns merge
  `FOREGROUND_ENV_OVERRIDES` (`NO_COLOR=1`, `TERM=dumb`, `COLORTERM=`, `PAGER/GIT_PAGER/GH_PAGER=cat`,
  codex-style) over `ctx.getEnv()` so cooperative tools never emit spinner/color frames; background
  (interactive) sessions keep the user's real `TERM`.
- `tools/bash-output.ts`: `bash_output` log-view deltas are sanitized and bounded the same way.

### Why

A single `gh run view --log-failed` returned 999,998 chars (the 1 MB session buffer) straight into
the conversation — context jumped 154k → 404k tokens and forced an emergency compaction; a
`gh pr checks --watch` result was 118k chars of raw spinner frames. Real session evidence:
`--Users-yeongyu-local-workspaces-omo--/2026-07-21T03-07-29-890Z_019f82a4-...` (two compactions
within 15 minutes, both driven by oversized bash results).

### Expected merge conflict zones on next upstream sync

- LOW: `tools/bash.ts` `runForeground` result construction and `runBackground` early-output block.
- LOW: `tools/bash-output.ts` log-view result construction.
- LOW: `tools/spawn.ts` `SpawnRequest` shape and `manager.create` env merge.

## Core files touched (2026-07-07)

- `core/extensions/builtin/index.ts`: register `terminal` after `bash-timeout`/`anthropic-bash`
  so (a) bash-timeout's injected default reaches PTY `bash`, and (b) mutual-exclusion with
  native Anthropic bash is evaluated after anthropic-bash registers.
- `utils/shell.ts`: `getShellConfig` now honors `SENPI_GIT_BASH_PATH` (Windows-first) and
  resolves an explicit shell path by KIND (`cmd.exe` → `/c`, PowerShell → `-NoProfile -Command`,
  bash/sh → `-c`/`-s`). New exports `resolveShellKind`, `GIT_BASH_PATH_ENV`, `ShellKind`, and a
  `kind` field on `ShellConfig`. See `utils/changes.md`.
- `core/settings-manager.ts`: `TerminalSettings` gains `defaultCols/defaultRows/scrollback/
  maxSessions/timeoutAction/notify` for the terminal tool suite (read via `settings.ts`).
- `core/extensions/builtin/permission-system/parsers.ts`: `bash_input` is gated in the SAME
  `bash` permission class (parsed off its `input` field), so read-only/ask presets are not
  bypassable through a live session. See `permission-system/changes.md`.

## Design decision: mutual exclusion with anthropic-bash

The extension registers a tool named `bash` that overrides core `bash` in the session tool
registry (extension tools override base tools by name in `agent-session._refreshToolRegistry`).
On `session_start` AND `model_select`, `syncToolset` re-evaluates:

- Native Anthropic bash active (`PI_ANTHROPIC_BASH` truthy AND `model.api ===
  "anthropic-messages"`): the four companion tools are DEACTIVATED so none dangle without a
  usable persistent `bash`. anthropic-bash's `before_provider_request` already strips the
  function `bash` from the payload and injects the native `bash_20250124`, so the model uses
  native bash; a one-line `ctx.ui.notify` notice is shown once.
- Otherwise: PTY `bash` + all four companions are (re)activated.

Because extension tools permanently shadow core `bash` by name, a name-toggle cannot recover
the ORIGINAL core `bash` executable once the terminal tool is registered. Rather than add a
core tool-restore API (a larger fork-surface change), the step-aside relies on anthropic-bash's
existing payload sanitization to present native bash to the model; the shadowed PTY `bash` only
executes a native-bash `tool_use` in the rare case one is dispatched, where its foreground path
(command runs; unknown `restart` ignored) is functionally correct. Companion orphaning — the
correctness the plan targets — is fully prevented by deactivation.

## pi-pty note

`packages/pty/src/registry-session.ts` `waitForTerminalSessionExit` was fixed to invoke
`session.waitExit()` via the session object rather than a detached reference, so class-based
sessions (pi-pty `TerminalSession`) keep their `this` binding under `SessionRegistry.stop/
teardown`. Regression test: `packages/pty/test/registry.test.ts`.

## Fast-exit PTY output drain (2026-07-14)

- `crates/senpi-pty/src/session.rs`: synchronous and background waits close the PTY writer/master
  and join the reader before reporting exit, preserving final output from fast-exiting commands.
- `crates/senpi-pty/src/lib.rs`: native data callbacks wait until the JavaScript callback has run,
  preserve callback exceptions, and unblock only when the thread-safe function reports N-API
  environment teardown, so the reader join guarantees delivery without leaking a blocked thread.
- `core/extensions/builtin/terminal/runtime-session.ts`: constructs `TerminalSession` explicitly,
  registers output/exit listeners, then calls `start()` so startup output cannot beat subscription.

This ordering belongs below the extension layer: an extension cannot change native PTY teardown or
subscribe before a session created by the convenience factory has already started. During upstream
merges, preserve the close-writer → close-master → join-reader sequence, the N-API delivery
acknowledgement, and listener-before-start construction. Expected conflict zones are native session
lifecycle code, the N-API `startPtySession` callback, and terminal runtime construction.

## Foreground abort/timeout must release the tool (2026-07-18)

- `tools/bash.ts`: foreground abort now sends one decisive group `SIGKILL` (the pi-pty `kill()` is one-shot
  idempotent, so a first gentle SIGTERM would block escalation and a SIGTERM-ignoring command pinned the agent
  forever). The exit wait is raced against `KILLED_SESSION_EXIT_GRACE_MS` (new in `shared.ts`, 5s) armed on abort
  and on `timeoutMs + grace`: the native wait joins the PTY reader thread, which blocks while any surviving
  descendant (own process group, inherited slave fd) holds the PTY open — previously ESC appeared dead while
  "Running bash" counted up for hours. When the grace releases the wait, the session entry may settle later
  through the registry's own `onExit` subscription (an unkillable holder can keep it `stopping`).
- Aborted foreground runs now report `Command aborted` (core bash parity) instead of `Command exited with code
  137`; timeout-grace releases report the standard `Command timed out after N seconds`.
- A signal already aborted at execute-entry returns `Command aborted` without spawning a session; the
  timeout-grace timer is not armed when `timeoutMs + grace` exceeds the 32-bit `setTimeout` range (no false
  early timeout); on a grace release the tool sweeps the session via `ctx.manager.stop(id)` (fire-and-forget).
- `@earendil-works/pi-pty` `SessionRegistry` gained `stopExitGraceMs` (default 5s): `stop()`/`teardown()` now
  bound their exit wait and mark a never-settling session `stopping` instead of hanging — without this, the
  terminal extension's awaited `manager.teardown()` made `/exit` hang on the same held-open PTY. Residual: a
  `stopping` entry still occupies a registry slot until its exit finally settles (capacity cap 32).
- Regression coverage: `test/terminal-bash-abort.test.ts` (pre-aborted signal spawns nothing, SIGTERM-ignoring
  command, PTY held open across abort and timeout, plain-run pin) and `packages/pty/test/registry.test.ts`
  (bounded stop/teardown on a session that never reports exit).
