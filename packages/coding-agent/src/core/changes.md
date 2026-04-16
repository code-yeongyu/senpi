# changes

## builtin extension labels

- Changed `src/core/extensions/builtin/index.ts` and `src/core/resource-loader.ts` so builtin extensions keep stable synthetic ids like `<builtin:todowrite>` instead of being loaded as numbered inline factories.
- This was changed in core because the startup Extensions list is sourced from extension metadata produced by `DefaultResourceLoader`; the extension API cannot rename builtin factory identities after load.
- Expected merge-conflict zone on upstream sync: builtin extension registration in `src/core/extensions/builtin/index.ts` and builtin factory loading in `src/core/resource-loader.ts`.

## move selected defaults to global extensions

- Changed `src/core/extensions/builtin/index.ts` and `src/core/resource-loader.ts` so `diff`, `files`, `prompt-url-widget`, and `tps` are no longer registered as builtin factories.
- `DefaultResourceLoader` now seeds generated shim files for those four defaults into the real global `agentDir/extensions/` directory, so they load through normal global extension discovery instead of builtin registration.
- This had to be done in core because builtin-vs-global extension ownership is determined during resource bootstrap, before any extension code runs.
- Expected merge-conflict zone on upstream sync: builtin extension registration and early resource bootstrap in `src/core/resource-loader.ts`.

## disable builtin extensions from settings

- Changed `src/core/settings-manager.ts` and `src/core/resource-loader.ts` so `settings.json` can disable selected builtin extensions with `disabledBuiltinExtensions`.
- `DefaultResourceLoader` now skips builtin factories whose ids are listed in settings (for example `"background-task"` to hide the `task` tool and related background-task builtins).
- This had to be done in core because builtin extensions are instantiated during early resource bootstrap, before project extensions can intercept or unregister them.
- Expected merge-conflict zone on upstream sync: settings schema/getters in `src/core/settings-manager.ts` and builtin factory loading in `src/core/resource-loader.ts`.

## exclude background-task reminders from compaction context

- Changed `src/core/messages.ts`, `src/core/compaction/compaction.ts`, `src/core/compaction/branch-summarization.ts`, and `src/core/agent-session.ts` so builtin `background-task.complete` system reminders are excluded from LLM context, summary generation, compaction boundary calculation, and token estimation.
- This was changed in core because the reminders are injected as `custom_message` session entries before compaction/branch summarization runs, so an extension cannot reliably strip them from every internal context-building path.
- Expected merge-conflict zone on upstream sync: custom-message conversion in `src/core/messages.ts`, entry-to-message/boundary filtering in `src/core/compaction/*.ts`, and context usage estimation in `src/core/agent-session.ts`.

## steering default mode to all

- Changed `src/core/settings-manager.ts` so `getSteeringMode()` now defaults to `"all"` instead of `"one-at-a-time"` when no explicit setting is present.
- Added `test/settings-manager.test.ts` coverage to lock the new default behavior.
- This was changed in core because the default steering mode is injected into `Agent` during session creation via `SettingsManager`, so an extension cannot change the built-in default before the session runtime is constructed.
- Expected merge-conflict zone on upstream sync: `src/core/settings-manager.ts` default getter behavior.

## builtin openai service tier setting

- Changed `src/core/settings-manager.ts`, `src/core/extensions/builtin/index.ts`, and added `src/core/extensions/builtin/service-tier.ts` so `settings.json` can set `openai.serviceTier` and automatically inject `service_tier` into OpenAI Responses payloads.
- Added test coverage in `test/suite/service-tier-extension.test.ts`, `test/suite/service-tier-settings.test.ts`, and updated builtin extension registration coverage in `test/resource-loader.test.ts`.
- This was changed in core because builtin extension registration and settings schema/getter wiring happen before extension code can discover a new builtin id or read typed settings from the existing settings manager.
- Expected merge-conflict zone on upstream sync: builtin extension registration in `src/core/extensions/builtin/index.ts` and settings schema/getter additions in `src/core/settings-manager.ts`.

## Anthropic "max" thinking level and provider/model extraBody config

- Widened the `"max"` thinking level through the coding agent surface: CLI `--thinking max`, `/settings` selector, Shift+Tab cycle, `settings.json` `defaultThinkingLevel`, thinking border color mapping.
- Extended `packages/coding-agent/src/core/model-registry.ts` so `models.json` (and `pi.registerProvider()`) accepts `extraBody` at both provider and per-model level. `getApiKeyAndHeaders` now resolves `extraBody`, and `sdk.ts` merges provider/model extraBody with any call-site `extraBody` before invoking `streamSimple`.
- This had to be done in core because `ThinkingLevel` is exported from `@mariozechner/pi-agent-core` and every UI/CLI/settings surface needed to be widened, and because `getApiKeyAndHeaders` + stream option composition live in core `ModelRegistry`/`sdk.ts`.
- Expected merge-conflict zone on upstream sync: `model-registry.ts` schemas + `getApiKeyAndHeaders`, `sdk.ts` stream option composition, `cli/args.ts` validator, `settings-manager.ts` thinking level type, `agent-session.ts` thinking cycle list, interactive TUI thinking selector and border color map.
