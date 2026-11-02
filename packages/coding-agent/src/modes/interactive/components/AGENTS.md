# packages/coding-agent/src/modes/interactive/components

Rendering units for the TUI: message renderers, selectors/dialogs, tool surfaces, layout helpers. 56 flat `.ts` files (~11.6k LOC), no subdirectories. `interactive-mode.ts` (parent dir) drives them; these files never own lifecycle.

## HOTSPOTS

| File | LOC | Owns |
|---|---|---|
| `tree-selector.ts` | 1434 | `TreeList` + `TreeSelectorComponent`: tree flattening, gutters, active-path, folding, filtering, horizontal viewport, copy/text extraction, label editing |
| `session-selector.ts` | 1031 | Session tree build/flatten, search/sort/name filtering, loading progress, delete/rename flows |
| `config-selector.ts` | 942 | Config browse/edit surface |
| `settings-selector.ts` | 917 | Settings browse/mutate surface |
| `model-selector.ts` | 459 | Model picker; favorites/search split into helper modules |

Cross-cutting fan-in: `DynamicBorder`, `theme`, and `keybinding-hints` are imported by nearly every selector/renderer — a change there reaches most dialogs. Tool rendering is split across `tool-execution.ts` plus renderer/types/images/fallback/boundary modules and is a second coupled cluster.

## WHERE TO LOOK

| Task | File |
|---|---|
| Assistant streaming render | `assistant-message.ts` (+ `createAssistantRenderDescriptors`) |
| Tool call/result render | `tool-execution.ts`, `tool-execution-renderer.ts`, `tool-execution-images.ts`, fallback/boundary modules |
| Footer/status segments | `footer.ts` (format + layout planning) |
| Diff rendering in messages | `diff.ts` (`renderDiff`, intra-line helpers) |
| Markdown/mermaid transforms | `createMarkdownTransform`, `createMermaidMarkdownTransformer` |
| Border chrome | `dynamic-border.ts` |
| Key label text | `keybinding-hints.ts` (`keyText`, `keyDisplayText`, `keyHint`) |
| Public component surface for extensions | `index.ts` (barrel, 33 re-exports) |

## CONVENTIONS

- Components extend `@earendil-works/pi-tui` primitives (`Container`, `Box`, `Loader`, `Editor`, `Component`, `Focusable`) and compose explicit rows/strings styled through `theme`.
- Selectors are callback-driven: `onSelect`/`onCancel` plus mutation/error callbacks, mutable component state, explicit `invalidate()`/`render()`, and configurable `getKeybindings()`.
- Layout is width-aware everywhere: `visibleWidth`, `truncateToWidth`, visual-line truncation, footer planning, bounded render signatures, explicit viewport/anchor math.
- `ProgressiveTranscriptContainer` hydrates only visible/tail content incrementally; input handling must never block during hydration and the progressive watermark never moves backward.
- Border color is always passed explicitly — jiti creates a separate module cache, so an implicit default resolves to the wrong theme instance.
- The barrel re-exports only the public UI classes; many helpers stay direct-file APIs by design.

## ANTI-PATTERNS

- Recomputing complete message trees per streaming delta — memoization in the assistant/tool renderers is load-bearing.
- Writing to stdout directly, or emitting arbitrary ANSI. Only established terminal-protocol markers (OSC 133 zones in `assistant-message.ts`) are allowed.
- Inline key literals instead of `../../core/keybindings.ts` routing.
- Adding a render path without width, theme, and cancellation states.
- Hiding the tree gutter/current leaf, or dropping required footer model/context segments during truncation.
