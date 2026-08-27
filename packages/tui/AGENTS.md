# packages/tui

Commit: `baf15a54d` (2026-08-24)

`@earendil-works/pi-tui` is the standalone terminal renderer/editor library used by Senpi interactive mode. Rendering uses synchronized, differential frames and must preserve terminal ownership boundaries.

## STRUCTURE

```text
src/tui.ts                  TuiBase, Container, CURSOR_MARKER, ViewportTUI contract
src/tui-main-screen.ts      Main-screen/scrollback TUI (thin TuiBase subclass)
src/tui-alt-screen.ts       Alt-screen TUI: layout frames, scroll routing, flash
src/layout.ts               Layout frame rendering, rects, clipping, scrollbar geometry
src/layout-node.ts          Per-component layout node attachment
src/terminal.ts             Terminal capabilities and lifecycle
src/editor-component.ts     Multiline editor primitive
src/components/             Text, markdown, loader, selectors, image components
src/components/stack.ts     Stack size allocation shared by v-stack/h-stack
src/components/v-stack.ts   VStack; h-stack.ts HStack; spacer.ts Spacer
src/components/scroll-view.ts  ScrollView with scrollbar options
src/keybindings.ts          Configurable default bindings
src/keys.ts                 Key parsing and matching
src/utils.ts                Width, wrapping, ANSI segmentation, output normalization
src/stdin-buffer.ts         Paste/input framing
src/terminal-image.ts       Kitty/iTerm image paths
src/dollar-invocation-autocomplete.ts  $-invocation suggestions for the editor
src/changes.md              Fork render behavior
test/*.test.ts              Node test-runner coverage
bench/                      frame-cost, editor-layout, markdown-render benchmarks
native/                     Optional Darwin/Win32 modifier binaries (prebuilt, lazy-loaded)
```

## RENDERING CONTRACT

- Balanced synchronized-output/autowrap frame guards on every render path; stable-width streaming updates stay differential with no clear-screen operations.
- Resize, recovery, scrollback replay, multiplexer, and image branches may legitimately repaint or clear when their contracts require it.
- `start()` and `stop()` reset queued render state so stale scheduled frames cannot leak across lifecycles.
- `ProcessTerminal` owns external stdout while running; components must not write around it.
- Terminal title output strips control characters.
- Visible tabs are normalized to a fixed three-column width at the terminal-output boundary; ANSI/OSC/APC escape sequences are untouched (`test/tab-width.test.ts`).
- High-frequency consumer components are responsible for memoization; preserve the Senpi streaming caches.

## WHERE TO LOOK

| Task | File |
|---|---|
| Flicker, cursor, viewport (`isViewportTUI`, `VIEWPORT_TUI`) | `src/tui.ts` |
| Alt-screen rendering, scroll wheel/keys routing | `src/tui-alt-screen.ts` |
| Layout rects, clipping, scrollbar geometry | `src/layout.ts`, `src/layout-node.ts` |
| Stack sizing, scrollable regions | `src/components/stack.ts`, `src/components/scroll-view.ts` |
| Terminal lifecycle/title, child process terminal | `src/terminal.ts` (`ProcessTerminal`) |
| Key parsing/defaults | `src/keys.ts`, `src/keybindings.ts` |
| Paste handling | `src/stdin-buffer.ts` |
| Width/wrapping, output normalization, tab width | `src/utils.ts` (`normalizeTerminalOutput`, `visibleWidth`) |
| Images | `src/terminal-image.ts` |
| $-invocation autocomplete | `src/dollar-invocation-autocomplete.ts`, `src/autocomplete.ts` (`CombinedAutocompleteProvider`) |

## $-INVOCATION

- A leading `$` on prompt line 0 offers the same candidate list as `/`: slash commands insert as `/name`, skills as bare `$name`.
- After one known skill, only further skills are offered. Mid-line `$` (e.g. `$HOME`) stays literal.
- Completion application must preserve trailing-space behavior for both `/command ` and `$skill ` forms.

## ANTI-PATTERNS

- Replacing differential rendering with unconditional full redraws.
- Unbalanced frame guards or cursor bookkeeping outside `tui.ts`.
- Direct `console.log` or `process.stdout.write` from components.
- Required native dependencies; optional native capabilities load lazily.
- Hardcoded application keybindings in library components.

## VALIDATION

- Tests use `node --test --import tsx`, not Vitest; the test script also imports `test/setup-multiplexer-env.mjs`. Run `npm test` from this package.
- Alt-screen/layout changes: see `test/tui-alt-screen.test.ts`, `test/layout.test.ts`, `test/viewport-render.test.ts`.
- Rendering changes must include focused headless-terminal assertions and preserve flicker budgets.
- Runtime changes require root `npm run check`, `senpi-qa` TUI smoke evidence, and visual terminal QA.
- Read `src/changes.md` before altering renderer or loader behavior.
- Native modifier binaries: `npm run build:native:darwin`; `npm run build:native:win32` (toolchain via `PI_TUI_WIN32_TOOLCHAIN=msvc|mingw`).
