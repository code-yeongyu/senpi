# Persistent terminal tools

Senpi's `bash` tool is backed by a real PTY, and ships five companion tools for
long-lived, interactive shell sessions. This is the built-in `terminal` extension,
powered by the in-house `@earendil-works/pi-pty` native module (with a
`child_process` pipe fallback when no native prebuild is available for your
platform/runtime).

## Tools

| Tool | Purpose |
|------|---------|
| `bash` | Run a command in a PTY. `run_in_background: true` starts a persistent session and returns a `bash_id` immediately. Foreground `timeout` (seconds) is a kill deadline. |
| `bash_output` | Peek at a session without blocking: new output since the last read, or the status line. `filter` regex-filters lines; `view: "screen"` returns the rendered xterm grid. |
| `monitor` | Watch either a long-running command (`command`, optional `filter`) or one file transition (`path`, `event: "create" \| "modify"`). Live watches appear in the interactive footer and survive `/reload`. |
| `bash_input` | Send stdin (`input`) or named keys (`keys: ["ctrl+c"]`, `["enter"]`, `["up"]`) to steer a REPL or interrupt a process. |
| `bash_resize` | Resize a session's PTY (`cols`, `rows`) so full-screen TUIs reflow. |
| `kill_bash` | Tree-kill one terminal session or cancel one native file watch by its `bash_N`/`watch_N` id, or cancel all with `all: true`. |

Background sessions are NEVER killed by `timeout` (they live until they exit or you
call `kill_bash`), even though the bash-timeout extension injects a default `timeout`
into every `bash` call. Foreground calls behave like the classic `bash` tool.

Background sessions and monitors also survive a session reload (`/reload`): existing
`bash_N` ids stay addressable, watchers keep injecting events, and completion
notifications keep arriving. Quitting or switching sessions still tears everything down.

For command monitors, call `monitor({ command, ... })` directly; it creates and owns
the PTY session returned as `bash_N`. Peek with `bash_output`, steer with `bash_input`,
then `kill_bash` when done. For native file monitors, use the returned `watch_N`
directly with `monitor({ action: "rearm", bash_id: "watch_N" })` or `kill_bash`;
`bash_output` only accepts terminal sessions.

## Monitor recipes

Each recipe shapes the command so the interesting moment becomes one clean,
newline-terminated line. Sleep loops live inside the monitored command.

### Dev-server readiness gate

```js
monitor({ description: "dev server ready",
  command: "until curl -fsS http://localhost:3000/health; do sleep 1; done; printf 'READY\n'",
  filter: "^READY$" })
```

Expected event: one `READY` line, then the exit summary. Follow-up: hit the
server. Nothing outlives the watch, so no cleanup.

### Long test or build with a pass/fail sentinel

```js
monitor({ description: "full test suite",
  command: "if npx vitest run; then printf 'OK\n'; else code=$?; printf 'FAILED_%s\n' \"$code\"; exit \"$code\"; fi",
  filter: "^(OK|FAILED_)" })
```

Expected event: `OK` or `FAILED_<code>` plus the exit summary. On `FAILED_`,
read the tail with `bash_output` and fix; on `OK`, move on.

### QA error stream from a log

```js
monitor({ description: "app error watch",
  command: "tail -n 0 -F app.log | grep --line-buffered -E 'ERROR|FATAL'",
  persistent: true })
```

Expected events: each new ERROR/FATAL line as it lands. Follow-up: investigate
the failure it names. `tail -F` never exits, so `kill_bash` the `bash_id` when
the QA pass ends.

### CI / PR check watch

```js
monitor({ description: "PR checks",
  command: "gh pr checks 1052 --watch 2>&1",
  filter: "fail|pass|All checks" })
```

Expected event: the verdict line when checks settle, then the summary. Merge on
pass, pull the failing job's log on fail. The command exits by itself.

### File artifact transition

```js
monitor({ description: "artifact written",
  path: "dist/app.tar.gz",
  event: "create" })
```

Expected event: `created <absolute-path>`, then completion. Use `event: "modify"`
when an existing artifact is atomically replaced or rewritten. Permission checks cover
both the requested logical path and its approved canonical target; retargeting a
symlinked parent invalidates the watch. Before inspecting a target, Senpi starts a
pooled worker whose retained working directory is the approved canonical parent and
checks its bigint device/inode identity. Every target lookup is then a basename-only
`lstat` relative to that retained directory, so renaming the parent and installing an
attacker-controlled replacement cannot redirect the worker to an unapproved file.

Each approved-directory worker shares one `fs.watch` wake hint and one anchored
`lstat` recheck per second. This catches a transition when the operating system
silently drops the corresponding notification; watcher startup or runtime failure
leaves the bounded stat recheck active. Node documents native watch notifications as
potentially unreliable on NFS, SMB, and host filesystems exposed through
virtualization such as Docker or Vagrant. If those filesystems do not provide usable
stat semantics, or the secure worker cannot start, use a bounded command monitor as
a compatibility fallback:

```js
monitor({ description: "artifact written on network mount",
  command: "until test -f dist/app.tar.gz; do sleep 2; done; printf 'READY\\n'",
  filter: "^READY$",
  timeout_ms: 300000 })
```

The compatibility command consumes a shell process until it completes, so prefer the
native path monitor whenever the filesystem supports it. See the
[Node `fs.watch` caveats](https://nodejs.org/api/fs.html#caveats).

Ports and other non-filesystem predicates still use command monitors:

```js
monitor({ description: "database ready",
  command: "until nc -z localhost 5432; do sleep 1; done; printf 'READY\n'",
  filter: "^READY$" })
```

### Child-agent sentinel watch

```js
monitor({ description: "subtask done",
  path: "/tmp/task.status",
  event: "create" })
```

The child writes the status file only when it has finished. The parent reads the
status once after the event and integrates the results. Exits on its own; no cleanup.

### Anti-patterns

| Anti-pattern | Do instead |
|---|---|
| Shell polling for a file on a supported local filesystem | Use native `path` + `event: "create"`; reserve the bounded command fallback for filesystems where native registration fails |
| Sleeping in your own turn for a non-file predicate | Put the bounded gate inside a monitor command |
| Spinning on `bash_output` reads | Register a monitor; peek only to steer |
| Filterless watch on a chatty command | Shape output at the source, then narrow with `filter` |
| Expecting `filter` to stop the command | `filter` gates events only; make the command exit on the condition |
| `persistent: true` with `timeout_ms` | The timeout is ignored when persistent; pick one |
| Sentinel printed without a trailing newline | Sentinels must be newline-terminated: `printf 'READY\n'` |
| Monitoring sub-minute deterministic work | Run it directly in the foreground |
| Rearming a monitor that was never paused | Rearm only the `bash_N` or `watch_N` id named in a pause notice |

## Mutual exclusion with native Anthropic bash

When `PI_ANTHROPIC_BASH` is enabled and the active model uses the
`anthropic-messages` API, senpi injects Anthropic's native, stateless `bash` tool.
Senpi's persistent `bash` definition steps aside, while the five companion tools
remain registered so command monitors, existing PTY ids, and native `watch_N` file
monitors retain their lifecycle controls.

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
