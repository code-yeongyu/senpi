# packages/tui/test

Score: 12 (80 executable/helper files, dense symbols/exports, >20 `VirtualTerminal` import references); distinct terminal-regression domain.

`node:test` suite asserting rendered escape sequences against a simulated terminal. Package test command is in `../AGENTS.md`; multiplexer bootstrap is local.

## WHERE TO LOOK

| Task | File |
|---|---|
| Terminal simulation helper | `virtual-terminal.ts` — `VirtualTerminal`: `write`/`resize`/`flush`/`getViewport`/`getScrollBuffer`/`waitForRender` |
| Shared themes | `test-themes.ts` — `defaultSelectListTheme`, `defaultMarkdownTheme`, `defaultEditorTheme` |
| Editor behavior | `editor.test.ts` (~4.4k LOC: autocomplete, history, Unicode, wrapping, markers, sticky columns) |
| Core render/diff, alt-screen, overlays | `tui-render.test.ts`, `tui-alt-screen.test.ts`, `overlay-non-capturing.test.ts` |
| Forbidden-regression guards | `external-stdout-guard.test.ts`, `cursor-write-hygiene.test.ts` |
| Component disposal vs reusable detach | `component-dispose.test.ts` |
| Select-row styling threaded through editor autocomplete | `select-list-render-row.test.ts`, `editor-render-row.test.ts` |
| Terminal detach, native lookup, restricted SIGWINCH, private diagnostic logs | `terminal-detach.test.ts`, `native-module-path.test.ts`, `regression-sigwinch-kill-eacces.test.ts`, `render-diagnostic-permissions.test.ts` |
| Tabs and public segmenter exports | `tab-width.test.ts`, `segmenter-exports.test.ts` |
| Perf harness | `perf-trend-local.test.ts`, `render-churn-bench.ts` (inspector profiles), `frame-cost-harness.test.ts` (validates the bench JSON) |
| Multiplexer environment | `setup-multiplexer-env.mjs` (imported globally by the test script) |

## CONVENTIONS

- Assert exact ANSI/OSC/APC bytes and viewport/scroll-buffer state via `VirtualTerminal` — never DOM or snapshot abstractions.
- Naming is behavior-oriented: `regression-*`, `*-characterization`, `*-contract`, `*-repro`.
- Filesystem autocomplete tests build isolated tmpdir trees and mock `fd` discovery; quoted paths, symlinks, hidden files, and `./` prefixes are explicit seams.
- Non-`*.test.ts` utilities stay outside the runner glob: `chat-simple.ts`, `image-test.ts`, `key-tester.ts`, `viewport-overwrite-repro.ts`, `render-churn-bench.ts`. `mux-scrollback-harness.ts` supplies shared fixtures, not a standalone demo.
- `stdin-buffer.test.ts` and `terminal-detach.test.ts` retain Node/Vitest compatibility; the package runner remains Node.
- Bootstrap clears `TMUX`, `TMUX_PANE`, `STY`, and `ZELLIJ`; mux tests opt in via injected detection or scoped environment changes.
- `flush()` acknowledges queued xterm writes, not a future scheduled TUI render. `waitForRender()` currently adds a fixed 20 ms sleep; it is legacy timing debt, not an event signal.

## ANTI-PATTERNS

- For async tests, subscribe to the exact render/event/state signal before triggering work and await it with a bounded timeout, then flush terminal writes as needed.
- Do not add fixed sleeps or rely on `waitForRender()` as deterministic synchronization. Existing timing debt in helpers and tests is not a pattern to extend.
- Do not relax byte-exact terminal assertions; characterization contracts pin cursor/clear/SGR/OSC sequences.
