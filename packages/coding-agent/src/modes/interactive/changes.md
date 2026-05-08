# changes

## favorite model cycling

- Changed `src/modes/interactive/interactive-mode.ts` so Ctrl+P reports missing favorite models instead of cycling through every available model, and `/scoped-models` saves selections to the new `favoriteModels` settings field.
- This was changed in core UI because the built-in status text and model-scope selector wiring are internal `InteractiveMode` behavior; extensions cannot replace the default Ctrl+P command semantics without racing the built-in binding.
- Expected merge-conflict zone on upstream sync: model cycling status and `/scoped-models` selector wiring in `src/modes/interactive/interactive-mode.ts`.

## builtin extension display paths

- Changed `src/modes/interactive/interactive-mode.ts` so synthetic builtin extension ids render as `builtin/<name>` in the startup Extensions section.
- Changed `src/modes/interactive/interactive-mode.ts` so builtin extensions render in their own `builtin` group and `todowrite` is labeled as `todo` in the startup Extensions section.
- This was changed in core UI because the display formatting lives in `InteractiveMode.formatDisplayPath()`; the extension system cannot intercept that built-in startup formatter.
- Expected merge-conflict zone on upstream sync: `showLoadedResources()` helpers in `src/modes/interactive/interactive-mode.ts`.

## disable startup update checks

- Changed `src/modes/interactive/interactive-mode.ts` so startup no longer checks upstream npm registry version/package updates before entering the interactive loop.
- This was changed in core UI because those startup checks are internal `InteractiveMode` methods and there is no extension hook that can reliably suppress them before they run.
- Expected merge-conflict zone on upstream sync: startup helpers around `checkForNewVersion()` and `checkForPackageUpdates()` in `src/modes/interactive/interactive-mode.ts`.
