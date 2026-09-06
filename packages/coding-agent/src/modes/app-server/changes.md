# changes

## Cross-platform daemon process identity and lightweight exit waits (2026-09-01)

### What changed

- `packages/coding-agent/src/modes/app-server/daemon/process.ts` reads process start time from the live `Win32_Process` CIM table through PowerShell on Windows and preserves `ps -o lstart=` on POSIX.
- Process identity is validated with a platform-specific start-time reader before signaling managed children; exit waits repeat that identity check while waiting for termination. On Windows the bounded probe queries the live `Win32_Process` CIM table, so a terminated process retained by an open handle cannot appear live indefinitely.

### Why

- Git for Windows exposes an MSYS `ps` that rejects `-o`; Windows daemons and shared RPC supervisors therefore received a pid but failed ownership registration with “had no process start time.”
- Start time is the PID-reuse ownership proof and is still checked before signaling. The same identity check is repeated while waiting so a reused PID cannot be mistaken for the managed child.

### Why an extension could not handle it

- Daemon ownership and signal safety run before the app-server or RPC extension surfaces exist.

### Expected merge conflict zones

- LOW: `readProcessStartTime`, `waitForGone`, and the adjacent process helper tail in `daemon/process.ts`.

## Provider-neutral account app-server routes (2026-08-27)

### What changed

- `packages/coding-agent/src/modes/app-server/server/account.ts`: `account/providerAccounts/{read,pin,remove}` now dispatch to `core/credential-accounts.ts` (read handler became async), so desktop account management works for every provider instead of only the claude-sdk-oauth lane. Change notifications keep flowing through the same `account-events` bus.

### Why

- The desktop account picker should show and manage any provider's credential pool.

### Why an extension could not handle it

- App-server route registration is core server wiring.

### Expected merge conflict zones

- LOW: import block and the three handlers.

## Force daemon children onto Node and contain ws server errors (2026-08-25)

### What changed

- `modes/app-server/daemon.ts` launches detached daemon children with Node and sets `SENPI_RUNTIME=node` when the parent is Bun.

### Why

- Bun's WebSocket backend emits an unhandled error during daemon probe/status lifecycle; the fork's daemon contract requires stable Node runtime behavior.

### Why an extension could not handle it

- Detached daemon runtime selection occurs before the child application server initializes.

### Expected merge conflict zones

- MEDIUM: detached daemon spawn arguments and runtime environment.

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
