# modes/interactive/theme

## OVERVIEW
Shared theme-runtime domain (score 8): schema-backed colors, cross-loader theme identity, terminal detection, and interactive auto switching.

## WHERE TO LOOK

| Task | File |
|---|---|
| Theme schema, colors, loaders, adapters | `theme.ts` |
| Persisted selection, preview, auto-sync | `theme-controller.ts` |
| External JSON validation contract | `theme-schema.json` |
| Builtin palettes | `dark.json`, `light.json`, `grok-day.json`, `grok-night.json` |
| Grok token consumer | `../grok/chrome-tokens.ts` |

## CONVENTIONS

- The exported `theme` is a proxy over a `globalThis` symbol, allowing tsx and jiti module instances to share the active theme.
- Updates set both current and legacy symbol keys; a loader-local singleton is not equivalent.
- The proxy throws before initialization; initialize through `initTheme` before rendering consumers.
- Invalid theme loading falls back to dark; `setTheme` reports failure to callers while retaining that usable fallback.
- Automatic light/dark selection reserves `/` in setting syntax, so individual theme names cannot contain `/`.
- Auto detection prioritizes terminal color-scheme reporting and concurrently starts background-color fallback detection.
- `InteractiveThemeController` owns terminal color-scheme subscriptions and rebinds them when the TUI changes.
- Explicit single-theme selection disables auto-sync; preview resolves a candidate without committing the selection.
- Syntax highlighting validates language names before invoking `cli-highlight` to avoid stderr noise.
- Derived highlight themes and file-watch state are cached separately from the public proxy.

## ANTI-PATTERNS

- Replacing the shared global-symbol lookup with a module-local active-theme variable.
- Persisting a low-confidence environment guess as if it were a detected terminal preference.
- Allowing slash-containing names that collide with automatic theme-pair settings.
- Leaving an old terminal color-scheme listener attached after rebinding the TUI.
- Calling the highlighter with an unvalidated language identifier.
