# changes

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
