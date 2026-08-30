# changes

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

## 2026-08-25 - Preserve upstream RPC public queue API

### What changed

- `packages/coding-agent/src/modes/rpc/rpc-client.ts` and `packages/coding-agent/src/modes/rpc/rpc-types.ts` expose upstream queue-clearing commands while retaining fork RPC protocol structure.

### Why

- RPC command and response unions are a consumer-facing wire contract.

### Why this lives in the fork

- The RPC protocol is defined at the coding-agent public boundary.

### Expected merge conflict zones

- RPC command unions, response unions, and client methods.

- Added append_session_entry RPC transport for verbatim shared-host setup mutations, preserving entry shape and order.
