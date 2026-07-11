# packages/coding-agent/src/modes/interactive

Interactive mode orchestrates the `senpi` TUI. `interactive-mode.ts` owns startup, session events, key dispatch, overlays, status, and command UI; `components/` owns rendering units.

## STRUCTURE

```text
interactive-mode.ts     Main lifecycle and event-to-UI coordinator
startup-tools.ts        Non-blocking fd/rg capability probe
working-status.ts       Animated working text/frames
session-info-format.ts  Session/cost/token summaries
components/             Messages, tools, footer, selectors, dialogs, editor
theme/                  JSON themes copied into builds
assets/                 Branding assets copied into builds
changes.md              Fork-specific interactive behavior
```

## WHERE TO LOOK

| Task | File |
|---|---|
| Startup and shutdown | `interactive-mode.ts` |
| Streaming assistant render | `components/assistant-message.ts` |
| Streaming tool render | `components/tool-execution.ts` |
| Working animation | `working-status.ts` and `interactive-mode.ts` |
| Footer/status | `components/footer.ts` |
| Model and favorites UI | selector components plus `interactive-mode.ts` |
| Theme behavior | `theme/` and `components/theme-selector.ts` |

## INVARIANTS

- Preserve memoization in high-frequency assistant/tool renderers; bypassing it causes flicker and excess redraws.
- Startup tool discovery remains non-blocking. Version and package-update checks start asynchronously after the first frame; never await them during startup.
- Preserve the animated Working row, elapsed time, active-tool label, and interrupt hint.
- All keys route through `../../core/keybindings.ts`; no inline key literals.
- Components return styled text through TUI helpers. Arbitrary ANSI styling/output escapes are forbidden; preserve only established terminal-protocol markers such as the OSC 133 zones in `components/assistant-message.ts`.
- Themes remain JSON assets and are copied by package build scripts; do not symlink them.
- Selectors resolve `Promise<T | null>` where `null` means canceled.

## ANTI-PATTERNS

- Recomputing complete message trees for every streaming delta.
- Blocking the first frame on tool downloads or update checks.
- Replacing the working animation with a static indicator.
- Writing directly to stdout from components.
- Adding UI behavior without width, theme, and cancellation states.

## VALIDATION

- Run focused component/interactive tests from `packages/coding-agent`.
- Run `packages/tui/test/tui-render.test.ts` when render frequency or memoization changes.
- Every UI change requires root `npm run check`, `senpi-qa` TUI smoke evidence, and visual inspection across relevant terminal sizes.
- Record fork-visible changes in `changes.md` and preserve them during upstream merges.
