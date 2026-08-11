# packages/tui

Commit: `4f26b8282` (2026-08-07)

`@earendil-works/pi-tui` is the standalone terminal renderer/editor library used by Senpi interactive mode. Rendering uses synchronized, differential frames and must preserve terminal ownership boundaries.

## STRUCTURE

```text
src/tui.ts                  TuiBase, Container, CURSOR_MARKER, ViewportTUI contract
src/TuiMainScreen.ts        Main-screen/scrollback TUI (thin TuiBase subclass)
src/TuiAltScreen.ts         Alt-screen TUI: layout frames, scroll routing, flash
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
src/stdin-buffer.ts         Paste/input framing
src/terminal-image.ts       Kitty/iTerm image paths
src/changes.md              Fork render behavior
test/*.test.ts              Node test-runner coverage
bench/frame-cost.ts         Frame cost benchmark (see test/frame-cost-harness.test.ts)
```

Root `tui-plan.md` is the design doc for the alternate-screen layout system (landed 2026-07-31).

Public exports include `VStack`, `HStack`, `ScrollView`, `Spacer`, `TuiAltScreen`, `TuiMainScreen`, `Container`, `CURSOR_MARKER`, `isViewportTUI`, and `ViewportTUI` (see `src/index.ts`).

## RENDERING CONTRACT

- Balanced synchronized-output and autowrap frame guards are mandatory on every render path.
- Stable-width streaming updates must remain differential and must not introduce clear-screen operations.
- Resize, recovery, scrollback replay, multiplexer, and image branches may legitimately repaint or clear when their contracts require it.
- `start()` and `stop()` reset queued render state so stale scheduled frames cannot leak across lifecycles.
- `ProcessTerminal` owns external stdout while running; components must not write around it.
- Terminal title output strips control characters.
- Visible tabs are normalized to a fixed three-column width at the terminal-output boundary; ANSI/OSC/APC escape sequences are untouched (`test/tab-width.test.ts`).
- High-frequency consumer components are responsible for memoization; preserve the Senpi streaming caches.

## WHERE TO LOOK

| Task | File |
|---|---|
| Flicker, cursor, viewport | `src/tui.ts` |
| Alt-screen rendering, scroll wheel/keys routing | `src/TuiAltScreen.ts` |
| Layout rects, clipping, scrollbar geometry | `src/layout.ts`, `src/layout-node.ts` |
| Stack sizing, scrollable regions | `src/components/stack.ts`, `src/components/scroll-view.ts` |
| Viewport contract checks | `src/tui.ts` (`isViewportTUI`, `VIEWPORT_TUI`) |
| Terminal lifecycle/title | `src/terminal.ts` |
| Child process terminal | `src/terminal.ts` (`ProcessTerminal`) |
| Key parsing/defaults | `src/keys.ts`, `src/keybindings.ts` |
| Paste handling | `src/stdin-buffer.ts` |
| Width/wrapping | `src/utils.ts` |
| Terminal-output normalization/tab width | `src/utils.ts` (`normalizeTerminalOutput`, `visibleWidth`) and `src/tui.ts` |
| Images | `src/terminal-image.ts` |

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
