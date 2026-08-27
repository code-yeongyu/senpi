# builtin/terminal

Builtin extension #18. Replaces one-shot bash with a **PTY-backed persistent session** model: `bash` plus companion tools `bash_output`, `bash_input`, `bash_resize`, `kill_bash`, and `monitor`. Registered after `bash-timeout` (so the resolved default timeout reaches PTY bash) and after `anthropic-bash` (so a native Anthropic bash tool makes terminal step aside).

## FILES

```
terminal/
├── index.ts             # Barrel: extension + settings + tool-name constants + shared key/regex helpers
├── extension.ts         # Registration entry — registers all six tools, wires lifecycle + reload bundles
├── manager.ts           # TerminalManager: session map ownership
├── runtime-session.ts   # TerminalRuntimeSession: one live PTY
├── session-bundle.ts    # TerminalSessionBundle: reload parking/claiming across extension generations
├── monitor-registry.ts  # MonitorRegistry: registered watches over session output
├── monitor-notify.ts    # Event → notification delivery (283 LOC, largest non-tool file)
├── monitor-status*.ts   # Footer status text + 1s unref'd ticker
├── notify.ts            # TerminalNotifier
├── output-format.ts     # Output shaping/sanitization
├── settings.ts          # loadTerminalSettings / resolveTerminalSettings
├── shared.ts            # Defaults: 120x40, 10000 scrollback, 32 sessions, 1,000,000 output chars
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

## CONVENTIONS

- **Monitor is the wait mechanism.** Observable state changes are delivered as events that wake the session; `bash_output` is for peeking, not waiting.
- **Companion tools stay active together** with `bash` and are synchronized with extension lifecycle and session-reload bundles — a companion tool without a live PTY is a bug.
- Tool output is capped at 2,000 lines / 50 KiB and sanitized before it reaches the model; monitor status refreshes on a 1-second unref'd interval.
- TypeBox schemas are **flat root objects, never root unions** (`tools/monitor.ts` is the reference) — several provider conversions rebuild schemas from top-level `properties` and a root `anyOf` arrives empty.
- Environment overrides are injected for tests rather than mutating `process.env`.
- Cross-extension seam: `monitor-state-event.ts` (parent dir) carries `TerminalMonitorStateEvent`, consumed by `goal/`.

## ANTI-PATTERNS

- Using `tmux` for long-running/interactive work through terminal `bash` — the PTY session is the mechanism.
- Polling with `sleep`, foreground wait loops, or repeated `bash_output` while waiting on observable state.
- Letting a companion tool dangle without a live PTY `bash`, or letting an output observer interfere with session ingest.
- Assuming the injected `timeout` kills a background session — it never does; use `kill_bash`.

## NOTES

- `changes.md` records `wait_for`, `block`, and `timeout` as **deprecated ghost schema parameters**: still accepted for compatibility, but not the current control model. Do not build new behavior on them.
- The default bash timeout itself is owned by `builtin/bash-timeout/`, not here; terminal consumes the resolved value.
