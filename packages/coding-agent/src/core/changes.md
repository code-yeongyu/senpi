# changes

## Configured upstream model id and service tier (2026-05-09)

### What changed

- `src/core/model-registry.ts`: Custom `models.json` model entries can now set `upstreamModelId` and per-model `serviceTier`.
- `src/core/sdk.ts`: Provider requests use the configured upstream model id while preserving the configured catalog id for model selection.

### Why

- Users need both a normal catalog entry and a priority catalog entry, such as `gpt-5.5` and `gpt-5.5-fast`, while sending the upstream request as `model: "gpt-5.5"` with `service_tier: "priority"` for only the priority entry.

### Why extension system couldn't handle this

- The model id is embedded by the provider payload builder before `before_provider_request` hooks run, and `service_tier` is a provider-managed field. The registry has to carry the configured wire id and tier into the stream call before payload construction.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `model-registry.ts` schema/request-auth metadata and `sdk.ts` stream option composition.

## Generated default extension fast path (2026-05-08)

### What changed

- `src/core/resource-loader.ts`: Unchanged generated global default extension shims are now recognized by path and exact generated content, then resolved to the known in-process extension factory before the generic jiti loader runs.
- `src/core/resource-loader.ts`: User-edited or replacement files with the same default names still load through the normal extension import path.

### Why

- Clean-profile startup was spending several seconds loading deterministic generated shim files through jiti even though core already knows the matching default extension factories.

### Why extension system couldn't handle this

- Generated default shims are discovered and loaded by core resource bootstrap before extension code can run. Extensions cannot replace the loader's import strategy for their own files.

### Expected merge conflict zones on next upstream sync

- LOW: `resource-loader.ts` around generated global default extension path/content checks and the `loadExtensions()` call.

## Dist-backed default extension shims (2026-05-08)

### What changed

- `src/core/resource-loader.ts`: Default generated global extension shims now point at `dist` files when senpi itself is running from `dist`, even in a linked workspace that also has `src`.

### Why

- Linked CLI startup was re-transpiling default global extension TypeScript files through jiti before the first frame.

### Why extension system couldn't handle this

- Generated default global extension shims are created by core resource loading before extension code runs.

### Expected merge conflict zones on next upstream sync

- LOW: `resource-loader.ts` around `getGlobalDefaultExtensionModulePath()` and default shim generation.

## Model config controls (2026-05-08)

### What changed

- `src/core/model-registry.ts`: `models.json` can disable providers with top-level `disabledProviders` or per-provider `disabled`, filter provider models with `whitelist` / `blacklist`, and replace built-in thinking-level mappings with `thinkingLevelMapMode: "replace"`.
- `src/core/settings-manager.ts` and `src/core/sdk.ts`: added `favoriteModels` settings support and kept `enabledModels` as global model-catalog narrowing.
- `src/core/agent-session.ts`: reload refreshes the model registry, global model narrowing, and favorite models; Ctrl+P cycling only uses the configured favorite models, and available thinking levels honor model-level mapping overrides.

### Why

- The user requested opencode-style provider disable/filtering, favorite-model-only Ctrl+P cycling, and configurable replacement of reasoning variants with reload support.

### Why extension system couldn't handle this

- Model discovery, startup model resolution, persisted settings, and Ctrl+P cycling are core session/model-registry responsibilities. Extensions can add providers or shortcuts, but cannot reliably replace the built-in model registry, default catalog narrowing, or internal cycling semantics before the TUI starts.

### Expected merge conflict zones on next upstream sync

- HIGH: `model-registry.ts` schema/loading and model filtering.
- MEDIUM: `sdk.ts` startup model narrowing resolution and `agent-session.ts` reload/cycle paths.

### Migration notes

- `enabledModels` remains readable as global model narrowing, but Ctrl+P favorites are persisted through `favoriteModels`.

## Favorite model filter hardening (2026-05-11)

### What changed

- `src/core/agent-session.ts`: favorite models now act as a filter over the current available model list and current global narrowing before being exposed or cycled, so stale cached model objects cannot be selected after a provider/model leaves the registry.
- `src/core/model-resolver.ts`: slash-qualified glob patterns now match canonical `provider/model` ids only, preventing patterns like `openai/*` from also matching raw model ids such as `openai/gpt-*` under another provider.

### Why

- Favorite cycling should only choose models that are still present in the current model catalog. This matches opencode's validity filter behavior and avoids switching to stale favorites after provider/model changes.

### Why extension system couldn't handle this

- Favorite model resolution and Ctrl+P cycling are core `AgentSession` behavior, and glob pattern matching is shared by core startup/reload model resolution before extensions can safely override it.

### Expected merge conflict zones on next upstream sync

- `src/core/agent-session.ts` around favorite model getters and `cycleModel()`.
- `src/core/model-resolver.ts` around glob pattern matching in `resolveModelScope()`.

## Git package dependency repair on update (2026-05-02)

### What changed

- `src/core/package-manager.ts`: `updateGit()` now runs the package dependency install step even when the fetched git target already matches the local checkout.

### Why

- `senpi update` previously returned early for current git packages. If an extension checkout's `node_modules` was damaged or incomplete, the update command reported success but left runtime imports broken.

### Why extension system couldn't handle this

- Git package update and dependency installation are core package-manager responsibilities that run before extension loading.

### Expected merge conflict zones on next upstream sync

- LOW: `DefaultPackageManager.updateGit()` around the post-fetch current-HEAD branch.

## Model Switch System Prompt Change (2026-04-30)

### What changed

- `src/core/agent-session.ts`: Applies `model_select` system prompt results immediately, emits `system_prompt_change` only when the active prompt string changes, and returns the change from `setModel()` / `cycleModel()`.
- `src/core/extensions/types.ts`: Added typed `system_prompt_change` event and model-select prompt-change result.
- `src/core/extensions/runner.ts`: Added `emitModelSelect()` to collect prompt-change results from `model_select` handlers.
- `src/modes/interactive/interactive-mode.ts`: Includes the changed prompt name in model-switch status messages and shows standalone prompt-change status for extension-driven switches.
- `src/core/extensions/builtin/prompt-preset/index.ts`: Resolves prompt presets during `model_select` so mid-session model changes update the active prompt immediately.

### Why

- The prompt-preset builtin only changed the effective prompt at the next `before_agent_start`. The user requested mid-session model changes to switch the system prompt immediately, emit a `pi.on` event, and show the TUI notice only when the prompt actually changes.

### Why extension system couldn't handle this

- The existing extension event runner ignored `model_select` return values and had no core-owned typed event for active system prompt changes. TUI status also needs core session feedback from `setModel()` / `cycleModel()`.

### Expected merge conflict zones on next upstream sync

- HIGH: `agent-session.ts` around model switching and event emission.
- HIGH: `extensions/types.ts` and `extensions/runner.ts` around model events.
- MEDIUM: `interactive-mode.ts` model status rendering.

### Migration notes

- Keep `system_prompt_change` gated by actual string inequality. Same-preset model switches must not spam the event or TUI.

## Seam 3: Compaction Apply ExtensionContext API (2026-04-27)

### What changed

- `src/core/agent-session.ts`: Added in-memory monotonic message revision counter. Added `getMessageRevision()` and `applyCompaction(precomputed, { reason, expectedRevision })` for compare-and-apply speculative compaction.
- `src/core/agent-session.ts`: Extended `_executeCompaction()` to accept a precomputed `CompactionResult`.
- `src/core/extensions/types.ts`: Added `ApplyCompactionOptions`, `ApplyCompactionResult`, `ExtensionContext.getMessageRevision()`, `ExtensionContext.applyCompaction()`.
- `src/core/extensions/runner.ts`: Wired new context actions through `bindCore()` and `createContext()`.
- `src/modes/interactive/interactive-mode.ts`: Added same methods to inline shortcut `ExtensionContext` literal.

### Why

- Speculative/v2 compaction needs a stable compare-and-apply seam: extensions can prepare a compaction summary against revision N and only apply it if no context-affecting message mutation has happened since.
- `getMessageRevision()` is intentionally monotonic and in-memory only; it is a staleness guard, not persisted session data.
- `applyCompaction()` returns explicit `ok`, `stale`, or `rejected` outcomes so extensions can avoid racing the live session.

### Why extension system couldn't handle this

Extensions can observe hooks and return summaries during a core-driven compaction, but they cannot append a compaction entry, rebuild agent context, emit core compaction events, or atomically guard against stale session context without a typed core API.

### Expected merge conflict zones on next upstream sync

- HIGH: `agent-session.ts` around message revision and `applyCompaction()` implementation.
- HIGH: `extensions/types.ts` and `extensions/runner.ts` around `ExtensionContext`/`ExtensionContextActions` definitions.
- MEDIUM: `interactive-mode.ts` shortcut context literals must retain parity with `ExtensionRunner.createContext()`.

### Migration notes

If upstream adds new `ExtensionContext` methods or changes `AgentSession` message mutation logic, preserve the monotonic revision counter and the `applyCompaction()` compare-and-apply semantics. The revision guard must remain in-memory and advance on every context-affecting mutation. Do not let upstream's `ExtensionContext` additions shadow the new methods.

## Seam 4: Unified Compaction Pipeline (2026-04-27)

### What changed

- `src/core/agent-session.ts`: Consolidated manual, threshold, overflow, pre-prompt, and extension-triggered compaction routes into a single private `_executeCompaction()` pipeline.
- The unified pipeline covers: preparation, extension hook execution (`session_before_compact`), summary generation, pre-append token simulation, session append, context rebuild, and completion event emission (`session_compact`).
- Route-specific metadata (reason, custom instructions, thinking/max-token behavior), error handling, retry handling, token estimation before append, and abort handling now flow through one seam.

### Why

- The user identified 9 route inconsistencies caused by duplicated compaction code paths across manual `/compact`, threshold-triggered, overflow-recovery, pre-prompt, and extension-triggered compaction.
- Without unification, each route handled metadata, error recovery, token estimation, and event emission differently, causing observable behavioral differences for extensions consuming compaction events.

### Why extension system couldn't handle this

The duplicated route control flow lives inside `AgentSession`. Extensions can customize compaction content via `session_before_compact` hooks, but they cannot unify internal caller behavior, append semantics, context rebuilds, or core event ordering from outside the session.

### Expected merge conflict zones on next upstream sync

- HIGH: `agent-session.ts` is the highest-churn upstream file. Rebase conflict resolution must preserve the `_executeCompaction()` pipeline and keep branch summarization outside this helper.

### Migration notes

If upstream modifies any compaction route (manual, threshold, overflow, pre-prompt), resolve conflicts by routing the modified logic through `_executeCompaction()` rather than restoring inline duplication. Preserve the 6-route coverage: manual, threshold, overflow-recovery, pre-prompt, extension-triggered, and branch summarization (which routes through the hook but remains a separate caller). Keep the pre-append token simulation step to prevent post-compaction overflow.

## builtin extension labels

- Changed `src/core/extensions/builtin/index.ts` and `src/core/resource-loader.ts` so builtin extensions keep stable synthetic ids like `<builtin:todowrite>` instead of being loaded as numbered inline factories.
- This was changed in core because the startup Extensions list is sourced from extension metadata produced by `DefaultResourceLoader`; the extension API cannot rename builtin factory identities after load.
- Expected merge-conflict zone on upstream sync: builtin extension registration in `src/core/extensions/builtin/index.ts` and builtin factory loading in `src/core/resource-loader.ts`.

## move selected defaults to global extensions

- Changed `src/core/extensions/builtin/index.ts` and `src/core/resource-loader.ts` so `diff`, `files`, `prompt-url-widget`, and `tps` are no longer registered as builtin factories.
- `DefaultResourceLoader` now seeds generated shim files for those four defaults into the real global `agentDir/extensions/` directory, so they load through normal global extension discovery instead of builtin registration.
- `DefaultResourceLoader` now rewrites previously generated shim files when their absolute builtin module paths become stale after the checkout/package directory moves or is renamed.
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

## synced builtin extensions and webfetch

- Changed `src/core/extensions/builtin/index.ts`, `src/core/resource-loader.ts`, and `src/core/settings-manager.ts` so builtin extensions can be allowlisted with `enabledBuiltinExtensions` while preserving `disabledBuiltinExtensions` as an override.
- Added `src/core/extensions/builtin/webfetch/` as a builtin extension synced from `../pi-extensions/pi-webfetch`, and moved `bash-timeout` and `openai-api-parallel-tool-calls` to synced `../pi-extensions` layouts.
- Added `scripts/sync-builtin-extensions.mjs`, wired into the package build, so local builds refresh the vendored builtin snapshots from `SENPI_BUILTIN_EXTENSIONS_SOURCE` or `../pi-extensions` when that source checkout exists. `external-versions.json` records the source package names and versions included in the snapshot.
- This had to be done in core because builtin extension registration and builtin settings filtering happen before any user extension can affect resource discovery.
- Expected merge-conflict zone on upstream sync: builtin extension registration in `src/core/extensions/builtin/index.ts`, builtin factory filtering in `src/core/resource-loader.ts`, and settings schema/getters in `src/core/settings-manager.ts`.

## Anthropic "max" thinking level and provider/model extraBody config

- Widened the `"max"` thinking level through the coding agent surface: CLI `--thinking max`, `/settings` selector, Shift+Tab cycle, `settings.json` `defaultThinkingLevel`, thinking border color mapping.
- Extended `packages/coding-agent/src/core/model-registry.ts` so `models.json` (and `pi.registerProvider()`) accepts `extraBody` at both provider and per-model level. `getApiKeyAndHeaders` now resolves `extraBody`, and `sdk.ts` merges provider/model extraBody with any call-site `extraBody` before invoking `streamSimple`.
- This had to be done in core because `ThinkingLevel` is exported from `@mariozechner/pi-agent-core` and every UI/CLI/settings surface needed to be widened, and because `getApiKeyAndHeaders` + stream option composition live in core `ModelRegistry`/`sdk.ts`.
- Expected merge-conflict zone on upstream sync: `model-registry.ts` schemas + `getApiKeyAndHeaders`, `sdk.ts` stream option composition, `cli/args.ts` validator, `settings-manager.ts` thinking level type, `agent-session.ts` thinking cycle list, interactive TUI thinking selector and border color map.
