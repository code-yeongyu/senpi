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
