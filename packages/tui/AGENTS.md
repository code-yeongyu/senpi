# packages/tui

`@earendil-works/pi-tui` is the standalone terminal renderer/editor library used by Senpi interactive mode. Rendering uses synchronized, differential frames and must preserve terminal ownership boundaries.

## STRUCTURE

```text
src/tui.ts                  Render scheduler, viewport strategies, cursor state
src/terminal.ts             Terminal capabilities and lifecycle
src/editor-component.ts     Multiline editor primitive
src/components/             Text, markdown, loader, selectors, image components
src/keybindings.ts          Configurable default bindings
src/keys.ts                 Key parsing and matching
src/stdin-buffer.ts         Paste/input framing
src/terminal-image.ts       Kitty/iTerm image paths
src/changes.md              Fork render behavior
test/*.test.ts              Node test-runner coverage
```

## RENDERING CONTRACT

- Balanced synchronized-output and autowrap frame guards are mandatory on every render path.
- Stable-width streaming updates must remain differential and must not introduce clear-screen operations.
- Resize, recovery, scrollback replay, multiplexer, and image branches may legitimately repaint or clear when their contracts require it.
- `start()` and `stop()` reset queued render state so stale scheduled frames cannot leak across lifecycles.
- `ProcessTerminal` owns external stdout while running; components must not write around it.
- Terminal title output strips control characters.
- High-frequency consumer components are responsible for memoization; preserve the Senpi streaming caches.

## WHERE TO LOOK

| Task | File |
|---|---|
| Flicker, cursor, viewport | `src/tui.ts` |
| Terminal lifecycle/title | `src/terminal.ts` |
| Child process terminal | `src/terminal.ts` (`ProcessTerminal`) |
| Key parsing/defaults | `src/keys.ts`, `src/keybindings.ts` |
| Paste handling | `src/stdin-buffer.ts` |
| Width/wrapping | `src/utils.ts` |
| Images | `src/terminal-image.ts` |

## ANTI-PATTERNS

- Replacing differential rendering with unconditional full redraws.
- Unbalanced frame guards or cursor bookkeeping outside `tui.ts`.
- Direct `console.log` or `process.stdout.write` from components.
- Required native dependencies; optional native capabilities load lazily.
- Hardcoded application keybindings in library components.

## VALIDATION

- Tests use `node --test --import tsx`, not Vitest. Run `npm test` from this package.
- Rendering changes must include focused headless-terminal assertions and preserve flicker budgets.
- Runtime changes require root `npm run check`, `senpi-qa` TUI smoke evidence, and visual terminal QA.
- Read `src/changes.md` before altering renderer or loader behavior.
