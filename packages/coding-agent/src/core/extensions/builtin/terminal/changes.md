# terminal builtin extension — fork surface

The persistent-terminal tool suite (`bash` swapped to PTY-backed + `bash_output`,
`kill_bash`, `bash_input`, `bash_resize`). Backed by `@earendil-works/pi-pty`.

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
