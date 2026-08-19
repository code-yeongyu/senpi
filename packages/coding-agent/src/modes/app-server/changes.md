# changes

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
