# packages/tui/src/components

Score: 9 (18 TypeScript files, >30 symbols, >10 exports, >20 `Editor` constructor uses); distinct component-library domain.

Terminal component library: text, markdown, editor, selectors, stacks, images, loaders. Rendering contract and terminal-ownership rules live in `../../AGENTS.md`; width primitives in `../utils.ts`.

## WHERE TO LOOK

| Task | File |
|---|---|
| Multiline editor: markers, history, undo, autocomplete, wrapping | `editor.ts` — dominant hotspot (~2.6k LOC) |
| Markdown rendering, highlighting, tables, LaTeX | `markdown.ts`, `latex.ts` |
| Single-line input | `input.ts` |
| Select/settings lists and optional row composition | `select-list.ts` (`SelectListTheme.renderRow`), `settings-list.ts` |
| Scrollable regions | `scroll-view.ts` |
| Size allocation shared by both stack directions | `stack.ts` (`allocateStackSizes`) |
| Layout wrappers | `v-stack.ts`, `h-stack.ts`, `spacer.ts` |
| Images, boxes, loaders | `image.ts`, `box.ts`, `loader.ts`, `cancellable-loader.ts` |
| Alt-screen flash overlay | `alt-screen-flash.ts` |

## CONVENTIONS

- Components live in individual files with no local barrel; package-facing re-exports are assembled in `../index.ts`.
- `EditorTheme.selectList` passes its optional `renderRow` composer into autocomplete lists; without it, `SelectList` preserves legacy row bytes.
- Stack sizing uses basis/grow/shrink/min/max plus `visible` flags; `VStack` and `HStack` share `stack.ts` allocation.
- `ScrollView` owns scrolling and takes exactly one immutable child; invalid axis or child mutation throws (`scroll-view.ts`).
- `Editor` keeps a wrapped-line cache; `Markdown` keeps bounded render/highlight caches. Preserve these component-specific caches.
- Editor autocomplete serializes requests, passes abort signals, and checks request identity plus text/cursor snapshots before applying suggestions.

## ANTI-PATTERNS

- Mutating or removing a `ScrollView` child after construction.
- Applying stale autocomplete results after the text, cursor, or request has changed.
- Unbounded Markdown caches or bypassing invalidation when render inputs change.
