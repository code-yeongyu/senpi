# terminal builtin extension — fork surface

The persistent-terminal tool suite (`bash` swapped to PTY-backed + `bash_output`,
`kill_bash`, `bash_input`, `bash_resize`). Backed by `@earendil-works/pi-pty`.

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
