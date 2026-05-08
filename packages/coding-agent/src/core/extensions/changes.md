# Core Extensions Changes

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
