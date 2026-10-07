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
| `bash_output` | Peek at a session without blocking: new output since the last read, or the status line. `filter` regex-filters lines; `view: "screen"` returns the rendered xterm grid. |
| `monitor` | Watch a change and inject it as coalesced events, passing `command` XOR `path`: a long-running command (`description`, `command`, `filter?`, `timeout_ms?`, `persistent?`) injects matching PTY output lines, while a file (`description`, `path`, `event?`, `persistent?`) fires once natively. Every call returns a stable `mon_` id (with the runtime `bash_N` handle as `details.bash_id`); either id addresses the watch. While watches are live, the interactive footer shows a brief `watching …` status (descriptions, count, paused markers). |
| `bash_input` | Send stdin (`input`) or named keys (`keys: ["ctrl+c"]`, `["enter"]`, `["up"]`) to steer a REPL or interrupt a process. |
| `bash_resize` | Resize a session's PTY (`cols`, `rows`) so full-screen TUIs reflow. |
| `kill_bash` | Tree-kill one session (`bash_id`) or all (`all: true`), leaving no orphans. |

Background sessions are NEVER killed by `timeout` (they live until they exit or you
call `kill_bash`), even though the bash-timeout extension injects a default `timeout`
into every `bash` call. Foreground calls behave like the classic `bash` tool.

Background sessions and monitors also survive a session reload (`/reload`): existing
`bash_N` ids stay addressable, watchers keep injecting events, and completion
notifications keep arriving. Quitting or switching sessions still tears everything down.

## Standing watches (`persistent: true`)

`persistent: true` turns a monitor into a standing watch: no `timeout_ms` deadline, and it
survives a full session restart, not just a `/reload`. On the next start of the same session:

- a **command** watch is re-run exactly once, in its original working directory, under the
  same `mon_` id. Nothing the previous PTY printed is replayed — output is never persisted,
  so a restored watch starts from an empty buffer;
- a **file** watch is re-registered under its original `mon_` id and its saved checkpoint
  (device, inode, size, mtime, content digest) is compared once against the file as it is now.
  A change that happened while senpi was gone is reported as exactly one line — `created`,
  `replaced`, or `modified` — and nothing is reported when the file is byte-identical. A file
  that has since been deleted, or is no longer a regular file, is reported lost instead.

Whatever it finds is summarized in **one** line on session start, e.g.
`Terminal state after restart: restored 2 (dev server ready, app error watch); lost 1 (PR checks).`
Expired watches (`expired N`) and watches still muted by the wake budget (`N still muted`) are
counted in that same line, which follows the `notify` setting like any other reminder; a
watch muted before the restart comes back muted, so `monitor({ action: "rearm", bash_id })`
is what un-mutes it. Ephemeral (non-persistent) monitors and background `bash` sessions are
never restored, and are reported as lost.

Standing watches are bounded: at most **5** per session (a sixth `persistent` create is
refused, with nothing spawned), and each **expires 7 days after it was created** — a deadline
neither a restore nor a rearm extends. Stop one early with `kill_bash`. If the same session is
already live in another process, that process keeps the watches and this one restores nothing
and says so.

Typical flow: start with `run_in_background: true`, watch for patterns with `monitor`,
peek with `bash_output`, steer with `bash_input`, then `kill_bash` when done. Completion
arrives as a notification carrying the exit code and output tail, so a follow-up
`bash_output` read is only needed when the tail is not enough.

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
  command: "if bunx vitest run; then printf 'OK\n'; else code=$?; printf 'FAILED_%s\n' \"$code\"; exit \"$code\"; fi",
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

### File transition (native file branch)

```js
monitor({ description: "artifact written",
  path: "dist/app.tar.gz",
  event: "create" })
```

One file, watched natively — no shell, no poll loop. `create` (the default)
fires only when the file appears after registration; to watch a file that
already exists, pass `event: "modify"`. Registration needs the parent directory
(`dist/` here) to exist already, and the target must be a regular file, not a
symlink — when the build creates the directory too, keep a command poll loop
like the port recipe below. This branch is XOR with `command` and takes no
`filter`. Expected event: one hit when the file lands, then the watch is done.
Consume the artifact. Add `persistent: true` to make it a standing watch that
survives a restart and reports a change it missed while detached.

### Port transition

```js
monitor({ description: "postgres up",
  command: "until nc -z localhost 5432; do sleep 1; done; printf 'READY\n'",
  filter: "^READY$" })
```

A port has no native watch, so the sleep loop belongs inside the command.
Expected event: `READY`, then exit. Connect.

### Child-agent sentinel watch

```js
monitor({ description: "subtask done",
  command: "until grep -q '^status=done$' /tmp/task.status 2>/dev/null; do sleep 5; done; printf 'READY\n'",
  filter: "^READY$" })
```

Expected event: `READY` once the child flips its status file. Read the child's
results and integrate. Exits on its own; no cleanup.

### Anti-patterns

| Anti-pattern | Do instead |
|---|---|
| Sleeping in your own turn between polls | Put the sleep loop inside the monitor command |
| Spinning on `bash_output` reads | Register a monitor; peek only to steer |
| Filterless watch on a chatty command | Shape output at the source, then narrow with `filter` |
| Expecting `filter` to stop the command | `filter` gates events only; make the command exit on the condition |
| `persistent: true` with `timeout_ms` | A standing watch has no deadline; the timeout is ignored |
| Re-registering a standing watch after a restart | It is already back under the same `mon_` id; read the restart line first |
| Holding more than 5 standing watches per session | The sixth is refused; `kill_bash` one you no longer need |
| Sentinel printed without a trailing newline | Sentinels must be newline-terminated: `printf 'READY\n'` |
| Polling `test -f` in a command to await one file | Use the file branch: `monitor({ description, path, event? })` |
| `event: "create"` on a file that already exists | `create` fires only on appearance; use `event: "modify"` |
| `path` whose parent directory the build has yet to create | Registration fails; poll for it with a `command` watch instead |
| Passing `command` and `path` in one call | They are XOR; pick the branch that matches what you await |
| Monitoring sub-minute deterministic work | Run it directly in the foreground |
| Rearming a monitor that was never paused | Rearm only a `bash_id` named in a pause notice |

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
