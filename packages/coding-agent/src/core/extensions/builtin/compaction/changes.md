# Builtin compaction extension changes

## OpenAI remote compact API path (2026-05-15)

- Added `openai-remote.ts` as a builtin-extension module that can call OpenAI's remote compact endpoint when the current
  session branch is entirely representable as OpenAI Responses input.
- The extension stores the returned native compacted input on `CompactionResult.details`, then rewrites later OpenAI
  Responses provider payloads so the compacted session can continue from the provider-native history.
- The extension emits `senpi:compaction` events for remote start, completion, fallback, and payload rewrite points so other
  extensions can observe which compaction route was used.
- This remains in the builtin extension because provider compatibility, endpoint selection, fallback, and provider-payload
  rewriting are all extension-hookable. Core only needs to carry opaque compaction details to the renderer.

Expected upstream conflict zones: `builtin/compaction/index.ts` around `session_before_compact` and
`before_provider_request` hook wiring if upstream changes compaction extension policy or provider request events.

## Blocking compaction feedback scope

- Changed `index.ts` so blocking extension compaction calls `ctx.beginCompaction()` before awaiting an in-flight speculative job or generating a fresh summary.
- The feedback signal is linked to speculative generation aborts, and `ctx.endCompaction()` is used only when no compaction entry is applied.
- This remains in the builtin extension because the policy deciding when to await speculative work or generate a fresh summary is extension-owned; the core only provides the visible feedback/cancellation scope.

Expected upstream conflict zones: `builtin/compaction/index.ts` around `applyBlockingCompaction()` and `core/agent-session.ts` around extension compaction context actions.

## Post-compact restoration tracker

- Added `restoration-tracker.ts` as a builtin-extension module so file and skill context can be restored without modifying core session flow.
- Added compaction extension hooks for `tool_call`, accepted `session_compact`, and one-shot `before_agent_start` injection.
- Added optional restoration settings to `CompactionSettings` and state storage for the tracker.
- Extension system is sufficient because the feature only needs tool-call observation, compaction lifecycle events, and custom-message injection.

Expected upstream conflict zones: `builtin/compaction/index.ts`, `builtin/compaction/state.ts`, and `core/compaction/compaction.ts` if upstream changes compaction settings or extension hook wiring.
