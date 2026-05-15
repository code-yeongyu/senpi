# Core Extensions Changes

## 2026-05-15 - OpenAI Chat Completions Tool Pair Guard

### What changed

- `builtin/tool-pair-guard/index.ts`: Extended the provider request guard to run an OpenAI Chat Completions payload sanitizer after the Anthropic and OpenAI Responses sanitizers.
- `builtin/tool-pair-guard/sanitize-openai-chat-completions-payload.ts`: Added Chat Completions request message repair that drops orphan or duplicate `role: "tool"` messages and inserts synthetic `role: "tool"` results for interrupted assistant `tool_calls`.
- `test/tool-pair-guard/sanitize-openai-chat-completions-payload.test.ts`: Added regression coverage for valid-pair no-op behavior, orphan output removal, duplicate output removal, and missing output synthesis before transcript advance or payload end.

### Why

- OpenAI-compatible Chat Completions providers reject `role: "tool"` messages whose `tool_call_id` has no preceding assistant `tool_calls` entry. Persisted or compacted sessions with stale tool outputs can otherwise keep replaying the same invalid payload and fail with HTTP 400.

### Why extension system couldn't handle this alone

- The fix does use the extension system: `tool-pair-guard` is a builtin extension that repairs provider payloads through `before_provider_request`. No core provider or agent loop change was required.

### Expected merge conflict zones

- LOW: `builtin/tool-pair-guard/index.ts` if upstream changes provider-request hook wiring.
- LOW: `builtin/tool-pair-guard/sanitize-openai-chat-completions-payload.ts` if upstream adds an equivalent Chat Completions pairing normalizer.

## 2026-05-15 - OpenAI Responses Tool Pair Guard

### What changed

- `builtin/tool-pair-guard/index.ts`: Extended the existing provider request guard to run both Anthropic and OpenAI Responses payload sanitizers.
- `builtin/tool-pair-guard/sanitize-openai-responses-payload.ts`: Added OpenAI Responses request input repair that drops orphan `function_call_output` / `custom_tool_call_output` items and inserts synthetic outputs for interrupted calls that have no result.
- `test/tool-pair-guard/sanitize-openai-responses-payload.test.ts`: Added regression coverage for orphan output removal, missing output synthesis, valid-pair no-op behavior, and `previous_response_id` delta preservation.

### Why

- OpenAI Responses rejects requests with `No tool call found for function call output with call_id ...` when a stale tool output survives without its matching call. Once such history is persisted, follow-up prompts can repeatedly send the same invalid output and leave the session stuck.

### Why extension system couldn't handle this alone

- The fix does use the extension system: `tool-pair-guard` is a builtin extension that repairs provider payloads through `before_provider_request`. No core provider or agent loop change was required.

### Expected merge conflict zones

- LOW: `builtin/tool-pair-guard/index.ts` if upstream changes provider-request hook wiring.
- LOW: `builtin/tool-pair-guard/sanitize-openai-responses-payload.ts` if upstream adds an equivalent OpenAI Responses pairing normalizer.

## 2026-05-15 - Normalize remaining senpi internal names

### What changed

- `builtin/system-messages.ts`: Renamed the exported conversation constants, event type names, and helper function names to the `SENPI_*` / `Senpi*` spelling, and changed the emitted conversation event name to `senpi:conversation`.
- `builtin/todotools/system-messages.ts`: Applied the same event-name and constant-name cleanup to the vendored todotools helper.
- `builtin/todotools/state.ts`: Changed the todo state custom entry type to `senpi.todo-state`.
- `test/suite/senpi-conversation.test.ts`: Renamed the regression test file and assertions to match the senpi runtime naming.

### Why

- The fork identity is `senpi`, and the remaining internal directive/event/state/env names should carry the same identity instead of preserving an earlier spelling.

### Why extension system couldn't handle this alone

- These names are builtin extension wire constants and session custom-entry identifiers. They must be emitted correctly by the bundled implementation before user or external extensions can observe them.

### Expected merge conflict zones

- LOW: `builtin/system-messages.ts`, `builtin/todotools/system-messages.ts`, and `builtin/todotools/state.ts` if upstream or vendored builtins rename these helper surfaces.

## 2026-05-14 - Native Web Tool UI Cleanup Hooks

### What changed

- `builtin/anthropic-web-search/index.ts`: Added session/model UI cleanup for Anthropic native `web_search` so older startup widgets are cleared.
- `builtin/openai-web-search/index.ts`: Added session/model UI cleanup for OpenAI Responses native `web_search_preview` so older startup widgets are cleared.
- `test/suite/anthropic-web-search-extension.test.ts` and `test/suite/openai-web-search-extension.test.ts`: Added regression coverage that native web tool extensions do not leave startup/footer widgets behind.

### Why

- Native provider web search is injected below the function-tool layer, but always-on footer widgets for that availability are too noisy. The UI should stay quiet until an actual tool execution or provider response needs rendering.

### Why extension system couldn't handle this alone

- These are already builtin extensions responsible for native provider payload mutation; the useful UI state belongs beside that injection logic.

### Expected merge conflict zones

- LOW: `builtin/anthropic-web-search/index.ts` and `builtin/openai-web-search/index.ts` if native web tool payload handling changes upstream.

## 2026-05-13 - Rename injected system prefix to senpi

### What changed

- `builtin/system-messages.ts`: Changed the injected builtin system-message prefix to `[system:senpi]`.
- `builtin/todotools/system-messages.ts`: Applied the same prefix change to the vendored todotools helper.
- `test/suite/senpi-conversation.test.ts`: Added regression coverage that both helpers emit the `senpi` marker.

### Why

- The runtime identity is `senpi`, so internally injected reminder/follow-up messages should use the matching `[system:senpi]` marker.

### Why extension system couldn't handle this alone

- The marker is emitted by bundled helper modules used by builtin extensions before handing messages to the agent runtime.

### Expected merge conflict zones

- LOW: `builtin/system-messages.ts` and `builtin/todotools/system-messages.ts` if the helper modules are renamed or consolidated.

## 2026-05-12 - Externalize todotools vendored builtin source

### What changed

- Added `pi-todotools` to the vendored builtin sync manifest and `sync-builtin-extensions.mjs` mapping.
- Refreshed `builtin/todotools/` from the standalone `../pi-extensions/pi-todotools` source while preserving the `todowrite` builtin id and tool names.
- Added local `todotools/settings.ts` and `todotools/system-messages.ts` helpers so the extracted extension uses only public package APIs externally.
- Updated sync coverage to pin the `pi-todotools` package version.

### Why

- Todo tools are now maintained as a public sibling extension like other vendored builtins, while senpi continues shipping the feature in the binary.

### Why extension system couldn't handle this alone

- senpi's builtin list is assembled by core resource loading; shipping a sibling extension as a builtin still requires vendored source and the builtin sync manifest.

### Expected merge conflict zones

- `builtin/todotools/` if upstream adds its own todo tooling.
- `builtin/external-versions.json` and `scripts/sync-builtin-extensions.mjs` if more vendored packages are added.

## 2026-05-11 - GPT apply_patch Realtime Progress Rendering

### What changed

- `builtin/gpt-apply-patch/types.ts`: Added progress metadata for partial apply_patch updates.
- `builtin/gpt-apply-patch/apply.ts`: Added an optional progress callback emitted after each patch operation.
- `builtin/gpt-apply-patch/preview.ts` and `tool.ts`: Render pending updates as `Applying patch (done/total)` while preserving rich diff previews.
- `test/suite/gpt-apply-patch-extension.test.ts` and `gpt-apply-patch-rich-render.test.ts`: Added regression coverage for realtime progress updates and pending widget titles.

### Why

- Multi-file apply_patch calls previously showed a single pending diff preview and did not update the TUI as individual operations completed.

### Why extension system couldn't handle this alone

- `gpt-apply-patch` is already the builtin extension; progress has to be emitted from its apply loop and rendered by its tool result renderer.

### Files modified

- `builtin/gpt-apply-patch/types.ts`
- `builtin/gpt-apply-patch/apply.ts`
- `builtin/gpt-apply-patch/preview.ts`
- `builtin/gpt-apply-patch/tool.ts`
- `builtin/gpt-apply-patch/index.ts`
- `../../test/suite/gpt-apply-patch-extension.test.ts`
- `../../test/suite/gpt-apply-patch-rich-render.test.ts`

### Expected merge conflict zones on next upstream sync

- LOW: `builtin/gpt-apply-patch/apply.ts` apply loop callback wiring.
- LOW: `builtin/gpt-apply-patch/tool.ts` pending update render title.

## 2026-05-11 - GPT apply_patch OpenCode-style Diff Rendering

### What changed

- `builtin/gpt-apply-patch/preview-format.ts`: Reworked expanded patch previews to render OpenCode-like diff rows with colored signs, muted line numbers, added/removed row backgrounds, syntax highlighting when a TUI theme is available, and inverse inline word highlights for paired edits.
- `builtin/gpt-apply-patch/types.ts`: Added `toolErrorBg` to the local theme background type used by apply_patch row rendering.
- `test/suite/gpt-apply-patch-rich-render.test.ts`: Added regression coverage for row background colors and inline added/removed highlights.
- `builtin/external-versions.json`: Bumped the vendored `pi-apply-patch` snapshot metadata to `0.1.1`.

### Why

- The previous rich preview only colored whole `+` / `-` lines and did not match OpenCode's edit/apply_patch diff visual hierarchy closely enough.

### Why extension system couldn't handle this alone

- `gpt-apply-patch` is already the builtin extension; the change is inside its own TUI render path.

### Files modified

- `builtin/gpt-apply-patch/preview-format.ts`
- `builtin/gpt-apply-patch/types.ts`
- `builtin/gpt-apply-patch/index.ts`
- `builtin/external-versions.json`
- `../../test/suite/gpt-apply-patch-rich-render.test.ts`

### Expected merge conflict zones on next upstream sync

- LOW: `builtin/gpt-apply-patch/preview-format.ts` render helpers.
- LOW: `builtin/gpt-apply-patch/types.ts` local theme background union.

## 2026-05-11 - GPT apply_patch External Path Support

### What changed

- `builtin/gpt-apply-patch/workspace.ts`: Removed workspace-boundary and realpath validation from path resolution.
- `builtin/gpt-apply-patch/apply.ts` and `preview.ts`: Resolve patch paths with Node `path.resolve(cwd, filePath)` and allow absolute, parent-escaping, and symlink-escaping targets.
- `test/suite/gpt-apply-patch-backport.test.ts`: Added regression coverage for absolute paths outside the current workspace and symlink paths resolving outside it.

### Why

- Codex-style patch payloads can legitimately target files outside the session cwd, for example adjacent worktrees or debug journals. The previous guard rejected those paths with `File references must stay within the current workspace.`

### Why extension system couldn't handle this alone

- `gpt-apply-patch` is a builtin extension and the path policy lives inside its vendored implementation.

### Files modified

- `builtin/gpt-apply-patch/workspace.ts`
- `builtin/gpt-apply-patch/apply.ts`
- `builtin/gpt-apply-patch/preview.ts`
- `../../test/suite/gpt-apply-patch-backport.test.ts`

### Expected merge conflict zones on next upstream sync

- LOW: `builtin/gpt-apply-patch/workspace.ts` path resolution helpers.
- LOW: `builtin/gpt-apply-patch/apply.ts` and `preview.ts` imports/call sites for the path resolver.

## 2026-05-08 - Generated Default Extension Factory Resolver

### What changed

- `loader.ts`: `loadExtensions()` now accepts an optional factory resolver and creates the jiti importer lazily only when an extension path is not resolved to a known factory.
- `builtin/index.ts`: Exposes a keyed map for the four global default extension factories used by generated shims.

### Why

- The default global extension shim files are deterministic. Letting core resolve those shims to known factories avoids the jiti import path without changing extension order, source paths, or behavior for custom extension files.

### Why extension system couldn't handle this alone

- Extension loading is core infrastructure; extensions cannot intercept the module importer before their factories have been loaded.

### Files modified

- `loader.ts`
- `builtin/index.ts`

### Expected merge conflict zones on next upstream sync

- MEDIUM: `loader.ts` around `loadExtension()` and `loadExtensions()` signatures/importer construction.
- LOW: `builtin/index.ts` around global default extension registration.

## 2026-05-08 - Shared Jiti Extension Importer

### What changed

- `loader.ts`: Reuses one `jiti` importer across each `loadExtensions()` batch while keeping `moduleCache: false` for reload freshness.
- `loader.ts`: Aliases upstream `@mariozechner/pi-*` peer imports to the already-loaded senpi workspace packages.

### Why

- Startup was spending several seconds creating a fresh `jiti` instance for every configured extension, causing repeated TypeScript/dependency resolution work before the first TUI frame.
- Installed pi extensions still import upstream `@mariozechner/pi-coding-agent`, `pi-ai`, and `pi-tui` peer names. Without aliases, jiti can fall through to each extension's own `node_modules` and load a duplicate pi runtime.

### Why extension system couldn't handle this alone

- Extension loading is core infrastructure; extensions cannot change how the core loader imports extension modules.

### Files modified

- `loader.ts`

### Expected merge conflict zones on next upstream sync

- MEDIUM: `loader.ts` around `loadExtensionModule()`, `loadExtension()`, and `loadExtensions()` importer construction.

## 2026-04-30 - Model Switch System Prompt Change Event

### What changed

- `types.ts`: Added `ModelSelectEventResult` and `SystemPromptChangeEvent`, plus `pi.on("system_prompt_change", ...)` typing.
- `runner.ts`: Added `emitModelSelect()` so `model_select` handlers can request an active system prompt replacement.
- `builtin/prompt-preset/index.ts`: Returns the resolved prompt preset during `model_select`, including fallback reset when no preset applies.

### Why

- Prompt presets previously updated the system prompt only at `before_agent_start`, so a mid-session model switch did not immediately update the active prompt or expose a typed event for observers.

### Why extension system couldn't handle this alone

- Extensions could listen to `model_select`, but the runner ignored handler return values and there was no typed `pi.on` event for the resulting system prompt change.

### Files modified

- `types.ts`
- `runner.ts`
- `builtin/prompt-preset/index.ts`

### Expected merge conflict zones on next upstream sync

- HIGH: `types.ts` around model/agent event unions and `ExtensionAPI.on` overloads.
- HIGH: `runner.ts` around event emission helpers.

### Migration notes

- Preserve the invariant that `system_prompt_change` fires only after the active prompt string actually changes.

## 2026-04-28 - Compaction Settings Context API

### What changed

- `types.ts`: Added `ExtensionContext.getCompactionSettings()` and matching `ExtensionContextActions.getCompactionSettings`.
- `runner.ts`: Wired the new context action through `bindCore()` and `createContext()`.
- `agent-session.ts`: Bound the context action to `settingsManager.getCompactionSettings()`.
- `interactive-mode.ts`: Added the same method to inline shortcut `ExtensionContext` construction.

### Why

- The builtin compaction extension previously used `DEFAULT_COMPACTION_SETTINGS`, which bypassed user/project settings such as `compaction.enabled: false`.
- Plugsuit-style threshold realignment needs resolved settings for speculative toggles, cooldowns, keep-recent caps, and restoration budgets.

### Why extension system couldn't handle this alone

- Extensions receive `ExtensionContext`, not the core `SettingsManager`; without a typed context method, builtin extensions cannot read the already-merged global/project/user compaction settings.

### Files modified

- `types.ts`
- `runner.ts`
- `agent-session.ts`
- `interactive-mode.ts`

### Expected merge conflict zones on next upstream sync

- HIGH: `types.ts` and `runner.ts` around `ExtensionContext`/`ExtensionContextActions` definitions and context construction.
- HIGH: `interactive-mode.ts` shortcut context literals must retain parity with `ExtensionRunner.createContext()`.

### Migration notes

- If upstream adds settings access to `ExtensionContext`, keep this method or map the builtin compaction extension to the upstream equivalent. The required invariant is that compaction policy uses resolved settings, never hardcoded defaults.

## 2026-04-27 - Seam 3: Compaction Apply Context API

### What changed

- `types.ts`: Added `ApplyCompactionOptions`, `ApplyCompactionResult`, `ExtensionContext.getMessageRevision()`, and `ExtensionContext.applyCompaction()`.
- `runner.ts`: Wired the new context actions through `bindCore()` and `createContext()` so extensions can read the current message revision and apply a precomputed compaction result.
- `interactive-mode.ts`: Added the same methods to the inline shortcut `ExtensionContext` literal.

### Why

- Speculative/v2 compaction needs a stable compare-and-apply seam: extensions can prepare a compaction summary against revision N and only apply it if no context-affecting message mutation has happened since.
- `getMessageRevision()` is intentionally monotonic and in-memory only; it is a staleness guard, not persisted session data.
- `applyCompaction()` returns explicit `ok`, `stale`, or `rejected` outcomes so extensions can avoid racing the live session.

### Why extension system couldn't handle this alone

Extensions can observe hooks and return summaries during a core-driven compaction, but they cannot append a compaction entry, rebuild agent context, emit core compaction events, or atomically guard against stale session context without a typed core API.

### Files modified

- `types.ts`
- `runner.ts`
- `interactive-mode.ts`
- `agent-session.ts`

### Expected merge conflict zones on next upstream sync

- HIGH: `types.ts` and `runner.ts` around `ExtensionContext`/`ExtensionContextActions` definitions and context construction.
- HIGH: `interactive-mode.ts` shortcut context literals must retain parity with `ExtensionRunner.createContext()`.

### Migration notes

If upstream adds new `ExtensionContext` methods or changes `AgentSession` message mutation logic, preserve the monotonic revision counter and the `applyCompaction()` compare-and-apply semantics. The revision guard must remain in-memory and advance on every context-affecting mutation. Do not let upstream's `ExtensionContext` additions shadow the new methods.

## 2026-05-15 - Compaction Feedback Context API

### What changed

- `types.ts`: Added optional `ExtensionContext.beginCompaction()` and `ExtensionContext.endCompaction()` methods.
- `runner.ts`: Wired the new optional context actions through `bindCore()` and `createContext()`.
- `agent-session.ts`: Supplies the context actions with the same abort controller and canonical compaction events used by core compaction routes.

### Why

- Builtin speculative compaction can generate or await a summary before it calls `applyCompaction()`.
- That wait must still surface as a normal compaction to TUI/RPC consumers so loaders, cancellation, and input queueing work while the summary is in flight.

### Why extension system couldn't handle this alone

UI notifications alone cannot update `AgentSession.isCompacting`, participate in `abortCompaction()`, or emit the canonical compaction event pair.

### Files modified

- `types.ts`
- `runner.ts`
- `agent-session.ts`
- `builtin/compaction/index.ts`
- `modes/interactive/interactive-mode.ts`

### Expected merge conflict zones on next upstream sync

- HIGH: `types.ts` and `runner.ts` around `ExtensionContext`/`ExtensionContextActions` definitions and context construction.
- HIGH: `agent-session.ts` around compaction abort-controller ownership and `applyCompaction()` event emission.

### Migration notes

Keep `beginCompaction()`/`endCompaction()` optional for third-party context mocks, but preserve runner support so builtin extensions receive the real core-backed implementation.

## 2026-04-27 - Seam 1: Compaction Event Metadata

### What changed

- `types.ts` line ~85: Added `CompactionReason` and `CompactionRejectionCause` exported literal-union aliases.
- `types.ts` lines ~541-554: Added `reason`, `willRetry`, and `requestId` metadata to `SessionBeforeCompactEvent`.
- `types.ts` lines ~549-554: Added `reason`, `requestId`, `accepted`, and optional `rejectionCause` metadata to `SessionCompactEvent`.
- `agent-session.ts` lines ~1651, ~1713, ~1910, and ~1986: Populated the 4 existing compaction event construction sites with the new required metadata fields. T15 will refactor these construction sites into the unified `_executeCompaction()` pipeline. T13 only populates the new required fields with minimal correct values to keep tsgo passing.

### Why

- Extensions cannot safely apply route-specific policies such as cooldown scope or circuit-breaker counters without knowing the compaction source.
- The user explicitly required consistency across the 6 compaction routes; this metadata is the prerequisite.
- `reason` always preserves the route source, while `rejectionCause` explains why a compaction was rejected when `accepted` is false.

### Why extension system couldn't handle this alone

Event payloads are core-defined types. Extensions can consume compaction events, but they cannot add typed fields to those events from outside the core extension API.

### Files modified

- `types.ts`
- `agent-session.ts`

### Expected merge conflict zones on next upstream sync

- HIGH: `types.ts` is high-churn upstream, especially around extension event definitions. Resolution: preserve additive compaction metadata and keep `reason` semantically separate from `rejectionCause`.

### Migration notes

If upstream modifies compaction event definitions in `types.ts`, preserve the additive metadata fields (`reason`, `willRetry`, `requestId`, `accepted`, `rejectionCause`) and keep them semantically separate from upstream's existing fields. Update the 4 event construction sites in `agent-session.ts` to populate the new fields with the correct route-specific values.

## 2026-04-13 - GPT apply_patch builtin support

### What changed and why

- Added builtin `gpt-apply-patch` extension support so OpenAI GPT sessions can swap `write`/`edit` for a Codex-style `apply_patch` tool and react to mid-session model changes.
- Extended extension/tool plumbing to carry OpenAI Responses freeform grammar metadata. This core change was necessary because the existing extension API only modeled JSON-schema function tools, which made exact Codex GPT `apply_patch` parity impossible from an extension alone.

### Files modified

- `types.ts`
- `builtin/index.ts`
- `builtin/gpt-apply-patch/index.ts` (vendored from `pi-apply-patch`)

### Why the extension system couldn't handle this alone

- `ToolDefinition` had no way to express freeform grammar tools, only JSON-schema parameters.
- Wrapper plumbing dropped any provider-specific tool metadata before requests reached `pi-ai`.

### Expected merge conflict zones

- `types.ts` around `ToolDefinition`
- `builtin/index.ts` builtin registration ordering
