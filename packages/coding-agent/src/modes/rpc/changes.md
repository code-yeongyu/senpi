# changes

## [Unreleased] - Feed the supervisor's observer lifecycle records

### What changed

- `session-event-fanout.ts` delivers content-free lifecycle records (`agent_start`, `agent_settled`, `agent_idle`, `session_opened`, and `session_closed`) to every registered socket connection, including unattached observer connections. Session content, rendered component records, responses, and dialog requests retain their attachment/requester scoping.
- The lifecycle supervisor's always-on internal observer therefore receives the turn boundaries required to prevent idle shutdown during an active turn without reopening cross-session content delivery.

### Why

- The supervisor must observe active turns independently of client session attachments; otherwise attached-only delivery leaves it believing an active host is idle.

### Why an extension could not handle it

- Socket fan-out and supervisor lifecycle accounting are transport behavior below the extension API.
## 2026-09-02 - Reap orphaned host dirs outside the endpoint lock

### What changed

- `packages/coding-agent/src/modes/rpc/host-ensure.ts` runs `reapOrphanedInternalHostDirs()` before `acquireOwnershipSafeLock()` instead of inside the locked section.
- `packages/coding-agent/test/rpc-host-ensure-lock-scope.test.ts` pins that ordering at the seam.

### Why

- The reaper's cost is unbounded in the size of the whole temp directory: it `readdir`s `tmpdir()` (measured: 132,035 entries, 394-467ms on a fast local SSD), then per `senpi-rpc-host-internal-*` candidate reads `.owner`, re-reads the directory, and calls `processMatchesPidFile()`. On win32 that last call spawns `powershell.exe Get-CimInstance` per candidate with a 1s default timeout. Running that opportunistic GC inside the exclusive endpoint lock made hold time scale with temp-directory size and PowerShell latency, so on the 4-vCPU `windows-latest` runner a concurrent `ensureHost` waiter could exhaust even the 42s lock budget and surface a raw `database is locked`. Raising the budget cannot fix a critical section whose cost is unbounded; the GC simply does not belong inside the lock.
- The reaper's own guards already make it safe unlocked: it only removes directories older than 60s whose owner pid is provably dead, so it never contends with the caller's own ensure.

### Why an extension could not handle it

- The reap runs inside the host handshake below the extension API.

### Expected merge conflict zones

- LOW: the `reapOrphanedInternalHostDirs()` / `acquireOwnershipSafeLock()` ordering at the top of `ensureHost`.
## 2026-09-02 - Size the ensure-host lock wait to the startup critical section

### What changed

- `packages/coding-agent/src/modes/rpc/host-ensure.ts` derives the ensure-lock wait budget (`ENSURE_LOCK_WAIT_MS`, 42s) from the longest critical section a holder can run - existing-host probe, incompatible-host stop (SIGTERM wait plus SIGKILL grace), then spawned-host readiness - instead of the previous 10s (100 x 100ms) constant that only covered a fraction of it. The stop/readiness/SIGKILL literals now share named constants with that derivation.

### Why

- Two concurrent `ensureHost` callers for one socket serialize on the SQLite ensure lock; when the first holder's section outlived 10s the second surfaced a raw `database is locked` instead of reusing the host. This flaked the Windows RPC named-pipes CI job (`serializes concurrent starts for one socket across agent directories`) and is the same failure a second interactive session would hit on a slow machine.

### Why an extension could not handle it

- The lock wait is part of the host handshake below the extension API.

### Expected merge conflict zones

- LOW: the constants block near the top of `host-ensure.ts` and the two `stopManagedHost` call sites.

## 2026-09-01 - Windows shared hosts use deterministic named pipes

### What changed

- `packages/coding-agent/src/modes/rpc/socket-transport.ts` maps every logical Windows socket path to `\\.\pipe\senpi-rpc-<sha256[:32]>`; POSIX filesystem and abstract socket addresses remain unchanged.
- `host-lifecycle.ts`, `multi-session-host.ts`, `host-ensure.ts`, and `rpc-client.ts` resolve that transport address at every listen/connect boundary while locks, settings, diagnostics, and CLI arguments keep the original logical socket path.
- Windows skips filesystem-only socket chmod/unlink cleanup; the pipe is kernel-owned and disappears when its listener closes. Each Windows client proves possession of a 32-byte owner-only secret before registration, and the secret-bound pipe name prevents blind endpoint collisions.
- `spawnableChildLaunch` in `host-lifecycle.ts` runs a `.cmd`/`.bat` `--child-command` through a shell and quotes its argv, so an embedder passes its launcher script VERBATIM. Windows refuses to spawn a `.cmd` without a shell, and Node's `shell: true` concatenates argv without escaping it, so the only alternative was for callers to pre-escape - which this spawn then escaped a second time, and the child arrived unrunnable.
- The supervisor's child and `RpcClient`'s child are spawned with `windowsHide`, so a console-less caller (GUI host, detached daemon) does not pop an empty terminal window.

### Why

- Node treats a Windows filesystem path passed to `net.Server.listen()` as an invalid pipe address and fails with `EACCES`. Both the private supervisor-to-host hop and the public shared endpoint used `.sock` paths, so no Windows shared host could start.
- A path hash gives independently launched clients and listeners the same bounded pipe name without publishing user paths into the global pipe namespace.

### Cleanup ownership

- The supervisor omits the logical Windows socket from watchdog cleanup because it is only an endpoint name, never a filesystem object owned by this process. The Windows boundary is the secret-derived pipe name plus the authenticated handshake; the profile directory's native ACL protects the secret file. Node's `readableAll`/`writableAll` options are not treated as a Windows DACL, and POSIX mode handling remains separate. `ensureHost()` removes abandoned POSIX internal scratch directories only after a recorded owner start-time check proves the owner is stale.
- A supervised Windows socket host keeps its normal close, runtime-dispose, and metadata-cleanup sequence, but applies a short hard-exit fallback. Win32 named-pipe instances can remain live after JavaScript sockets are destroyed and leave `server.close()` unresolved; the bounded fallback prevents a watchdog-triggered orphan from retaining the public endpoint indefinitely. POSIX watchdog cleanup remains awaited before the callback so filesystem-state assertions and ownership cleanup stay deterministic.
- The lifecycle supervisor uses the same bounded finalizer: after its child-stop, internal-directory, pidfile, and settings cleanup, it explicitly exits for every shutdown trigger, with a Win32 hard-exit fallback if any named-pipe handle prevents that sequence from completing. On Win32 it also polls the child process's recorded creation-time identity, so a child idle exit cannot be lost when the ChildProcess exit event is not delivered.
- The inherited supervisor pipe is the primary watchdog signal on Win32: its owned read stream uses automatic close and both `end` and `close` trigger teardown, while the slower identity fallback requires three consecutive missing probes so a timed-out PowerShell query cannot delay or spuriously trigger lifecycle cleanup.

### Why an extension could not handle it

- Socket address resolution happens before extensions or sessions exist and must be identical in the lifecycle supervisor, host, ensure probe, and SDK client.

### Expected merge conflict zones

- LOW: the net transport calls and filesystem cleanup guards in `host-lifecycle.ts` and `multi-session-host.ts`; one import and one `createConnection` expression each in `host-ensure.ts` and `rpc-client.ts`.

## [Unreleased] - Bound and join multi-session close_session teardown

### What changed

- `session-teardown.ts` bounds graceful `abort` -> idle -> dispose teardown by a 10-second default grace window (configurable with `SENPI_RPC_CLOSE_GRACE_MS`), then releases the entry and path reservation while detached cleanup continues and reports failures in the existing RPC stderr format.
- `session-command-router.ts` makes explicit close, idle eviction, and router disposal share one binding-finalization owner, so normal idle eviction still disposes the binding once while concurrent lifecycle paths join it.
- `session-event-writer.ts` preserves the first closer's terminal `session_closed` plus final response ordering and targets joined successful responses after that terminal sequence.
- `rpc-mode.ts` documents the bounded close and join response contract in the protocol table.
- A second `close_session` for an entry already `closing` joins the shared completion; the binding is disposed once, the first closer retains the terminal `session_closed` plus final response ordering, and joined callers receive targeted successful responses.

### Why

- A wedged abort previously retained the runtime and session-path reservation forever, while concurrent close requests incorrectly returned `unknown_session`.

### Why an extension could not handle it

- Session teardown deadlines, reservation ownership, and response ordering are host transport lifecycle behavior below the extension API.

## [Unreleased] - Isolate multi-session socket events by attachment

### What changed

- Files: `multi-session-host.ts`, `rpc-client.ts`, `session-event-fanout.ts`, `session-event-writer.ts`; the `RpcClientOpenInFlightError` re-exports in `packages/coding-agent/src/index.ts` and `packages/coding-agent/src/modes/index.ts`.
- Session agent events are delivered only to connections attached to that session; newly registered sockets no longer replay every session's in-flight snapshot.
- Attaching a connection replays that session's unrendered snapshot, plus rendered records when `rendered_components` is advertised.
- `session_closed` remains broadcast because it carries no content and observers rely on roster visibility.
- Lease-less `RpcClient` instances drop all session-tagged events until they open a session; during an in-flight `open_session`, matching startup events are buffered up to 512 records and 1 MiB of serialized JSONL, evicting oldest records first when either bound is exceeded.

### Why

- Shared multi-session socket hosts must not leak one session's assistant output into another session's client during normal operation or reconnect.

### Why an extension could not handle it

- Socket fan-out and client lease filtering are transport behavior below the extension API.

## [Unreleased] - Preserve launch capabilities for undeclared multi-session clients

- `session-command-router.ts`: connection-owned session bindings now fall back to the host launch capabilities when the client has not sent `set_client_info`; an explicit empty capability declaration still wins.

### Why

- Multi-session hosts launched with `extension_events` advertised the capability but did not forward extension events to clients that never declared capabilities, breaking omo-desktop-app subagent/monitor liveness since 2026-08-28.

### Why an extension could not handle it

- Capability negotiation and session binding creation are transport routing behavior beneath the extension API.

## 2026-09-01 - Negotiate RPC session auto-titling

- Added the `auto_title_sessions` client capability. RPC sessions auto-generate a title only when the client advertises support, while interactive defaults and resumed-session context guards remain unchanged.
- Advertised the capability from both classic and multi-session `get_protocol_info` responses.

## 2026-09-01 - Acknowledge RPC abort before quiesce

### What changed

- `packages/coding-agent/src/modes/rpc/connection-handler.ts` now dispatches the RPC `abort` signal without awaiting full session quiescence, acknowledges the command immediately, and observes later failures through the `rpc_error` event path. `abort_bash` and `abort_retry` remain unchanged because their dispatch methods are synchronous.

### Why

- Under host load, desktop stop clicks could appear delayed until the previous quiesce completed; the desktop adapter bounds abort acknowledgement at 10 seconds, so waiting for quiescence could surface `abort timed out` even after the abort signal had been delivered.

### Why an extension could not handle it

- RPC command acknowledgement ordering is owned by the transport connection handler, below the extension API.

### Expected merge conflict zones

- LOW: the `abort` command case in `connection-handler.ts`.

## 2026-08-31 - Ownership-safe RPC and app-server state locks

- Replaced proper-lockfile for the shared RPC-host and app-server daemon locks with a persistent regular SQLite lock file using `BEGIN EXCLUSIVE`; release commits and closes without unlinking.
- Legacy proper-lockfile lock directories fail closed as typed `ELEGACY_LOCK_ARTIFACT` errors and are never removed; a directory racing in between the stat guard and the open is also surfaced as the typed error.
- The lock opens through a runtime adapter: `bun:sqlite` inside the Bun binary, `node:sqlite` for npm-installed Node executions. Both drive the same kernel advisory locks, so cross-runtime contenders exclude each other; a static `bun:sqlite` import would break every Node entrypoint before command dispatch.
- Waiting uses ONE cumulative deadline (`retries.retries * retries.maxTimeout`, ~10s with the default profile). Each SQLite `busy_timeout` stays SHORT (<= maxTimeout) because it blocks the event loop synchronously - a long busy wait deadlocks a same-process holder mid-critical-section (caught by the ensureHost cross-agent-dir serialization test) - and the async inter-attempt sleep yields without extending the budget; the deadline is the only limit, so contention latency stays contract-equivalent to the old proper-lockfile profile.

## 2026-08-31 - Shared-host occupancy: idle eviction, session cap, empty-host exit

### What changed

- `session-registry.ts`: entries track `lastCommandAt` (refreshed by every routed command and by path attach), the registry exposes its live entry count, and `openSession` enforces an optional `maxSessions` admission cap (attach-on-open exempt) with the new `too_many_sessions` error code.
- `rpc-types.ts`: `too_many_sessions` joins the stable multi-session protocol error codes (`RPC_ERROR_TOO_MANY_SESSIONS` and the `RpcErrorCode` union member), so the session-cap failure is machine-matchable like every other routing error.
- `session-command-router.ts`: an optional `RpcSessionIdlePolicy` constructor argument arms an unref'd sweep that evicts sessions idle past `idleEvictionMs` through the existing `beginClose`→`closeMarked` path (all attachments drained, pending extension UI requests cancelled, `session_closed` broadcast). Eviction defers to the complete session activity contract (`AgentSession.isSessionBusy`: agent run, bash, background terminal jobs and other published wake sources, compaction, barrier-held session work), restarting the idle clock while work is live. It also fires a once-only `onEmptyExit` after `emptyExitMs` of continuous registry emptiness, gated by `canExitWhenEmpty`, and drops the writer's per-session bookkeeping for the evicted handle; `dispose()` stops the sweep.
- `session-event-writer.ts`: `forgetSession(sessionId)` drops the sealed-handle and snapshot entries for a handle whose runtime is fully disposed, so host-driven eviction no longer retains one sealed id per session for the process epoch.
- `multi-session-host.ts`: `createHostCore` is exported and resolves the policy from `SENPI_RPC_SESSION_IDLE_EVICTION_MS` / `SENPI_RPC_MAX_SESSIONS` / `SENPI_RPC_HOST_EMPTY_EXIT_MS` (defaults 30 min / 8 / 15 min) with explicit overrides for tests; both host flavors pass their shutdown path as `onEmptyExit`, and the socket host passes `canExitWhenEmpty` so a connected-but-sessionless client counts as occupancy. `MultiSessionHostOptions` gains an optional `createBinding` test seam (defaults to the real binding), mirroring the router's existing injection point.
- `host-lifecycle.ts`: `classifyChildExit()` treats a host that exits 0 without a signal as an intentional stop on its own idle policy (supervisor exit 0, same cleanup) instead of reporting `exited unexpectedly` and exiting 1; any non-zero code or signal remains a crash.

### Why

- The shared host reclaimed nothing without client cooperation: an abandoned session kept its full runtime, watchers, and transcript resident forever; `open_session` was unbounded (each open owns hundreds of MB; a measured desktop host reached 1.28 GB in 54 minutes); and an empty host lived until its pipe died. The supervisor only covers supervised socket hosts with zero connections, and it read the host's own clean idle exit as a crash - reachable whenever a client stayed connected without a session - so the intentional shutdown had to become part of the supervised contract rather than an exit-1 path.

### Why an extension could not handle it

- Idle accounting, admission, and host lifetime live in the routing and supervisor layers beneath every extension surface; extensions cannot observe routed-command timing, registry occupancy, or process exit classification.

### Expected merge conflict zones

- LOW: the registry options/entry tail in `session-registry.ts`, the router constructor tail plus the sweep/eviction methods in `session-command-router.ts`, `createHostCore` with the policy constants in `multi-session-host.ts`, the child-exit handler in `host-lifecycle.ts`, and the `forgetSession` accessor in `session-event-writer.ts`.

## 2026-08-30 - Shared-host rendered component capability lifecycle

### What changed

- `widget-line-renderer.ts`, `connection-handler.ts`, `rpc-types.ts`, `custom-capability.ts`, `host-ensure.ts`, `session-binding.ts`, `session-command-router.ts`, `session-event-writer.ts`, and `multi-session-host.ts` implement per-connection rendered-component delivery, capability-aware snapshot replay, shared width registration, and renderer/provider teardown and recreation.

### Why

- Shared socket clients can join or leave independently, so factory-rendered UI provenance, capability state, and live renderer resources must follow connection lifecycle without affecting surviving sessions or leaking footer watchers.

### Why an extension could not handle it

- These behaviors are transport routing, snapshot storage, and renderer ownership semantics beneath extension APIs; extensions cannot observe or control socket capability registration and disposal.

### Expected merge conflict zones

- LOW: the shared-host RPC connection options and capability routing in `connection-handler.ts`, `session-binding.ts`, and `session-command-router.ts`; socket registration in `multi-session-host.ts`; snapshot fanout in `session-event-writer.ts`; protocol declarations in `rpc-types.ts` and `custom-capability.ts`; host lifecycle in `host-ensure.ts`; renderer behavior in `widget-line-renderer.ts`.

## 2026-08-30 - Shared-host rendered components

- Added the `rendered_components` capability gate for factory-rendered widgets, headers, and footers. Shared-session component widths use the minimum reported width across attached connections, defaulting to 80 and dropping disconnected connections. Footer factories receive a session-backed readonly footer data provider. Interactive host startup records are buffered until the normal event listener is installed.
- Snapshot replay retains rendered-component provenance and filters it by each connection's session attachment and capability registration. Shared socket hosts never seed `rendered_components` from the host environment; clients register it with `set_client_info`, and must re-register width plus capabilities after reconnect. Shared bindings retain component factories while disposing live renderers and footer providers when no capable connection remains, recreating them for a later capable connection.

## 2026-08-30 - Deliver session events across a deferred rebind

### What changed

- `connection-handler.ts`: `rebindSession()` installs the session event subscription on the replaced session immediately after the swap, instead of only after the deferred derived-surface refresh completes, and the post-refresh install is removed - it would have re-subscribed and replayed the settings-source selection a second time, since `AgentSession.subscribe()` replays the current selection to every new listener. `installSessionSubscriptions` became a hoisted function declaration so the eagerly-run initial bind can reach it. The deferred refresh still reports its failure as `rpc_error`.

### Why

- A replacement swaps the live session and rebinds extensions afterwards, and that bind is deferred by design: awaiting it would deadlock a client whose `session_start` handler blocks on an `extension_ui_request` it cannot answer while still awaiting the replacement response. But the bind still mutates the session it owns - the pi-rules builtin appends a durable `pi-rules.scan` entry from `session_start` - and those entries were never forwarded, because the subscription was torn down at rebind start and reinstalled only once the bind finished. Nothing else can carry them: the session file is not written until an assistant message exists, so a client that misses the notification can never reconstruct the session it is bound to. Observed as the shared-host mirror ending one entry short after `new_session`, roughly one run in six under load.

### Why an extension could not handle it

- The event subscription belongs to the connection handler, beneath every extension surface; no extension hook can observe or reinstate it.

### Expected merge conflict zones

- LOW: the tail of `rebindSession()` and the `installSessionSubscriptions` declaration.

## 2026-08-30 - Classify RPC transport disconnects and recover shared interactive hosts

### What changed

- `rpc-client.ts`: `RpcClient` reports established socket disconnects through the new `onDisconnect` option and rejects sends with the exported `RpcTransportGoneError` (`code: "rpc_transport_gone"`) instead of exposing the raw `Client not started` message; `isTransportGoneError()` classifies both the typed error and legacy message shapes.
- Shared interactive runtimes make bounded reconnect attempts, re-open and refresh the attached session, and on exhaustion switch to the retained local runtime while surfacing only the standard fallback warning.

### Why

- The shared interactive host surfaced raw transport internals in the TUI whenever the host socket dropped; recovery orchestration needs a typed, once-only disconnect signal at the client boundary.

### Why an extension could not handle it

- The transport lifecycle lives inside `RpcClient` beneath every extension surface; no extension hook observes socket teardown or send gating.

### Expected merge conflict zones

- LOW: the `send()` guard block and socket close/error handlers in `rpc-client.ts`.

## 2026-08-30 - Expose session_replaced on the public client event union

### What changed

- `rpc-client.ts`: `RpcSessionReplacedEvent` joins the public `RpcClientEvent` union, so a typed client can discriminate `event.type === "session_replaced"` and read `durableSessionId` without casting. The runtime already forwarded the event through the unchecked `data as RpcClientEvent` cast in `handleFrame`, so it reached listeners untyped.
- `rpc-client.ts`: `collectEvents()` excludes it alongside the other non-session events it already filtered. It returns `JsonAgentSessionEvent[]`, and a replacement notice is connection-level rather than part of the agent's event stream.

### Why

- The command response for a replacement carries only `{ cancelled }`, and a replacement can be driven by another attached client or by an extension, so this event is the only channel delivering the new identity. A client that cannot narrow to it cannot resync.

### Why an extension could not handle it

- The client event union is protocol surface beneath every extension hook.

### Expected merge conflict zones

- LOW: the `RpcClientEvent` union members and the `collectEvents()` filter.

## 2026-08-30 - Require agentDir for the RPC project-trust gate

## 2026-08-30 - Carry the replacement identity as durableSessionId

### What changed

- `rpc-types.ts` / `connection-handler.ts`: `session_replaced` now carries `durableSessionId` instead of `sessionId`.

### Why

- Top-level `sessionId` is the per-connection routing handle, and `tagSessionRecord()` applies it last (`{ ...value, sessionId: routingSessionId }`). A multi-session host therefore overwrote the durable identity in the payload, leaving the event with no identity at all - the exact information it exists to deliver. In classic mode the untagged payload key also broke the pin that no classic line carries a top-level `sessionId`. Renaming to the vocabulary the D6 table already uses for `list_sessions` fixes both modes and keeps `sessionId` meaning exactly one thing on the wire.

### Why an extension could not handle it

- The event is emitted by the connection handler beneath the extension API; no extension hook can rewrite an outbound wire record.

### Expected merge conflict zones

- LOW: the `session_replaced` payload in `rebindSession()` and its interface in `rpc-types.ts`.

## 2026-08-30 - Reschedule the retained-queue drain when an enqueue races its settling

- `connection-handler.ts` now requires an authoritative `agentDir` when projecting RPC session state and reads project trust only from a fresh `ProjectTrustStore` lookup for the session's current cwd.
- The old `settingsManager.isProjectTrusted()` fallback is removed because that verdict can belong to a previous cwd after a session replacement. Missing `agentDir` now throws an explicit RPC session invariant error rather than silently selecting a stale trust verdict.
- RPC test doubles now provide temporary agent directories and seeded trust-store entries.

### Why

- Project trust gates project-source settings and resources, so the RPC state builder must never substitute a construction-time settings verdict for the current cwd's authoritative trust decision.

### Expected merge conflict zones

- LOW: `connection-handler.ts` project trust projection and RPC fixture setup.

## 2026-08-30 - Replacement broadcast reaches observers, not the issuer

- `connection-handler.ts`: `session_replaced` is emitted to every connection that did NOT
  issue the replacement, including classic (unrouted) ones. Previously the emission was
  gated on `routingSessionId !== undefined`, which silenced it for classic observers: a
  classic client attached while another actor swapped the runtime session kept routing at
  the old identity forever (`rpc-wire-provenance`: "broadcasts the replacement identity to
  an attached client after a runtime session swap" timed out).
- The suppression is now scoped to the ISSUER instead of the transport: a connection whose
  own `new_session`/`switch_session`/`fork`/tree command drove the replacement already
  receives the new identity in that command's response, and classic records must not carry
  a top-level `sessionId` key (`rpc-classic-compat` asserts this per command). Classic
  post-command rebinds go through `rebindAfterLocalReplacement()`, which raises
  `replacementIssuedHere` for the duration of that rebind only.
- Routed/shared-host behavior is unchanged: those connections still receive the broadcast.

## 2026-08-30 - Fail fast and report honest spawned-host readiness diagnostics

### What changed

- `host-ensure.ts` observes the spawned host's exit event during readiness polling and aborts immediately when the child exits before answering `get_protocol_info`.
- Readiness retains the last valid protocol answer so incompatible hosts report their advertised server version and capabilities alongside the expected values, while never-answered hosts retain the existing timeout message.
- Added coverage for early child exit and answered-but-incompatible protocol information.

### Why

- A host that exits before binding can never become ready, but previously consumed the full 10-second readiness budget. An incompatible answer was also incorrectly reported as a host that never answered, obscuring version and capability mismatches.

### Why an extension could not handle it

- Spawn lifecycle observation and readiness diagnostics happen inside the core shared-host startup path before any extension can run.

### Expected merge conflict zones

- LOW: `host-ensure.ts` readiness polling and its focused test coverage.

## 2026-08-30 - Launch the shared RPC socket host correctly from compiled binaries

### What changed

- `host-ensure.ts`: `defaultHostLaunch()` (now exported for tests) re-enters a compiled standalone binary through the hidden `--internal-rpc-host-supervisor` route instead of a `host-lifecycle` script path. A bun executable always boots its embedded entrypoint, so the script path was parsed as CLI arguments and the spawned supervisor died with `Unknown option: --socket`; every interactive launch then burned the full 10s readiness budget before printing the shared-host fallback warning.
- `host-lifecycle.ts`: the supervisor's default host spawn moved into the exported `resolveHostChildLaunch()`. In compiled binaries it drops `resolveCliMainPath()` and passes `--mode rpc --multi-session --listen` directly to the executable; explicit `--child-command` launches (desktop) are unchanged.
- `host-lifecycle.ts`: the internal launch route is now matched by the exported `findInternalSupervisorArgs()` bounded scan instead of a strict `args[0]` test in `main.ts`. A rebranded wrapper may prepend engine-global flags before re-dispatching (`packages/omo-native` injects `--extension <dir>` for every non-early command), which pushed the sentinel off `args[0]` so the route never fired and the helper died on `--socket` anyway. The scan accepts the sentinel at `args[0]` or preceded only by allowlisted `--extension <value>` pairs; a positional operand, `--`, an unknown flag, or a dangling prefix all disqualify it, so a user-supplied value equal to the sentinel can never reach the supervisor. The skipped prefix is not forwarded, because the wrapper re-injects its own on every re-entry.
- `main.ts`: dispatches through that scan and still fails closed (`exit(2)`) on a malformed payload rather than falling through to the public parser.
- QA: `scripts/qa-rpc-socket/compiled-host.mjs` drives the real `build:binary` output through a pty and asserts the shared host answers `get_protocol_info` without the fallback warning, reaping the detached supervisor on every exit path (SIGTERM then SIGKILL) so a failed run cannot leak a live host and a bound socket.

### Why

- No compiled distribution (release binaries, bundled/rebranded runtimes) could ever start the shared interactive host: the script-path re-entry only works when `process.execPath` is a JS runtime. Both spawn levels (ensure -> supervisor, supervisor -> host) had the same defect.

### Why an extension could not handle it

- The spawn shapes are core host-lifecycle wiring inside `ensureHost()` and the supervisor; no extension hook runs before the shared host is ensured, so an extension cannot intercept or rewrite the default launch.

### Expected merge conflict zones

- LOW: `defaultHostLaunch` in `host-ensure.ts`, the child spawn in `runHostSupervisor`, and the internal-route dispatch block in `main.ts`.

## 2026-08-30 - Reschedule the sink actor drain when an enqueue races its settling

- `socket-event-fanout.ts`: `SocketEventSinkActor.drain()` clears `draining` in a `.finally()` reaction. An `enqueue()` landing between the drain loop's exit and that reaction received the stale settled promise and started no new drain, leaving the record queued until the next unrelated enqueue rescued it — observed as targeted `open_session` responses reaching the client seconds late or not at all (`W-route` logged, `socket.write` never called). The `.finally()` now reschedules `drain()` when the queue is non-empty, so a racing record flushes immediately. Deterministic reproduction: `test/socket-event-fanout.test.ts`.

## 2026-08-30 - Resolve RPC project trust from the current session cwd

- `buildRpcSessionState` now reads the nearest saved project-trust decision from `ProjectTrustStore` for the session's current cwd instead of publishing the construction-time `SettingsManager` verdict from the previous cwd.
- An absent or false store decision remains untrusted, preserving the project-settings and project-resource gate.

### Why

- A shared RPC session can switch to a replacement cwd while its state is projected through a long-lived connection. Trust must follow the authoritative store entry for that replacement cwd rather than being inherited from the prior runtime.

## 2026-08-30 - Honor cwd overrides for multi-session switch_session

- `session-binding.ts` now binds the RPC connection handler to a live session runtime host, and `session-registry.ts` exposes the runtime's replacement-aware `switchSession` seam instead of treating the open-time runtime shape as the complete binding contract.
- `interactive-host-runtime.ts` forwards only the wire-supported `cwdOverride` when switching through the shared host, so the host's normal runtime replacement rebuilds settings and other cwd-bound state for the effective directory.
- `rpc-session-registry.test.ts` covers a replacement switch and verifies that the runtime and `list_sessions` report the override cwd.

### Why

- Multi-session bindings are created once at `open_session`; a later `switch_session` must reach the replacement-aware runtime method rather than remain coupled to the initial session-open runtime.

### Expected merge conflict zones

- LOW: `session-binding.ts` runtime host construction and `session-registry.ts` session runtime type.

## 2026-08-29 - Complete remote bash callback spill cleanup lifecycle

### What changed

- Harness output callbacks now reject through the shell-capture adapter so callback failures activate child-process cancellation instead of being reported as fulfilled execution.
- Normal bash completion waits for callbacks up to a documented 5-second bound; cancellation retains its shorter abandonment path.
- A proxy reattach aborts host bash executions that cannot be correlated to the new connection's callback map.
- Remote spill cleanup falls back to best-effort local removal when the host transport is unavailable.

### Why

- Callback failures must terminate the child promptly, normal completion must not hang forever on a broken observer, and detached/reconnected clients must not strand host-owned spill files or in-flight executions.

### Why an extension could not handle it

- Process cancellation, RPC transport ownership, and reattach correlation are runtime lifecycle concerns below extension callbacks.

### Expected merge conflict zones

- `packages/agent/src/harness/env/nodejs.ts`, `packages/agent/src/harness/utils/shell-output.ts`, `bash-executor.ts`, and `interactive-host-runtime.ts`.

## 2026-08-29 - Namespace remote bash callback executions

### What changed

- `packages/coding-agent/src/modes/rpc/rpc-client.ts` carries execution-scoped bash cleanup requests across attached client proxies.
- `packages/coding-agent/src/modes/rpc/rpc-types.ts` carries namespaced execution IDs and cleanup requests across the RPC boundary.

### Why

- Attached interactive clients share session event broadcasts; local IDs could collide and route output callbacks across clients, while a client-side callback failure could leave a host-owned spill after successful host completion.

### Why an extension could not handle it

- RPC routing and host spill ownership are transport lifecycle concerns below extension callbacks.

### Expected merge conflict zones

- `rpc-client.ts`, `rpc-types.ts`, and `connection-handler.ts` bash command handling.

## 2026-08-28 - Hydrate unnamed deferred setup entries

- `get_state` ships deferred (not-yet-persisted) session entries whenever the session holds any entry beyond the auto-appended bootstrap kinds (`model_change`, `thinking_level_change`), no longer gated on a session name, so unnamed custom-only setup mutations hydrate the shared-host proxy mirror before the first provider turn. Plain fresh sessions still omit `entries`, preserving classic/socket state parity; a setup that appends ONLY a bare model/thinking change (and nothing else) stays host-side until the first turn.

## 2026-08-28 - Preserve derived state for verbatim setup entries

- Added the public `SessionManager.appendEntry()` transport seam. It preserves captured entry IDs, timestamps, and parent IDs while updating session names, labels, usage, and message identity tracking.
- The RPC append handler now uses that seam instead of the private `_appendEntry()` implementation.
- `get_state` carries authoritative entries so setup-only sessions remain inspectable before deferred persistence creates a file.

## 2026-08-28 - Dropped-connection release defers while a turn is streaming

### What changed

- `session-command-router.ts`: `releaseConnection()` now checks the live entry
  (`registry.peek`) and, when the owned session's turn is still streaming,
  defers the refcounted close until `agent_settled`/`agent_idle` via a one-shot
  session subscription instead of tearing the runtime down immediately. Idle
  sessions release exactly as before. The per-session guarded close moved into
  `releaseOwnedSession()`; the deferred path reuses it and tolerates races with
  an explicit `close_session` (beginClose already-closed guard).
- `session-registry.ts`: added the read-only `peek(handle)` lookup (no state
  transitions, no attachment accounting) for lifecycle decisions.

### Why

- The 2026-08-28 release-a-dropped-connection's-sessions change closed owned
  sessions on socket close even mid-turn. That aborts the run and seals the
  session before `agent_settled` reaches the host-lifecycle observer, leaking
  the busy-session counter, so the supervisor saw a permanently active turn and
  the host never idle-exited (`rpc-host-lifecycle` "does not exit while a turn
  is active" turned red on main). Deferring - never skipping - keeps both
  contracts: the headless turn runs to completion, and the dead owner's path
  reservation still frees right after settlement.

## Terminal monitor snapshots ride `extension_event` (2026-08-28)

### What changed

- The terminal builtin now calls `pi.rpc.emit("terminal_monitor_state", payload)`
  alongside the existing in-process event. Connection-handler forwarding is
  unchanged: clients that advertised `extension_events` receive
  `{ type: "extension_event", name: "terminal_monitor_state", data }`.

### Why

- Ordinary `pi.events` channels stay extension-local. Monitor liveness was
  therefore invisible to RPC clients even though the snapshot existed in-process.

### Why an extension could not handle it

- The emit lives in the terminal builtin; the RPC host already forwards every
  `pi.rpc.emit`. No connection-handler or schema change is required.

### Expected merge conflict zones

- LOW: `docs/rpc.md` `extension_event` section (payload example).

## Prompt disposition rides the wire and sessions attach by path (2026-08-28)

### What changed

- `connection-handler.ts`: the `prompt` success response now carries `data.disposition` (`started`/`queued`/`handled`), captured from the host session's own `promptDisposition` callback, which always fires strictly before `preflightResult(true)`.
- `rpc-types.ts`: the prompt success response gains the additive optional `data.disposition` field; older hosts omit it and clients degrade to canonical-only rendering.
- `rpc-client.ts`: pending requests accept `onResponse`/`onReject` hooks that run synchronously inside frame dispatch (before the next frame), so ordering-sensitive contracts never route through a resolved promise's microtask. `prompt()` takes an options object (`images`, `streamingBehavior`, `thinkingLevel`, `promptDisposition`, `preflightResult`); a success response without a disposition maps to `"handled"`, and transport rejection/timeout reports `preflightResult(false)`.
- `session-registry.ts`: `openSession` with a path reserved by a live, fully-open session now ATTACHES (same handle, `attached: true`, attachment count incremented) instead of throwing `session_path_in_use`. Entries still opening or closing keep the exclusive reservation. `beginClose` releases one attachment and only transitions to `closing` when the last one closes.
- `session-command-router.ts`: close paths finalize the runtime teardown only when the entry actually transitioned to `closing`; `open_session` responses include `attached: true` on attach.

### Why

- Interactive sessions run through the shared host by default; the proxy's dropped disposition callbacks left optimistic user echoes permanently ineligible, so every canonical user message rendered twice. The attach semantics make resume of a host-held session possible at all — previously any live attachment (desktop app, second terminal) made `open_session` throw by construction.

### Why an extension could not handle it

- Wire framing, response dispatch order, and the process-local session registry are core RPC contracts established before extensions load.

### Expected merge conflict zones

- MEDIUM: `session-registry.ts` openSession/beginClose attachment semantics.
- LOW: `connection-handler.ts` prompt case, `rpc-client.ts` prompt options, `rpc-types.ts` additive response field.

## Provider-neutral account RPC commands (2026-08-27)

### What changed

- `packages/coding-agent/src/modes/rpc/connection-handler.ts`: `get_provider_accounts`, `account_pin`, and `account_remove` now dispatch to `core/credential-accounts.ts` instead of the claude-sdk-oauth lane's account management, so they work for every provider. An unknown provider returns an empty account list instead of the previous `Provider account management is unavailable for: ...` error.

### Why

- Generic credential pools make account management meaningful for any provider; the hard rejection existed only to confine the surface to one lane.

### Why an extension could not handle it

- The RPC command dispatch table is core connection handling; extensions cannot re-route it.

### Expected merge conflict zones

- LOW: three case arms in the account command section.

## Shared RPC client transport and protocol surface (2026-08-27)

### What changed

- `rpc-client.ts` adds socket transport and shared-host client operations for connection-aware multi-session use.
- `rpc-mode.ts` and `rpc-types.ts` preserve the classic JSONL RPC surface while adding the protocol and capability metadata needed for attach-compatible hosts.

### Why

- Socket-host clients need one typed transport and a stable protocol handshake while existing stdio RPC integrations remain compatible.

### Why an extension could not handle it

- RPC framing, transport selection, protocol negotiation, and command/event types are built-in mode contracts established before extensions load.

### Expected merge conflict zones

- MEDIUM: `rpc-client.ts` transport methods and `rpc-types.ts` protocol unions.
- LOW: `rpc-mode.ts` additive protocol response wiring.

## One lifecycle supervisor across CLI and desktop runtimes (2026-08-25)

- The hidden `--internal-rpc-host-supervisor` CLI route exposes the existing `host-lifecycle.ts` entry to bundled/rebranded callers without changing any public mode. Its socket, agent directory, and child command/args are explicit parameters, so desktop cold starts execute the same proxy, policy, observer, watchdog, pidfile, and cleanup implementation as `ensureHost()`.
- Updated `host-lifecycle.ts` argument parsing to accept those internal parameters while retaining the existing default launch for senpi callers.

Expected merge conflict zones: MEDIUM in `main.ts` and `host-lifecycle.ts`; LOW in `docs/rpc.md`.

## RPC host lifetime is bound to its supervisor at the OS level (2026-08-25)

### What changed

- Added `packages/coding-agent/src/modes/rpc/host-watchdog.ts`: an opt-in watchdog that shuts the RPC host down when its lifecycle supervisor dies. The primary binding is EOF on an inherited pipe (`SENPI_RPC_HOST_WATCH_FD`); `SENPI_RPC_HOST_WATCH_PPID` polling is a fallback for platforms that do not inherit the extra fd. On fire, the host removes the supervisor's private internal directory (`SENPI_RPC_HOST_SCRATCH_DIR`) and runs its normal clean shutdown.
- `host-lifecycle.ts` now spawns the host with `stdio: ["ignore", "ignore", "inherit", "pipe"]`, holds the write end open without ever writing, and exports the three watchdog variables to the child.
- `multi-session-host.ts` arms the watchdog in the socket-host boot path only when those variables are present, so plain `senpi --mode rpc`, embedders and hand-started hosts are byte-identical to before.
- QA: `scripts/qa-rpc-socket/host-lifecycle.mjs` gained a fourth scenario that `kill -9`s the supervisor and asserts the internal host is reaped and its private directory removed; focused tests cover the same end to end plus the watchdog's configuration and EOF paths.
- Closed two smaller windows in the supervisor that leaked the private directory (empty, no socket, no process) without leaking the host: the SIGTERM/SIGHUP handlers are now registered before the startup handshake rather than after it, and the private directory is unlinked before the multi-second child stop, so an external SIGKILL during that wait (`ensureHost` escalates while replacing a host) cannot strand it.

### Why

- `stopChild()` only runs on catchable-signal paths. A `SIGKILL`, OOM kill, or supervisor crash left the internal host as a permanent orphan (PPID 1, ~240 MB resident) still serving RPC on a leaked private socket with no idle-exit logic to ever reap it, since all of that logic lived in the dead supervisor. A lifetime binding has to be enforced by the OS, not by handlers that a dying process never gets to run.

### Why an extension could not handle it

- Inherited file descriptors, process-lifetime binding and private socket-directory ownership are transport lifecycle responsibilities below extension hooks.

### Expected merge conflict zones

- MEDIUM: the `spawn()` options in `host-lifecycle.ts`.
- LOW: the watchdog arming call in `multi-session-host.ts`, `docs/rpc.md`, the QA script and focused tests.

## Shared RPC socket host lifecycle policy (2026-08-24)

### What changed

- Added `packages/coding-agent/src/modes/rpc/host-lifecycle.ts`: the lifecycle supervisor `ensureHost()` now spawns instead of the CLI directly. It owns the public socket, spawns the real `--mode rpc --multi-session --listen` host on a private internal hop under a 0700 temp directory, and byte-proxies every client connection, which yields exact connection counts without touching the host itself.
- Cold-start policy + idle-exit window: `ensureHost()` records `coldStart` (`transient` default, `persistent` opt-out) and `idleExitMs` (default 15 min) in `rpc-host-daemon/settings.json` before spawning; runtime overrides come from `SENPI_RPC_HOST_COLD_START` and `SENPI_RPC_HOST_IDLE_EXIT_MS`. After a continuous window with zero client connections and zero active turns the supervisor tears the host down cleanly (host SIGTERM first so pending output flushes, then pidfile/settings/socket removal mirroring `ensureHost()`'s cleanup semantics), and the next `ensureHost()` transparently starts a fresh host.
- Active turns are observed through an always-on observer connection to the internal host: the all-sessions broadcast delivers `agent_start`/`agent_settled` per routing session even with no client attached, and any activity resets the window, so the host never exits mid-turn or while a client is attached. An unhealthy observer reports as non-idle (can only keep the host alive).
- `packages/coding-agent/src/modes/rpc/host-ensure.ts` gained the `policy` option, pre-spawn settings persistence, `_test.env`/`_test.hostArgs` passthrough, and supervisor-based default launch; external SIGTERM/SIGHUP to the supervisor performs the same clean teardown.
- QA: `packages/coding-agent/scripts/qa-rpc-socket/host-lifecycle.mjs` drives the real CLI through short idle windows (idle exit + re-ensure new pid, held active turn past the window, persistent never-exits).

### Why

- The shared socket host previously lived until the machine rebooted: desktop/terminal clients needed a documented way to bound a `transient` host's lifetime without a resident supervisor process, while `persistent` installs must survive idle periods.

### Why an extension could not handle it

- Host process lifetime, socket ownership, pidfile/state cleanup, and detached process supervision are transport lifecycle responsibilities below extension hooks; the RPC host itself must stay unaware of its supervisor.

### Expected merge conflict zones

- MEDIUM: `host-ensure.ts` spawn/settings path and `host-lifecycle.ts` (new fork-only supervisor).
- LOW: `docs/rpc.md` lifecycle section, focused lifecycle tests, and the QA script.

## Client-side ensureHost RPC socket lifecycle (2026-08-24)

### What changed

- Added `ensureHost()` with a `rpc-host-daemon/{host.pid,daemon.lock,settings.json,stderr.log}` state layout, proper-lockfile serialization, protocol/version/capability occupancy probing, validated PID/start-time replacement, detached current-CLI launch, bounded readiness, escalation, and stderr diagnostics.
- Added additive `serverVersion` and negotiated capability fields to `get_protocol_info`; ensured hosts pin `extension_events` (and `custom_unsupported`) in their launch environment regardless of which client starts them first.
- Exported the ensure API for client-side callers and added deterministic lifecycle tests plus real-CLI QA.

### Why

- Desktop and terminal clients need one reusable Unix-socket host without a resident supervisor, while preventing incompatible or capability-poor processes from silently owning the shared endpoint.

### Why an extension could not handle it

- Process ownership, Unix-socket probing, PID-reuse safety, file locking, detached launch, and protocol handshake are transport lifecycle responsibilities below extension hooks.

### Expected merge conflict zones

- MEDIUM: `host-ensure.ts` and the additive `get_protocol_info` response in `session-command-router.ts`.
- LOW: RPC exports, protocol documentation, and focused lifecycle/QA coverage.

## Concurrent Unix-socket host for multi-session RPC (2026-08-23)

### What changed

- `packages/coding-agent/src/modes/rpc/multi-session-host.ts` accepts file and abstract Unix socket listeners, keeps one host-global registry/router across concurrent connections, isolates each connection's inbound JSONL framing and correlated outbound responses, and survives malformed or dropped clients.
- `packages/coding-agent/src/modes/rpc/session-event-writer.ts` retains its single-sink stdio adapter while adding connection-aware sinks: session lifecycle/agent events broadcast to all current connections with `sessionId`, while responses and extension UI records return only to the issuing connection without bypassing buffered backpressure.
- `packages/coding-agent/src/modes/rpc/session-command-router.ts` returns `unknown_session` when a live registry entry has no global binding instead of silently swallowing the command.

### Why

- Desktop and automation clients need multiple independent socket connections to share sessions, route commands across connection ownership, and observe foreign session activity without running one RPC process per client.

### Why an extension could not handle it

- Listener ownership, JSONL framing, routing handles, response correlation, event fan-out, and transport backpressure are built-in RPC host responsibilities below extension hooks.

### Expected merge conflict zones

- HIGH: `multi-session-host.ts` host lifecycle and `session-event-writer.ts` scheduling/sink selection.
- LOW: the missing-binding guard in `session-command-router.ts`.

## Suppress initial command-surface invalidation events (2026-08-17)

### What changed

- RPC records the initial ordered command digest without publishing `commands_changed`.
- Later distinct command snapshots still publish once, while identical reload snapshots remain deduplicated.
- Focused coverage distinguishes baseline initialization from an actual post-bind command-surface change.

### Why

- Discovery sessions already fetch their initial command surface with `get_commands`. Treating that baseline as an
  invalidation made clients refresh provider discovery, whose new sessions emitted another baseline invalidation and
  created an unbounded refresh loop.

### Why extension system couldn't handle this

- Baseline establishment and JSONL event emission are owned by the built-in RPC transport.

### Expected merge conflict zones

- LOW: `rpc-command-surface.ts` initial-digest guard and its focused regression.

## Publish typed command surfaces and invocation events without disturbing MCP inventory (2026-08-16) ([PR #909](https://github.com/code-yeongyu/senpi/pull/909))

### What changed

- RPC exports self-describing `RpcSlashCommand` rows with canonical `syntax`, pushes ordered `commands_changed`
  snapshots after initial bind and runtime reloads, and publishes typed `command_invocation` metadata only after the
  session actually resolves an extension command or an accepted prompt template survives extension input interception.
- RPC continues to export `RpcSkillInvocationEvent` with ordered `{name,path,syntax}` entries.
- The classic and routed connection handler explicitly type-checks `skill_invocation` and `command_invocation` before
  forwarding them through the existing event buffer.
- Prompt, steer, and follow-up text fields reject inputs above one million characters before session dispatch.
- Classic and multi-session hosts reject valid non-object JSON with parse-style responses instead of dereferencing it
  as a command, and both enforce a 16 MiB JSONL record ceiling that discards one oversized record through LF before
  resuming framing.
- Regression coverage proves candidate ordering, update deduplication, post-interception command classification,
  bounded text and record handling, malformed-command rejection, JSONL resynchronization, and skill event delivery
  while `get_loaded_surfaces` keeps the same revealed MCP inventory before and after invocation.

### Why

- OmO Desktop can render and refresh the same mixed command/skill picker without terminal parsing or command-surface
  polling, and can observe accepted command or skill invocations as typed metadata.
- Skill expansion must remain orthogonal to MCP inventory reveal; a new event cannot reset or reorder loaded
  surfaces.

### Why extension system couldn't handle this

- The public JSONL event contract and loaded-surface inventory response are owned by the built-in RPC transport.

### Expected merge conflict zones

- LOW: additive event types in `rpc-types.ts`, `rpc-command-surface.ts`, and `rpc-command-invocation.ts`.
- MEDIUM: `connection-handler.ts`, `rpc-mode.ts`, `multi-session-host.ts`, `rpc-input-validation.ts`, and `jsonl.ts`
  own command-surface invalidation, input/framing bounds, and typed event forwarding.
- LOW: focused RPC contract tests plus `rpc-loaded-surfaces.test.ts` inventory assertions.

## Settings source selection event (2026-08-16)

### What changed

- Classic and multi-session RPC now receive the additive `settings_source_selected` session event with `{ path, format, reason, scope }` at startup/rebind and after settings reload selection.
- The public RPC type surface documents the event; existing session forwarding and routing remain unchanged.

### Why

- Headless clients need to know whether JSONC won precedence and which path subsequent settings writes target.

### Why the extension system could not handle this

- The source is selected before extension binding, while RPC framing/routing is host-owned.

### Expected merge conflict zones

- LOW: additive event typing in `rpc-types.ts`; event forwarding uses the existing unfiltered session subscription.

## Model/tier events, fast-mode commands, and turn-scope validation (2026-08-16)

### What changed

- Additive events `model_changed` (model + post-switch thinking level + source) and `service_tier_changed` (tier + fastMode) reach clients through the existing session subscription; no event is reshaped.
- `RpcSessionState` gained `serviceTier?` and `fastMode`, so `get_state` no longer hides which tier a request would carry.
- `get_state` and `open_session` now project state through one exported `buildRpcSessionState(session)`. They were two hand-rolled literals, and only the `get_state` one was type-annotated, so `open_session` silently answered without the new fields.
- New commands `set_fast_mode` / `get_fast_mode` delegate to `applyFastMode` from the service-tier extension module — the same entry point the `/fast` command uses, so persistence and `-fast` key normalization exist once.
- `scope: "turn"` `set_thinking_level` now validates the level against `getAvailableThinkingLevels()` BEFORE applying it. Previously it applied first and reported the mismatch afterwards, so a rejected request left the session on the clamped level.
- `RpcClient` gained `setFastMode`/`getFastMode`, and `setThinkingLevel` accepts `{ scope: "turn" }` and now throws on a failed response instead of swallowing it.

### Why

- Clients had no way to observe model or tier changes: model tracking was inferred from `entry_appended`, and fast mode was invisible to the protocol even though it changes what is sent upstream.
- A command that answers `success: false` after mutating state is unusable for state reconciliation — the client's retry/rollback logic cannot know what actually happened.

### Why extension system couldn't handle this

- The command union, `RpcSessionState`, and the event projection are transport contracts owned by the RPC mode; extensions cannot add commands or state fields to them.

### Expected merge conflict zones

- LOW: additive union arms in `rpc-types.ts` and additive `case` arms in `connection-handler.ts`.
- LOW: the `set_thinking_level` case body is rewritten in place (validate-then-apply).
- LOW: `session-command-router.ts` `open_session` now calls the shared state builder instead of inlining the literal. Session test doubles must answer `isFastModeActive()`.

## Pin classic RPC delta batching and immediate barriers (2026-08-14)

### What changed

- Characterization coverage now proves 1000 classic delta-only `message_update` records remain complete while sharing one same-tick raw write.
- Event, extension-UI request, event, and response ordering is pinned across consecutive immediate-write barriers.
- Classic connection-handler backpressure remains deliberately attached to every agent-loop event.

### Why

- Classic RPC projects cumulative assistant updates into delta-only public wire records. Those deltas cannot be compacted safely, so per-event backpressure is its flow control and must not be removed as part of the multi-session writer redesign.
- `RpcClient` consumers depend on the documented delta sequence and on immediate UI/response records never overtaking pending events.

### Why extension system couldn't handle this

- Classic JSONL projection, batching, and agent-loop backpressure are built-in RPC transport contracts below extension hooks.

### Expected merge conflict zones

- LOW: characterization-only additions in `rpc-event-coalescing.test.ts`.
- NONE: classic runtime code remains unchanged.

## Single-flight multi-session RPC drain and control lane (2026-08-14)

### What changed

- The multi-session writer now hands exactly one complete record to stdout, awaits backpressure, and then selects the next ready session in round-robin order.
- Untagged host responses use a dedicated non-coalescing control lane, and shutdown waits for all retained and in-flight records before flushing raw stdout.
- Deterministic buffered-record/byte counters include the in-flight record, control enqueues resolve after their own backpressure boundary, and permanent stdout failures reject the active drain and pending control completions.

### Why

- Direct host response writes could bypass session ordering, while synchronous queue draining still fed an unbounded downstream promise chain during stdout stalls.
- Keeping the backlog in typed lanes lets per-session compaction remain effective and prevents one busy session from monopolizing the raw writer.

### Why extension system couldn't handle this

- Process-wide stdout ownership, host control responses, session fairness, and shutdown flushing are built-in RPC transport responsibilities.

### Expected merge conflict zones

- HIGH: `session-event-writer.ts` drain lifecycle and constructor contract.
- MEDIUM: `multi-session-host.ts` output and shutdown wiring.
- LOW: deterministic multi-session drain tests.

## Compact cumulative multi-session RPC events per session (2026-08-14)

### What changed

- Multi-session RPC queues now retain structured records until drain time and compact cumulative assistant snapshots within each session and ordering segment.
- Superseded full snapshots keep their delta while replacing cumulative `message` and `partial` fields with present `null` values; adjacent compatible deltas merge, and the newest update remains the sole full snapshot.
- Tool progress is latest-wins per tool-call id, with retained updates appended in occurrence order. Protocol, lifecycle, error, delta-only, and unknown records remain barriers and are never coalesced.

### Why

- Long cumulative assistant snapshots produced quadratic queued bytes when a desktop RPC reader stalled, causing visible freezes followed by large output bursts.
- Delta content and transition boundaries must remain lossless, while repeated cumulative snapshots and accumulated tool progress are redundant before they reach stdout.

### Why extension system couldn't handle this

- Session tagging, JSONL framing, and pending stdout scheduling are owned by the built-in multi-session RPC transport below extension hooks.

### Expected merge conflict zones

- MEDIUM: `session-event-writer.ts` queue representation, compaction keys, and drain serialization.
- LOW: focused multi-session event-writer tests.

## Extension request RPC command (2026-08-12)

### What changed

- Added the session-scoped `extension_request` command and structured success/error response.
- `RpcClient.requestExtension()` exposes the command through the public client.
- Existing multi-session routing tags the response with the owning `sessionId`.

### Why

- Capability-gated `extension_event` records cover extension-to-client state, but interactive
  extension controls also need a direct client-to-extension request path that does not become a
  model prompt.

### Why extension system couldn't handle this

- Request ids, multi-session routing, JSONL response serialization, and public client correlation
  are owned by the built-in RPC transport.

### Expected merge conflict zones

- MEDIUM: `rpc-types.ts`, `connection-handler.ts`, and `rpc-client.ts`.

## Multi-session open failure details (2026-08-07)

### What changed

- Multi-session `open_session` failures retain the typed `open_failed` registry code while returning the underlying
  error message on the wire as `open_failed: <reason>` when one is available.
- All other stable RPC error codes remain exact strings without detail suffixes.

### Why

- The registry rollback path discarded the runtime/session construction error, leaving RPC clients with a bare
  `open_failed` response that did not identify invalid workspace directories or other actionable causes.

### Why extension system couldn't handle this

- Multi-session lifecycle errors and JSONL response serialization are owned by the built-in RPC transport and are not
  exposed through extension hooks.

### Expected merge conflict zones

- LOW: `session-registry.ts` error construction and `session-command-router.ts` registry-error serialization.

## high_reasoning_warning RPC event (2026-07-30)

- New `RpcHighReasoningWarningEvent` contract (`{ type: "high_reasoning_warning"; modelId; provider; thinkingLevel }`), auto-published to RPC stdout via the existing `session.subscribe -> outputEvent` seam. No new wiring; the event is a session event forwarded like `thinking_level_changed`.

## Credential-header auth status sources (2026-07-29)

### What changed

- `rpc-types.ts` mirrors the new `models_json_headers` and `extension_headers` auth-status sources emitted by the
  model runtime. `get_auth_providers` can now distinguish static header credentials from API-key values without
  exposing any credential material.

### Why

- The RPC status type must remain structurally identical to the core auth status returned by
  `getProviderAuthStatus()`; otherwise header-auth providers type-check in core but fail response assembly.

### Expected merge conflict zones

- LOW: additive string literals in `RpcAuthStatus.source`.

## Claude Agent SDK provider-account RPC events (2026-07-27)

### What changed

- Added additive `get_provider_accounts`, `account_pin`, and `account_remove` commands. Account payloads expose only slot name, source, blocked state, and pin state; credential material never crosses RPC.
- Added `auth_accounts_changed` and `account_failover` events. The failover engine remains UI-free and reports through its callback seam; the RPC connection subscribes to the provider-account event bus.
- The app-server mirrors the surface with `account/providerAccounts/read`, `/pin`, and `/remove`, plus `account/providerAccounts/updated` and `/failover` notifications. These Senpi additions intentionally remain separate from the pinned Codex method catalog.

### Why

- The desktop app needs account-pool state and automatic failover visibility without reading auth storage or receiving subscription tokens.

### Why extension system couldn't handle this

- JSONL RPC command dispatch and app-server protocol registration are mode-owned transport surfaces. The desktop consumer contract at `../omo-desktop-app/packages/contracts/src/rpc.ts` is updated separately.

### Expected merge conflict zones

- MEDIUM: `connection-handler.ts` command dispatch and event subscriptions.
- LOW: app-server account handlers and protocol facade additions.

## Removed legacy `--neo` daemon support while preserving RPC contracts (2026-07-26)

### What changed

- Removed the legacy daemon, protocol, registry, child-worker, and runtime-option modules.
- Retained the standard RPC connection handler and capability contract, with generic authentication and JSONL framing coverage migrated into the kept suite.

### Why

- The supported RPC surface is the standard `--mode rpc` host, not the retired Go TUI daemon.

### Expected merge conflict zones on next upstream sync

- LOW: removal-only changes beside retained RPC infrastructure.

## Model-fallback event pass-through (2026-07-20)

### What changed

- `test/suite/rpc-fallback-events.test.ts` verifies that a faux-provider fallback run sends
  `retry_fallback_applied`, `retry_fallback_succeeded`, and `retry_fallback_exhausted` as LF-delimited RPC JSONL events.

### Why

- RPC forwards complete `AgentSessionEvent` payloads without an event whitelist; this test preserves that contract as
  model-fallback lifecycle events evolve.

### Expected merge conflict zones on next upstream sync

- LOW: test-only coverage of the existing connection-handler event subscription.

Fork tracker for `src/modes/rpc/` — this directory exists upstream, so every
fork change here is a merge-conflict surface on upstream syncs.

## System-prompt options threaded through NeoRuntimeOptions (2026-07-18)

### What changed

- `neo-runtime-options.ts`: `NeoRuntimeOptions` gained `systemPrompt` /
  `appendSystemPrompt`, both added to `NEO_RUNTIME_OPTION_SOURCE_FIELDS` so the
  extraction test covers them.
- `neo-runtime-options-argv.ts`: the daemon re-emits them as `--system-prompt`
  and repeated `--append-system-prompt` in the per-connection worker argv.
- Go mirror: `packages/neo/internal/bridge/runtimeopts.go` gained the matching
  payload fields and `--system-prompt` / `--append-system-prompt` parse entries.

### Why

- `main.ts` consumes `parsed.systemPrompt` / `parsed.appendSystemPrompt` in the
  runtime-construction path (`resourceLoaderOptions`); without handshake fields a
  neo client silently lost both flags when going through the shared daemon.

### Why extension system couldn't handle this

- The handshake payload and daemon worker argv are fork protocol surfaces, not
  extension hooks.

### Expected merge conflict zones on next upstream sync

- LOW: all touched modules are fork-only.

## Auth RPC commands and capability-gated custom-UI notice (2026-07-06)

### What changed

- `rpc-mode.ts` / `rpc-types.ts`: added additive RPC commands for the neo
  login/logout UI — `get_auth_providers`, `login_start`, `login_cancel`,
  `login_api_key`, `logout`. Login completion is delivered via events only
  (`auth_login_url`, `auth_login_end`): `login_start` responds
  `success: true` immediately because the 30s request timeout cannot span an
  interactive OAuth round-trip.
- Third-party `ctx.ui.custom` gained an additive, capability-gated
  `extension_ui_request` notice: only clients that advertised the
  `custom_unsupported` capability receive it; default RPC clients see
  byte-identical behavior.

### Why

- The neo Go TUI drives login/logout over RPC and needs the provider list,
  OAuth URL delivery, and terminal results without holding a request open.

### Why extension system couldn't handle this

- RPC command dispatch and the wire protocol live in the built-in RPC mode;
  extensions cannot add RPC commands or events.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `rpc-mode.ts` command dispatch and event emission.
- LOW: `rpc-types.ts` around the added command/event unions.

## Neo daemon serving (2026-07-06)

### What changed

- `rpc-mode.ts`: command handling was extracted into `connection-handler.ts`
  (injected output sink, no stdout takeover or process signal coupling).
  Classic `--mode rpc` stdio behavior is unchanged.
- Fork-only daemon modules: `neo-daemon-mode.ts` (supervisor that binds the
  unix socket first — bind is the spawn-race mutex — and serves one child RPC
  worker process per connection), `neo-daemon-child-worker.ts`,
  `neo-daemon-protocol.ts` (hello/welcome/refuse token+version handshake
  carrying typed `NeoRuntimeOptions`), `neo-daemon-registry.ts` (atomic
  temp+rename self-registration under `~/.senpi/agent/neo-daemon/`, 0600,
  stale pid/socket cleanup), `neo-runtime-options.ts` /
  `neo-runtime-options-argv.ts`, and `custom-capability.ts`. Launch-side
  plumbing lives in `cli/neo/` (see `cli/changes.md`).

### Why

- The shared neo daemon needs N concurrent RPC runtimes; two process-global
  blockers (pi-ai's global provider registry resets, pi-agent-core's
  module-level UUIDv7 counter) make in-process multi-runtime unsafe, so each
  connection gets an isolated worker process (see `docs/neo.md`).

### Why extension system couldn't handle this

- Mode entrypoints, stdout ownership, and process lifecycle are core mode
  plumbing outside extension reach.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `rpc-mode.ts` around the extracted connection handler seam.
- LOW: `connection-handler.ts` and `neo-daemon-*.ts` (fork-only files).

## RPC event write coalescing and output hot paths (2026-06-13)

### What changed

- `event-output-buffer.ts` (fork-only): same-tick RPC events are coalesced
  into a single stdout write.
- `rpc-mode.ts` / `jsonl.ts`: event emission routes through the buffer and the
  JSONL hot path avoids redundant work per event.

### Why

- High-frequency streaming events caused one syscall per event; batching
  same-tick events measurably reduces output overhead (see
  `bench/rpc-event-emit.ts`).

### Why extension system couldn't handle this

- Wire output buffering is internal to the RPC mode's event loop.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `rpc-mode.ts` event emission sites.
- LOW: `jsonl.ts` write helpers; `event-output-buffer.ts` is fork-only.

## Supported thinking levels and turn-scoped thinking controls (2026-07-22)

### What changed

- `get_available_models` now decorates every model with the core-authoritative `supportedThinkingLevels` list.
- RPC `prompt` accepts `thinkingLevel` for immediate prompts and rejects queued level changes before queue mutation.
- `set_thinking_level` accepts `scope: "turn"` for a session-only setting and returns an error unless the effective level exactly matches the request.
- RPC contracts expose the `thinking_level_changed` event and the TypeScript client preserves model capability data when available.

### Why extension system couldn't handle this

- JSONL RPC command parsing, response assembly, and session event forwarding happen below the extension API.

### Expected merge conflict zones

- MEDIUM: `connection-handler.ts` command dispatch and `rpc-types.ts` response unions.
- LOW: `rpc-client.ts` model metadata and `docs/rpc.md` protocol reference.

## Capability-gated extension events reach classic and multi-session clients (2026-08-11)

RPC clients advertising `extension_events` now receive additive
`extension_event { name, data }` records. Unflagged clients remain byte-identical. Multi-session mode
parses `SENPI_RPC_CLIENT_CAPABILITIES`, threads capabilities through `SessionCommandRouter` and
`createRpcSessionBinding`, and preserves the owning routing `sessionId` on emitted records.

## Session-start extension events are subscribed before binding (2026-08-11)

Capability-gated extension RPC listeners now attach before `bindExtensions()` dispatches
`session_start`. This preserves initial atomic extension snapshots such as native task state while
keeping rebind cleanup generation-safe; subscribing after binding deterministically dropped those
events.

## Public RPC client exposes extension events (2026-08-11)

`RpcClientEvent`, `RpcEventListener`, the modes barrel, and the package root now include
`RpcExtensionEvent`, so capability-enabled SDK consumers can narrow and validate generic extension
records. The extension and RPC guides document `pi.rpc.emit`, capability environment variables, the
wire shape, multi-session tagging, and payload validation responsibilities.

## 2026-08-30 - Render shared-host extension components

- Added live server-side rendering for extension component factories used by `setWidget`, `setHeader`, and `setFooter`.
- Added additive `setHeader`/`setFooter` extension UI requests and the `set_client_info { width }` command so attached clients can keep component layout responsive.
- Factory widgets no longer degrade to `custom_unsupported`; that notice remains reserved for `ctx.ui.custom()`.

## 2026-08-25 - Preserve upstream RPC public queue API

### What changed

- `rpc-client.ts`: the interactive client buffers events received during `open_session` so startup widget/header/footer records emitted while attaching are replayed (session-filtered) instead of dropped.
- `packages/coding-agent/src/modes/rpc/rpc-client.ts` and `packages/coding-agent/src/modes/rpc/rpc-types.ts` expose upstream queue-clearing commands while retaining fork RPC protocol structure.

### Why

- RPC command and response unions are a consumer-facing wire contract.

### Why this lives in the fork

- The RPC protocol is defined at the coding-agent public boundary.

### Expected merge conflict zones

- RPC command unions, response unions, and client methods.

- Added append_session_entry RPC transport for verbatim shared-host setup mutations, preserving entry shape and order.
