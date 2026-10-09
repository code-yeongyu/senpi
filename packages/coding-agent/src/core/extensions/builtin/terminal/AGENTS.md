# builtin/terminal

Builtin extension #18. Replaces one-shot bash with a **PTY-backed persistent session** model: `bash` plus companion tools `bash_output`, `bash_input`, `bash_resize`, `kill_bash`, and `monitor`. Registered after `bash-timeout` (so the resolved default timeout reaches PTY bash) and after `anthropic-bash` (so a native Anthropic bash tool makes terminal step aside).

## FILES

```
terminal/
├── index.ts             # Barrel: extension + settings + tool-name constants + shared key/regex helpers
├── extension.ts         # Registration entry — registers all six tools, wires lifecycle + reload bundles
├── extension-state.ts   # Per-generation state, sinks and tool context shared by extension.ts + restore-session.ts
├── restore-session.ts   # session_start: lease -> detached restore -> digest slot; keeper takeover; shutdown release
├── manager.ts           # TerminalManager: session map ownership
├── pty.lazy.ts          # Deferred import of @earendil-works/pi-pty / @xterm/headless
├── runtime-session.ts   # TerminalRuntimeSession: one live PTY
├── session-bundle.ts    # TerminalSessionBundle: reload parking/claiming across extension generations
├── monitor-registry.ts  # MonitorRegistry: registered watches over session output
├── monitor-notify.ts    # Event → notification delivery (283 LOC, largest non-tool file)
├── monitor-status*.ts   # Footer status text + 1s unref'd ticker
├── notify.ts            # TerminalNotifier
├── output-format.ts     # Output shaping/sanitization
├── settings.ts          # loadTerminalSettings / resolveTerminalSettings
├── shared.ts            # Defaults: 120x40, 10000 scrollback, 32 sessions, 1,000,000 output chars;
│                         durable expiry (DURABLE_MONITOR_EXPIRY_MS 7d; the per-session durable cap is
│                         the optional terminal.maxDurableMonitors setting, unlimited by default)
├── terminal-manifest-model.ts # Manifest data model: persisted types + version/debounce constants
├── terminal-manifest.ts # Durable per-session record + TerminalManifestWriter (transition writes,
│                         debounced checkpoints, durableCount admission, adoptRestored)
├── terminal-manifest-parse.ts # Strict fail-closed manifest parse (re-exported by restore.ts)
├── restore.ts           # restoreTerminalState: classify → concurrent handlers → per-monitor results,
│                         background sessions, downtime upper bound + reapplyPersistedMute
├── restore-digest.ts    # ONE `senpi-terminal:restore-digest` message per generation + slot + renderer
├── session-activity.ts  # Last transcript entry before this process started (downtime bound input)
├── manifest-lease.ts    # Per-session lease v2: token + pid + boot + start instant; self/dead/reused/live-foreign
├── lease-keeper.ts      # Waits on a live foreign holder (10s stat + kill 0), takes over exactly once
├── lease-file.ts        # Lease file primitives: link/rename publish, identity-checked reclaim lock (pid + boot + start instant), reclaim of the inspected record only
├── process-identity.ts  # Boot instant, own start (floored like ps), tolerances
├── process-start-probe.ts # Cold read of a foreign pid's start instant (procfs / ps / PowerShell)
├── orphan-reaper.ts     # Confirm a crash-orphaned watcher (boot + start + marker) and kill its group
├── monitor-state-dir.ts # terminalStateDir gate (none for print/json) + per-monitor SENPI_MONITOR_STATE_DIR
├── terminal-state-gc.ts # Bounded sweep of dead/reused leases and empty manifests
├── durable-file.ts      # `checkpointed-file` handler: compare saved checkpoint once, report
│                         at most one detached created/replaced/modified line
├── durable-command.ts   # `restartable-command` handler: reap orphan, re-spawn once with the restore env,
│                         2s grace window -> lost / completed / restored (+ one injected line)
├── prompt.ts            # Tool prompt guidance
└── tools/               # bash.ts (420 LOC), bash-output/input/resize, kill-bash, monitor,
                         # spawn, render, context, foreground-detach/window, sleep-wait
```

## WHERE TO LOOK

| Task | File |
|---|---|
| Change PTY spawn/exec behavior | `tools/bash.ts`, `tools/spawn.ts` |
| Change auto-detach window (~60s foreground) | `tools/foreground-detach.ts`, `tools/foreground-window.ts` |
| Add/change a monitor condition | `tools/monitor.ts` + `monitor-registry.ts` |
| Change how monitor wakes the session | `monitor-notify.ts` |
| Change footer terminal status | `monitor-status.ts`, `monitor-status-ticker.ts` |
| Change defaults (size, scrollback, caps) | `shared.ts` |
| Survive an extension reload | `session-bundle.ts` |
| Survive a full restart (what is persisted) | `terminal-manifest.ts` |
| Change restore classification or the digest | `restore.ts` |
| Change how a durable class comes back | `durable-file.ts`, `durable-command.ts` |
| Change single-live-process ownership | `manifest-lease.ts`, `lease-keeper.ts`, `process-identity.ts` |
| Change what a restored command may kill | `orphan-reaper.ts` |
| Change the restore message or its delivery | `restore-digest.ts`, `restore-session.ts` |
| Change the monitor env contract (`SENPI_MONITOR_*`) | `tools/monitor.ts`, `monitor-state-dir.ts`, `durable-command.ts` |

## CONVENTIONS

- **Monitor is the wait mechanism.** Observable state changes are delivered as events that wake the session; `bash_output` is for peeking, not waiting.
- **Companion tools stay active together** with `bash` and are synchronized with extension lifecycle and session-reload bundles — a companion tool without a live PTY is a bug.
- Tool output is capped at 2,000 lines / 50 KiB and sanitized before it reaches the model; monitor status refreshes on a 1-second unref'd interval.
- TypeBox schemas are **flat root objects, never root unions** (`tools/monitor.ts` is the reference) — several provider conversions rebuild schemas from top-level `properties` and a root `anyOf` arrives empty.
- Environment overrides are injected for tests rather than mutating `process.env`.
- Cross-extension seam: `monitor-state-event.ts` (parent dir) carries `TerminalMonitorStateEvent`, consumed by `goal/`.
- **`persistent` means durable, not merely long-lived.** `persistent: true` is the standing-watch switch: no deadline, and the entry is persisted in a durability class (`restartable-command` for `command`, `checkpointed-file` for `path`) that a restart brings back. Without it the entry is `ephemeral` and dies with the process — so any new durability behavior belongs behind that one flag, never behind a new parameter or action.
- **ONE digest per restart.** `restoreTerminalState` returns per-monitor results; `restore-digest.ts` turns them into exactly one `senpi-terminal:restore-digest` message per generation, held in a slot until a model is bound. Never notify per monitor: a session with five durable watches must still wake once.
- **A lease is identity, not a heartbeat.** The holder is pid + boot instant + process start instant + a per-generation token. A pid alone never proves a live holder; a start-instant mismatch is pid reuse and is reclaimed. No timer keeps a lease alive.
- **A restored command counts only after the grace window.** `durable-command.ts` waits `RESTORE_GRACE_MS` before calling a re-spawn `restored`; an earlier non-zero exit is `lost` with the exit code and first output line, a zero exit is `completed`.
- **Never kill an unconfirmed pid.** `orphan-reaper.ts` kills only when boot, start instant and a content marker (`SENPI_MONITOR_ID`) all match; unverifiable is reported and left running, and win32 never kills.
- **Write on transition only.** `TerminalManifestWriter` persists lifecycle transitions (register, settle, pause/resume, background start/exit, shutdown) plus debounced checkpoints — never per output line, never a runtime handle. `adoptRestored` deliberately does not write; the restored entry reaches disk on the next real transition.
- **`pause`/`resume`/`rearm` resolve RUNTIME ids only.** `MonitorRegistry` keys records by `bash_N`/`watch_N`, so handing it a stable `mon_` id silently no-ops. A restore must re-apply a persisted mute with the FRESH runtime id it just allocated (`reapplyPersistedMute`); resolve a caller-supplied id through `resolveTerminalId` first.

## ANTI-PATTERNS

- Using `tmux` for long-running/interactive work through terminal `bash` — the PTY session is the mechanism.
- Polling with `sleep`, foreground wait loops, or repeated `bash_output` while waiting on observable state.
- Letting a companion tool dangle without a live PTY `bash`, or letting an output observer interfere with session ingest.
- Assuming the injected `timeout` kills a background session — it never does; use `kill_bash`.

## NOTES

- `changes.md` records `wait_for`, `block`, and `timeout` as **deprecated ghost schema parameters**: still accepted for compatibility, but not the current control model. Do not build new behavior on them.
- The default bash timeout itself is owned by `builtin/bash-timeout/`, not here; terminal consumes the resolved value.
