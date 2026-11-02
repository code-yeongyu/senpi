# packages/tui/src/components

Score: 21 (18 files, >10 exports, high external reference centrality from `coding-agent` and `senpi-codemode`).

Terminal component library: text, markdown, editor, selectors, stacks, images, loaders. Rendering contract and terminal-ownership rules live in `../../AGENTS.md`; width primitives in `../utils.ts`.

## WHERE TO LOOK

| Task | File |
|---|---|
| Multiline editor: markers, history, undo, autocomplete, wrapping | `editor.ts` — dominant hotspot (~2.6k LOC) |
| Markdown rendering, highlighting, tables, LaTeX | `markdown.ts`, `latex.ts` |
| Single-line input | `input.ts` |
| Select/settings lists | `select-list.ts`, `settings-list.ts` |
| Scrollable regions | `scroll-view.ts` |
| Size allocation shared by both stack directions | `stack.ts` (`allocateStackSizes`) |
| Layout wrappers | `v-stack.ts`, `h-stack.ts`, `spacer.ts` |
| Images, boxes, loaders | `image.ts`, `box.ts`, `loader.ts`, `cancellable-loader.ts` |
| Alt-screen flash overlay | `alt-screen-flash.ts` |

## CONVENTIONS

- Components implement `Component.render(width)`-style text rendering; grapheme/CJK/emoji-aware width comes from `../utils.ts` (`Intl.Segmenter` + East Asian width), not local arithmetic.
- Stack sizing uses basis/grow/shrink/min/max plus `visible` flags; `VStack` and `HStack` share `stack.ts` allocation.
- `ScrollView` owns scrolling and takes exactly one immutable child; invalid axis or child mutation throws (`scroll-view.ts`).
- High-frequency components memoize aggressively: `Editor` and `Markdown` hold substantial render/highlight caches — preserve them.

## ANTI-PATTERNS

- Mutating or removing a `ScrollView` child after construction.
- Width math bypassing `../utils.ts`.
- Unbounded caches; the `utils.ts` width cache is bounded/rotating — follow that pattern.
