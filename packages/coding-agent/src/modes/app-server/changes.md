# changes

## Process-local Codex MCP overrides and reload (2026-08-19)

### What changed

- `packages/coding-agent/src/modes/app-server/index.ts` passes parsed `-c` overrides into the runtime.
- `packages/coding-agent/src/modes/app-server/runtime.ts` binds the immutable process-local MCP source to every created session and implements `config/mcpServer/reload` through the existing MCP service.
- `packages/coding-agent/src/modes/app-server/mcp-config-overrides.ts` materializes complete `mcp_servers.<name>.url` and `bearer_token_env_var` pairs without persistence, while redacting malformed-input diagnostics.
- `packages/coding-agent/src/modes/app-server/threads/mcp-wire-status.ts` includes the process-local source in threadless status queries and reports absent bearer environment variables as unauthenticated.

### Why

- T3 Code supplies its local MCP endpoint and bearer environment variable through Codex-compatible app-server arguments and refreshes that catalog before turns.

### Why an extension could not handle it

- The source originates in app-server CLI options and the reload request must coordinate all loaded app-server thread adapters; ordinary extensions cannot access either host-owned surface.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/modes/app-server/index.ts`, around runtime construction.
- MEDIUM: `packages/coding-agent/src/modes/app-server/runtime.ts`, around session construction and method registration.
- LOW: `packages/coding-agent/src/modes/app-server/mcp-config-overrides.ts`, an additive app-server boundary module.
- LOW: `packages/coding-agent/src/modes/app-server/threads/mcp-wire-status.ts`, around process-scope adapter construction.

## Integer wire timestamps (2026-08-19)

### What changed

- `packages/coding-agent/src/modes/app-server/threads/wire-thread.ts` and `packages/coding-agent/src/modes/app-server/threads/turn-runtime.ts` now floor parsed or live timestamps to integer epoch seconds for thread and turn wire fields.

### Why

- Codex V2 clients require timestamp values to satisfy their int64 schema.

### Why an extension could not handle it

- Timestamp projection is owned by the app-server wire serializer before extension code can run.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/modes/app-server/threads/wire-thread.ts` and `packages/coding-agent/src/modes/app-server/threads/turn-runtime.ts`, around timestamp projection.

## Codex-style app-server config overrides (2026-08-19)

### What changed

- `packages/coding-agent/src/modes/app-server/cli-args.ts` now accepts repeatable `-c <key>=<value>` app-server arguments and preserves raw override values in order.

### Why

- T3 Code spawns app-server with Codex-style configuration overrides.

### Why an extension could not handle it

- CLI argument parsing occurs before app-server extensions are loaded.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/modes/app-server/cli-args.ts`, beside server argument parsing.

## turn/plan/updated from todo-tool plan state (2026-08-19)

### What changed

- `threads/projection.ts` `completeTool()` (the existing `tool_execution_end`
  seam) now also emits `turn/plan/updated` when the completed tool is the todo
  tool and its structured `details.phases` parses into plan steps.
- New `threads/projection-plan.ts` maps senpi todo statuses to Codex V2
  (`pending`/`in_progress`/`completed`/`abandoned` ->
  `pending`/`inProgress`/`completed`/`completed`) and skips malformed phases,
  tasks, and unknown statuses instead of inventing steps.
- `protocol/notifications.ts` gains facade types `TurnPlanStepStatus`,
  `TurnPlanStep`, `TurnPlanUpdatedNotification` and a typed union member for
  `turn/plan/updated` (already enumerated in `protocol/methods.ts`).

### Why

- Codex/T3 clients render a plan panel from `turn/plan/updated`; senpi's todo
  tool already owns structured plan state, but `senpi.todo-state` entries never
  reach the `EventProjector`, so the notification had to be projected from the
  completed tool result at the projection seam.

### Why an extension could not handle it

- The projection seam and notification dispatch are private to the app-server
  thread runtime; extensions only see tool execution, not wire notifications.

### Expected merge conflict zones

- LOW: `threads/projection.ts` `completeTool()` notification list, beside the
  `turn/diff/updated` emission; `protocol/notifications.ts` union tail.

## Persistent append-only thread rollback (2026-08-19)

### What changed

- `packages/coding-agent/src/modes/app-server/protocol/thread.ts` exposes the existing V2 rollback request and response shape through the app-server facade.
- `packages/coding-agent/src/modes/app-server/threads/handlers.ts` registers the rollback handler and captures compaction cutoffs.
- `packages/coding-agent/src/modes/app-server/threads/rollback-handler.ts` validates rollback requests, moves the session leaf, persists the selected branch, and returns the updated thread snapshot.
- `packages/coding-agent/src/modes/app-server/threads/turn-log.ts` retains each turn's pre-turn leaf and truncates only the in-process wire view.
- `packages/coding-agent/src/modes/app-server/threads/turn-runtime.ts` exposes the narrow session-manager checkpoint surface to the turn engine.
- `packages/coding-agent/src/modes/app-server/threads/turns.ts` records the session leaf at each turn-start seam.
- `packages/coding-agent/src/modes/app-server/threads/wire-thread.ts` reconstructs persisted turn cutoffs from user-message parent links.

### Why

- Codex-compatible clients use `thread/rollback` to restore a prior conversational checkpoint without reverting workspace files.
- The selected history must survive session unload/resume while abandoned session entries remain available in the append-only tree.

### Why an extension could not handle it

- Only app-server owns V2 method registration, wire-turn projection, and the in-process turn log.
- Only the core turn lifecycle can capture the exact session leaf before a requested turn starts.

### Expected merge conflict zones

- MEDIUM: `packages/coding-agent/src/modes/app-server/threads/handlers.ts`, `packages/coding-agent/src/modes/app-server/threads/turns.ts`, and `packages/coding-agent/src/modes/app-server/threads/turn-runtime.ts` around lifecycle registration and turn-start state.
- LOW: `packages/coding-agent/src/modes/app-server/protocol/thread.ts`, `packages/coding-agent/src/modes/app-server/threads/rollback-handler.ts`, `packages/coding-agent/src/modes/app-server/threads/turn-log.ts`, and `packages/coding-agent/src/modes/app-server/threads/wire-thread.ts` around rollback-specific types and history projection.

## Registry-owned thread teardown (2026-08-13)

### What changed

- `ThreadRegistry.dispose()` now drains each loaded thread's queued work,
  disposes its session, clears MCP wire state, and removes the loaded entries.

### Why

- Test and server teardown must not remove session directories while queued goal
  persistence or replacement work is still writing beneath them.

### Why an extension could not handle it

- The task queues and loaded-session map are private registry state.

### Expected merge conflict zones

- LOW: `threads/registry.ts`, beside `unloadThread()` and task queue ownership.

## App-server extension RPC bridge (2026-08-12)

### What changed

- Added loaded-thread extension request dispatch and extension-owned event
  notifications for app/editor clients.
- Preserved thread registry, lifecycle, daemon, protocol, and RPC ownership for
  the fork-only app-server mode.

### Why

- App-server clients need both directions of the opt-in `pi.rpc` extension
  channel while retaining thread-scoped lifecycle and transport semantics.

### Why an extension could not handle it

- Extensions can register handlers and emit events, but only the app-server owns
  client connections, thread lookup, request correlation, and event delivery.

### Expected merge conflict zones

- MEDIUM: `rpc/registry.ts` and `rpc/runtime.ts`, around extension request and
  event routing.
- MEDIUM: `threads/registry.ts`, around loaded-thread lookup and lifecycle.
- LOW: `protocol/` and daemon surfaces when upstream app-server transport
  contracts change.

## Fork app-server ownership (2026-08-13)

### What changed

- Established the nearest tracker for the fork-only app-server mode.
- The preserved subsystem includes injected turns, daemon launch diagnostics,
  web-search and cumulative file-diff projection, fuzzy file search, protocol
  validation, history and timestamp parity, notification envelopes, terminal
  failure projection, and the mode bootstrap.

### Why

- The entire mode is fork-only at upstream v0.84.1 and repeatedly conflicts as
  one subsystem during upstream synchronization.
- Older dated records remain in the package-wide tracker as historical context;
  new app-server conflict decisions belong here.

### Why an extension could not handle it

- The mode owns process startup, client transport, session registry, and
  thread-to-extension routing before extension code can run.

### Expected merge conflict zones

- HIGH: `daemon/`, `protocol/`, `rpc/`, and `threads/` when upstream adds or
  renames coding-agent modes.
