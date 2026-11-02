# packages/tui/src

Score: 34 (33 files, barrel at `index.ts`, highest reference centrality in the package).

Rendering engine, input/terminal protocol modules, and the fork-delta ledger. The package-level rendering contract and ownership rules live in `../AGENTS.md`; this file covers module-level operations.

## WHERE TO LOOK

| Task | File |
|---|---|
| Render scheduling, diffing, viewport remap, scrollback replay, Kitty-image invalidation | `tui.ts` (`TuiBase.doRender()` and frame-guard paths) |
| Key protocol parsing/matching (Kitty keyboard, legacy sequences, modifyOtherKeys) | `keys.ts` |
| Namespaced default bindings | `keybindings.ts` |
| Stdin framing, bracketed paste | `stdin-buffer.ts` |
| Kitty/iTerm2/tmux image paths | `terminal-image.ts`, `tmux-image-capability.ts`, `tmux-image-probe.ts` |
| Autocomplete provider contracts, `$`/`/` mixing | `autocomplete.ts` (`CombinedAutocompleteProvider`) |
| Image/paste marker registries, canonicalization | `image-markers.ts`, `paste-markers.ts` |
| Editor primitives shared with the component `Editor` | `kill-ring.ts`, `undo-stack.ts`, `word-navigation.ts` |
| Public API surface | `index.ts` — barrel; the coupling point for `coding-agent` and `senpi-codemode` |
| Fork render-behavior history | `changes.md` |

Public exports include `VStack`, `HStack`, `ScrollView`, `Spacer`, `TuiAltScreen`, `TuiMainScreen`, `Container`, `CURSOR_MARKER`, `isViewportTUI`, and `ViewportTUI`.

Design doc for the alternate-screen layout system (landed 2026-07-31): root `tui-plan.md`.

## CONVENTIONS

- Keybinding IDs are namespaced (`tui.editor.*`, `tui.input.*`, `tui.select.*`, `tui.altScreen.*`) and centrally managed via `KeybindingsManager`; components consume them, never define them.
- Markers (paste, image) are atomic, registry-backed, and canonicalized/renumbered on every mutation; they transfer through the paired optional state APIs.
- Terminal protocols are modeled explicitly: Kitty keyboard, legacy sequences, modifyOtherKeys level detection, tmux focus/passthrough, OSC color queries (`terminal-capabilities.ts`, `native-modifiers.ts`, `tmux-focus.ts`).
- Native capabilities load lazily and degrade to `undefined`; never a hard dependency.
- All width/wrap/segment math goes through `utils.ts` primitives (`visibleWidth`, `wrapTextWithAnsi`, `sliceByColumn`, `extractSegments`) — never hand-rolled string slicing.
- `utils.ts` uses a bounded/rotating width cache and a pooled ANSI style tracker; `__widthCacheStats()` exposes cache diagnostics for tests.

## ANTI-PATTERNS

- Empty autocomplete text must not trigger file suggestions; only forced Tab completion does (`autocomplete.ts`).
- Render containment must not implicitly steal or clear focus ownership (`tui.ts`).
- A pending visibility change that has not rendered yet must not erase content (`tui.ts`).
