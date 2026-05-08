# changes

## non-blocking startup tool discovery

- Changed `src/modes/interactive/interactive-mode.ts` so interactive startup only probes an already-installed `fd` path for autocomplete instead of awaiting `fd`/`rg` downloads before showing the UI.
- Added `src/modes/interactive/startup-tools.ts` to keep the startup-only tool resolution behavior small and directly testable.
- This was changed in core UI because the blocking call happens inside `InteractiveMode.init()` before extension startup hooks can run, so a builtin extension cannot prevent the first-launch wait.
- Expected merge-conflict zone on upstream sync: tool setup in `InteractiveMode.init()` near the startup changelog/header initialization.

## favorite model cycling

- Changed `src/modes/interactive/interactive-mode.ts` so Ctrl+P reports missing favorite models instead of cycling through every available model, and `/favorite-models` saves selections to the new `favoriteModels` settings field.
- This was changed in core UI because the built-in status text and favorite-model selector wiring are internal `InteractiveMode` behavior; extensions cannot replace the default Ctrl+P command semantics without racing the built-in binding.
- Expected merge-conflict zone on upstream sync: model cycling status and `/favorite-models` selector wiring in `src/modes/interactive/interactive-mode.ts`.

## builtin extension display paths

- Changed `src/modes/interactive/interactive-mode.ts` so synthetic builtin extension ids render as `builtin/<name>` in the startup Extensions section.
- Changed `src/modes/interactive/interactive-mode.ts` so builtin extensions render in their own `builtin` group and `todowrite` is labeled as `todo` in the startup Extensions section.
- This was changed in core UI because the display formatting lives in `InteractiveMode.formatDisplayPath()`; the extension system cannot intercept that built-in startup formatter.
- Expected merge-conflict zone on upstream sync: `showLoadedResources()` helpers in `src/modes/interactive/interactive-mode.ts`.

## disable startup update checks

- Changed `src/modes/interactive/interactive-mode.ts` so startup no longer checks upstream npm registry version/package updates before entering the interactive loop.
- This was changed in core UI because those startup checks are internal `InteractiveMode` methods and there is no extension hook that can reliably suppress them before they run.
- Expected merge-conflict zone on upstream sync: startup helpers around `checkForNewVersion()` and `checkForPackageUpdates()` in `src/modes/interactive/interactive-mode.ts`.
