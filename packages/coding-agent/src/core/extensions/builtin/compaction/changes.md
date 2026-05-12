# Builtin compaction extension changes

## 2026-05-12 - Local tool-pair repair for packaged senpi

### What changed
- Added `repair-tool-pairs.ts` to keep compaction's tool-call/tool-result repair logic inside the coding-agent package.
- Switched `builtin/compaction/index.ts` and the compaction repair tests to use the local helper instead of importing `repairOrphanedToolResults` from `@earendil-works/pi-ai`.

### Why
- The published `@code-yeongyu/senpi` package depends on the registry `@earendil-works/pi-ai@^0.74.0`, but the fork-only `repairOrphanedToolResults` export is not present in that published dependency.
- That mismatch makes `senpi` crash during module loading with `SyntaxError: The requested module '@earendil-works/pi-ai' does not provide an export named 'repairOrphanedToolResults'` before any command can run.

### Why extension system couldn't handle this
- The failure happens at ESM module evaluation time while loading a builtin extension, before runtime hooks or settings can intervene.

### Expected merge conflict zones
- LOW: `builtin/compaction/index.ts` import block and any future attempt to re-share this helper from `pi-ai`.

## Post-compact restoration tracker

- Added `restoration-tracker.ts` as a builtin-extension module so file and skill context can be restored without modifying core session flow.
- Added compaction extension hooks for `tool_call`, accepted `session_compact`, and one-shot `before_agent_start` injection.
- Added optional restoration settings to `CompactionSettings` and state storage for the tracker.
- Extension system is sufficient because the feature only needs tool-call observation, compaction lifecycle events, and custom-message injection.

Expected upstream conflict zones: `builtin/compaction/index.ts`, `builtin/compaction/state.ts`, and `core/compaction/compaction.ts` if upstream changes compaction settings or extension hook wiring.
