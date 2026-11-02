# packages/tui/test

Score: 23 (77 files; `VirtualTerminal` imported by 65 of them).

`node:test` suite asserting rendered escape sequences against a simulated terminal. Test command and multiplexer setup are in `../../AGENTS.md`.

## WHERE TO LOOK

| Task | File |
|---|---|
| Terminal simulation helper | `virtual-terminal.ts` — `VirtualTerminal`: `write`/`resize`/`flush`/`getViewport`/`getScrollBuffer`/`waitForRender` |
| Shared themes | `test-themes.ts` — `defaultSelectListTheme`, `defaultMarkdownTheme`, `defaultEditorTheme` |
| Editor behavior | `editor.test.ts` (~4.4k LOC, 219 cases: autocomplete, history, Unicode, wrapping, markers, sticky columns) |
| Core render/diff, alt-screen, overlays | `tui-render.test.ts`, `tui-alt-screen.test.ts`, `overlay-non-capturing.test.ts` |
| Forbidden-regression guards | `external-stdout-guard.test.ts`, `cursor-write-hygiene.test.ts` |
| Perf harness | `perf-trend-local.test.ts`, `render-churn-bench.ts` (inspector profiles), `frame-cost-harness.test.ts` (validates the bench JSON) |
| Multiplexer environment | `setup-multiplexer-env.mjs` (imported globally by the test script) |

## CONVENTIONS

- Assert exact ANSI/OSC/APC bytes and viewport/scroll-buffer state via `VirtualTerminal` — never DOM or snapshot abstractions.
- Naming is behavior-oriented: `regression-*`, `*-characterization`, `*-contract`, `*-repro`.
- Filesystem autocomplete tests build isolated tmpdir trees and mock `fd` discovery; quoted paths, symlinks, hidden files, and `./` prefixes are explicit seams.
- Non-`*.test.ts` files are runnable utilities outside the runner glob: `chat-simple.ts`, `image-test.ts`, `key-tester.ts`, `mux-scrollback-harness.ts`, `viewport-overwrite-repro.ts`, `render-churn-bench.ts`.
- `stdin-buffer.test.ts` deliberately supports both `node:test` and Vitest APIs through a compat wrapper.

## ANTI-PATTERNS

- New tests synchronize on render/event signals (`waitForRender`, flush) — never fixed `setTimeout` sleeps. Legacy sleeps in `loader.test.ts`, `layout.test.ts`, `editor.test.ts`, `chat-simple.ts` must not be extended.
- Do not relax byte-exact terminal assertions; characterization contracts pin cursor/clear/SGR/OSC sequences.
