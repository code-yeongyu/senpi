# Persistent terminal tools

Senpi's `bash` tool is backed by a real PTY, and ships four companion tools for
long-lived, interactive shell sessions. This is the built-in `terminal` extension,
powered by the in-house `@earendil-works/pi-pty` native module (with a
`child_process` pipe fallback when no native prebuild is available for your
platform/runtime).

## Tools

| Tool | Purpose |
|------|---------|
| `bash` | Run a command in a PTY. `run_in_background: true` starts a persistent session and returns a `bash_id` immediately. Foreground `timeout` (seconds) is a kill deadline. |
| `bash_output` | Read new output from a session, or `wait_for` a regex / exit / timeout. `filter` regex-filters lines; `view: "screen"` returns the rendered xterm grid. |
| `bash_input` | Send stdin (`input`) or named keys (`keys: ["ctrl+c"]`, `["enter"]`, `["up"]`) to steer a REPL or interrupt a process. |
| `bash_resize` | Resize a session's PTY (`cols`, `rows`) so full-screen TUIs reflow. |
| `kill_bash` | Tree-kill one session (`bash_id`) or all (`all: true`), leaving no orphans. |

Background sessions are NEVER killed by `timeout` (they live until they exit or you
call `kill_bash`), even though the bash-timeout extension injects a default `timeout`
into every `bash` call. Foreground calls behave like the classic `bash` tool.

Typical flow: start with `run_in_background: true`, subscribe with `bash_output`
(`wait_for`), steer with `bash_input`, then `kill_bash` when done.

## Mutual exclusion with native Anthropic bash

When `PI_ANTHROPIC_BASH` is enabled and the active model uses the
`anthropic-messages` API, senpi injects Anthropic's native, stateless `bash` tool.
In that mode the four persistent companions step aside (they are deactivated so none
dangle without a usable persistent `bash`), and a one-line notice is shown. Disable
`PI_ANTHROPIC_BASH` or switch to a non-Anthropic model to re-enable persistent
sessions.

## Settings

Configure the suite under `terminal` in `settings.json` (global
`~/.senpi/agent/settings.json` or project `.senpi/settings.json`):

```json
{
  "terminal": {
    "defaultCols": 120,
    "defaultRows": 40,
    "scrollback": 10000,
    "maxSessions": 32,
    "timeoutAction": "background",
    "notify": "wake"
  }
}
```

- `defaultCols` / `defaultRows` — PTY size for new sessions (default 120 x 40).
- `scrollback` — xterm scrollback lines per session (default 10000).
- `maxSessions` — concurrent sessions before least-recently-used exited sessions are pruned (default 32).
- `timeoutAction` — fate of a foreground timeout (default `background`).
- `notify` — async completion behavior: `wake` (wake an idle interactive agent once), `next-turn`, or `off` (default `wake`). Non-interactive `-p` / `--print` / `--mode json` runs never wake.

## Windows

The PTY runs natively on Windows via ConPTY. Shell resolution:

- Set `SENPI_GIT_BASH_PATH` to point at a specific `bash.exe` — it wins over the
  Git Bash auto-detection.
- An explicit shell path (`shellPath` in settings, or `SENPI_GIT_BASH_PATH`) is
  resolved by kind: `cmd.exe` uses `/c`, PowerShell/`pwsh` use `-NoProfile -Command`,
  and bash/sh use `-c` (or WSL bash `-s` via stdin).

No shell is bundled; install Git for Windows or point senpi at your shell.
