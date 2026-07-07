# terminal builtin extension — fork surface

The persistent-terminal tool suite (`bash` swapped to PTY-backed + `bash_output`,
`kill_bash`, `bash_input`, `bash_resize`). Backed by `@earendil-works/pi-pty`.

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
