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
├── monitor-registry.ts  # Aggregate command/native monitor lifecycle, capacity, snapshots
├── monitor-types.ts     # Shared command-monitor event, snapshot, and registration types
├── file-monitor-registry.ts # Native watch_N facade + aggregate lifecycle ownership
├── file-monitor-{legacy,secure}.ts # Injectable legacy and anchored-worker backends
├── file-monitor-{runtime,types,cleanup}.ts # Fingerprints, contracts, and cleanup helpers
├── secure-file-monitor-worker*.ts # Pooled cwd-anchored fs.watch/stat worker and NDJSON protocol
├── monitor-notify.ts    # Event → notification delivery and wake-budget handling
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
| Add/change a command monitor | `tools/monitor.ts` + `monitor-registry.ts` |
| Add/change a native file monitor | `tools/monitor.ts` + `file-monitor-{registry,legacy,secure}.ts` + `secure-file-monitor-worker*.ts` |
| Change how monitor wakes the session | `monitor-notify.ts` |
| Change footer terminal status | `monitor-status.ts`, `monitor-status-ticker.ts` |
| Change defaults (size, scrollback, caps) | `shared.ts` |
| Survive an extension reload | `session-bundle.ts` |

## CONVENTIONS

- **Monitor is the wait mechanism.** Observable state changes are delivered as events that wake the session; `bash_output` is for peeking, not waiting.
- **Companion tools share one lifecycle bundle.** PTY commands and native `watch_N` file monitors survive reload through `session-bundle.ts`; native watches do not require a live PTY but do require the bundle-owned `MonitorRegistry`.
- Native file monitors bind both the requested logical parent and its approved canonical directory identity. Production target inspection runs basename-only inside a pooled child whose retained `cwd` is bigint-identity checked before activation; every outcome also revalidates the logical binding before publication.
- Source-Bun sessions launch the fixed worker source with the repository-required Node runtime, not Bun, so a watched directory's `bunfig.toml` cannot inject preloads; standalone Bun executables re-enter only the hidden worker route.
- Parked monitor output bounds line noise without evicting completion summaries, and buffers background exits up to the configured terminal capacity.
- Tool output is capped at 2,000 lines / 50 KiB and sanitized before it reaches the model; monitor status refreshes on a 1-second unref'd interval.
- TypeBox schemas are **flat root objects, never root unions** (`tools/monitor.ts` is the reference) — several provider conversions rebuild schemas from top-level `properties` and a root `anyOf` arrives empty.
- Environment overrides are injected for tests rather than mutating `process.env`.
- Cross-extension seam: `monitor-state-event.ts` (parent dir) carries `TerminalMonitorStateEvent`, consumed by `goal/`.

## ANTI-PATTERNS

- Using `tmux` for long-running/interactive work through terminal `bash` — the PTY session is the mechanism.
- Polling with `sleep`, foreground wait loops, or repeated `bash_output` while waiting on observable state.
- Letting a command monitor's PTY dangle, or letting an output observer interfere with session ingest. Native `watch_N` monitors intentionally have no PTY.
- Assuming the injected `timeout` kills a background session — it never does; use `kill_bash`.

## NOTES

- Historical `wait_for`, `block`, and per-tool ghost `timeout` parameters were removed from companion schemas. Unknown keys may pass provider validation, but terminal tools ignore them; current calls must use the documented fields.
- The default bash timeout itself is owned by `builtin/bash-timeout/`, not here; terminal consumes the resolved value.
