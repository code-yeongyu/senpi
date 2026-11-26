<!-- changes-log: packages/coding-agent/src/modes/rpc/changes.md -->
## 2026-11-26 - A supervisor whose host child is gone gives up the public socket even when the exit is never observed (oh-my-openagent#14725)

### What changed

- `packages/coding-agent/src/modes/rpc/host-lifecycle-drain.ts`: new `watchChildLifetimePipe` (POSIX). The host child inherits its end of the slot-3 lifetime pipe and never closes it, so EOF on the supervisor's end means the child has exited. When no exit event follows within `CHILD_KILL_EXIT_TIMEOUT_MS` and the child's private hop refuses connections (`ECONNREFUSED` or `ENOENT`; any other connect failure is no evidence), `onGone` runs. A hop that still accepts is logged and left alone.
- `packages/coding-agent/src/modes/rpc/host-lifecycle.ts`: arms that watch at spawn. `onGone` runs the supervisor's ordinary single-flight shutdown (`rpc host child closed its lifetime pipe and its exit was never observed`, exit code 1): stop intent, SIGTERM, the stall-aware wait, SIGKILL and the kill-exit breaker, then process exit. The listener closes with the process, and the generation is released by the next ensure's prune.

### Why

- A production supervisor (macOS, engine 2026.11.23) kept `<agentDir>/rpc/rpc.sock` for two days after its host child had exited. The child was a zombie: the supervisor never received its `exit` event, and that event was the only thing that ended a generation on POSIX. The idle ticker and the owner check stand down while draining, and the drain grace re-asks a dead pid forever. Every client got a closed connection or no answer, and every new host was refused with `address already in use by a live server (accepting connections)`.

### Why an extension could not handle it

- The supervisor runs no extensions; its child-exit handling and public listener are host lifecycle internals.

### Expected merge conflict zones

- LOW: `host-lifecycle.ts`, the lines after the `HOST_CHILD_WATCH_FD` error handler in `runHostSupervisor`.
- LOW: `host-lifecycle-drain.ts`, the imports and the new function before the win32 identity watchdog.

<!-- changes-log: packages/coding-agent/CHANGELOG.md -->
### Fixed
- A host supervisor whose host child had exited without the exit being observed (for example after a drain whose successor never took over) no longer holds the RPC socket forever, closing every client and refusing every new host with "address already in use"; it now ends the generation and gives the socket up (oh-my-openagent#14725)
