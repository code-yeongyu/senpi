## 2026-10-09 - Explicit UTC process identity probes (senpi#3045)

### What changed

- `packages/coding-agent/src/modes/app-server/daemon/process.ts`: `readProcessIdentity` accepts an opt-in UTC timezone, pins `TZ=UTC` and the C locale for that OS query, and marks POSIX timestamps as UTC. Existing daemon callers keep their local-time format; Windows identities remain FILETIME.

### Why

RPC owner records cross launch environments. A supervisor that drops its caller's TZ must not read the same live process as a different start time.

### Why an extension could not handle it

The OS process-identity query is shared engine infrastructure outside extension callbacks.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/app-server/daemon/process.ts`: `readProcessIdentity` parameters, query environment and timestamp projection.

## 2026-10-08 - Shared start-time identity parser and tolerance (senpi#2951)

### What changed

- `daemon/process.ts` parses Windows FILETIME and ps/ISO process identities into milliseconds using a named FILETIME epoch, and owns the shared 3 s comparison tolerance. RPC family checks and terminal leases reuse this existing supervisor leaf.
- The same parser recognizes persisted Korean year/month/day lstart and Japanese weekday/month-day lstart in the local timezone. Calendar rollover is rejected. Unrecognized formats remain unknown instead of becoming ownership proof.

### Why

- Failed process snapshots need reliable per-pid identity recovery; an unknown start cannot establish daemon ownership. Shared parsing prevents the lease and daemon identity formats from drifting.

### Why an extension could not handle it

- Host admission and lease ownership run outside extension callbacks.

### Expected merge conflict zones

- `daemon/process.ts` identity helpers; no supervisor import graph change.

## 2026-10-08 - Daemon launches do not replay a Node eval caller (senpi#2599)

### What changed

- `packages/coding-agent/src/modes/app-server/daemon/spawn.ts`: filters Node runtime options before the daemon entry. The existing Bun-to-Node launch path stays unchanged.

### Why

Node eval and print flags belong to the embedding caller, not to the daemon script entry.

### Why an extension could not handle it

Daemon argument construction precedes server startup and extension loading.

### Expected merge conflict zones

- LOW: imports and the child argument array in `daemon/spawn.ts`.

## 2026-09-29 - turn/start refuses an unknown command with structured data (senpi#2348)

### What changed

- `packages/coding-agent/src/modes/app-server/threads/turns.ts`: when the prompt is refused as an unknown command before the turn is announced, `startTurn` discards the turn (no `turn/started`, no user item, no turn-log entry) and rejects with `unknownCommandTurnError`. A preflight failure now completes the turn from the prompt's settle path instead of the preflight callback, so the refusal can be recognized first. `params.unknownCommandAsText` is forwarded to `session.prompt`.
- `packages/coding-agent/src/modes/app-server/threads/unknown-command-refusal.ts` (new): JSON-RPC `-32602` with `data: { errorCode: "unknown_command", command, suggestions, reason }`.
- `packages/coding-agent/src/modes/app-server/threads/turn-log.ts`: `discardTurn`.
- `packages/coding-agent/src/modes/app-server/threads/turn-runtime.ts`: `TurnEngineSession.prompt` options gain `unknownCommandAsText`.
- `packages/coding-agent/src/modes/app-server/turn-adapter.ts`, `protocol/turn.ts`: `turn/start` accepts the senpi extension field `unknownCommandAsText`.

### Why

- App-server clients got a generic `-32603`, a started-then-failed turn, and no way to confirm the text.

### Why an extension could not handle it

- Turn lifecycle and the JSON-RPC error envelope are owned by the app-server turn engine.

### Expected merge conflict zones

- None expected: app-server is fork-only.

## 2026-09-28 - app-server loads `--extension` sources into every thread (omo#9117)

### What changed

- `packages/coding-agent/src/modes/app-server/cli-args.ts`: `app-server` and every `app-server daemon` verb accept repeated `--extension <path>`.
- `packages/coding-agent/src/modes/app-server/extension-paths.ts`: local paths resolve against the invoking cwd, the same rule as the global `--extension` flag.
- `packages/coding-agent/src/modes/app-server/runtime.ts`: `createAppServerRuntime` takes `extensionPaths`; thread create/resume/fork build a `DefaultResourceLoader` with them, and `skills/list` loaders see them too.
- `packages/coding-agent/src/modes/app-server/daemon.ts`, `daemon/spawn.ts`, `daemon/probe.ts`: the daemon child is launched with the extensions and `settings.json` records them; `restart` reuses the recorded list unless the command names new ones. `spawnDaemon` moved to `daemon/spawn.ts` unchanged apart from the launch intent.

### Why

A product launcher that ships its plugin beside the engine (omo) loads it with `--extension`. `app-server` rejected the flag, and the global prefix form never reaches app-server dispatch, so app-server threads ran without the plugin's tools and events.

### Why an extension could not handle it

Extension loading is decided before any extension runs; the app-server builds each thread session itself.

### Expected merge conflict zones

- LOW: `createAppServerRuntime` signature and the `createSession` wiring in `runtime.ts`; argument loops in `cli-args.ts`.

## 2026-09-22 - normalize legacy provider ids on account payloads (senpi#1989)

### What changed

- `packages/coding-agent/src/modes/app-server/server/account.ts`: `requiredProvider` normalizes the client-supplied provider id, covering the get / pin / remove account methods at their single entry point.

### Why

An older client (a pinned desktop runtime, a stale RPC caller) still sends the LEGACY provider id in its account payloads. That is inbound state written by an earlier version, not a legacy id typed by the user, so it is normalized rather than rejected.

### Why an extension could not handle it

The app-server parses and validates params before any extension sees the request.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/app-server/server/account.ts` `requiredProvider`, against any other param-validation change.

# changes

## 2026-09-17 - Keep a thread's MCP inventory current after deferred attach (senpi#1781)

### What changed

- `threads/mcp-wire-status.ts`: `McpWireStatusAdapter` can adopt a live subscription (`bindLiveUpdates`) and drop it (`dispose`); `McpWireStatusRegistry.removeThread` disposes the thread's adapter.
- `runtime.ts`: after binding a thread, the adapter subscribes to `McpService.onWireStatusChanged` filtered to that thread id.

### Why

- senpi#1791 stopped `session_start` awaiting MCP attach. The inventory copied immediately after `bindExtensions()` is therefore taken while servers are still booting, and `update()` had no callers, so `mcpServerStatus/list` returned `{ servers: [] }` for the life of the thread and never recovered.
- The adapter's contract - never read the process-global MCP service during a request - is preserved: this is a push from a subscription the service already emitted on every capture, not a per-request read.

### Expected merge conflict zones

- LOW: the adapter class body and the post-bind block in `createBoundAppServerSession`.

## 2026-09-12 - App-server turn steering carries its input source

### What changed

- `packages/coding-agent/src/modes/app-server/threads/turns.ts` and `src/modes/app-server/turn-adapter.ts`: turn steering and follow-up input pass the app-server `InputSource` value to `AgentSession.steer()` / `followUp()`, so extension `input` handlers observe the real source instead of the interactive default (upstream faa9863cb, adopted per D-N).

### Why

- Same gap as RPC: queued app-server input skipped extension `input` handlers.

### Why an extension could not handle it

- Source tagging happens where the session enqueues input, below the extension API.

### Expected merge conflict zones

- The steer/follow-up call sites in `threads/turns.ts` and `turn-adapter.ts`, and the `InputSource` union.

## 2026-09-12 - Read a guard-less pidfile as unknown ownership

### What changed

- `packages/coding-agent/src/modes/app-server/daemon/process.ts`: `DaemonPidFile.processStartTime`
  accepts `null` for a record written while the identity probe was starved, `parseDaemonPidFile`
  round-trips it, and `processMatchesPidFile` answers only the liveness half for such a record - a
  pid that is gone is `false`, a live one raises `ProcessIdentityUnreadableError`.

### Why

- The RPC host registration needs a way to record a live host it cannot fingerprint. Without a
  representable "no guard" state the supervisor had to choose between killing a healthy host and
  writing a record that later callers would mistake for proven ownership; the null guard makes the
  unknown explicit so no caller can signal a pid it never verified.

### Why an extension could not handle it

- The pidfile contract is consumed by daemon and RPC supervisor code that runs before extensions
  load.

### Expected merge conflict zones

- LOW around the `DaemonPidFile` shape and the head of `processMatchesPidFile`.

## 2026-09-11 - Treat live processes with temporarily absent identity as observable gaps

### What changed

- `packages/coding-agent/src/modes/app-server/daemon/process.ts`: `processMatchesPidFile`
  now checks process liveness when a platform identity probe returns no identity. A live PID
  remains an observation failure within the bounded probe budget instead of being treated as a
  dead or replaced process.

### Why

- Windows CIM queries can transiently return an empty result for a process that is still alive.
  Treating that result as a PID mismatch lets concurrent RPC host startup reclaim a healthy host.

### Why an extension could not handle it

- The process identity reader is the ownership boundary used by daemon and RPC lifecycle code;
  extensions cannot safely alter its result after a host has been classified.

### Expected merge conflict zones

- LOW around `daemon/process.ts` process identity probe classification.

## 2026-09-11 - Partial ask-user responses resolve with unanswered ids

### What changed

- `packages/coding-agent/src/modes/app-server/server/user-input-bridge.ts` now receives the shared
  pending-question partial-submit behavior, resolving a non-empty answer map as `answered` while
  preserving unanswered ids.

### Why

- App-server already accepted partial responses, but the shared pending state machine previously
  disagreed with RPC. This tracker records the cross-surface contract that must remain aligned.

### Why an extension could not handle it

- The app-server bridge owns protocol response correlation and consumes the shared pending state
  machine before extension code can alter the result.

### Expected merge conflict zones

- LOW around `UserInputBridge.resolveResponse`; preserve the existing request ordering and
  `serverRequest/resolved` lifecycle.

## 2026-09-10 - Optional display-name account descriptor (senpi#1495)

### What changed

- `packages/coding-agent/src/modes/app-server/protocol/account.ts`: `ProviderAccount` gains optional `displayName`, matching the shared secret-free account read response. `name` remains the immutable selector ID. Generated protocol evidence is untouched.

### Why

- `packages/coding-agent/src/modes/app-server/protocol/account.ts`: clients can render `displayName (name)` without changing pin/remove behavior or legacy unnamed account payloads.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/app-server/protocol/account.ts` is the host-owned facade for account responses and must describe the actual shared projection.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/modes/app-server/protocol/account.ts` provider account descriptor.

## Ask-user question transport (2026-09-10)

### What changed

- `packages/coding-agent/src/modes/app-server/server/user-input-bridge.ts` and `packages/coding-agent/src/modes/app-server/server/user-input-types.ts` adapt canonical questions to generated-compatible `item/tool/requestUserInput` requests with namespaced IDs, first-response resolution, replay, progress-driven idle timers, and cancellation.
- `packages/coding-agent/src/modes/app-server/server/approval-ui-context.ts` delegates `question()` directly without permission-title parsing.
- `packages/coding-agent/src/modes/app-server/runtime.ts` wires subscription replay, active turn identity, turn-end cancellation, and disposal.
- `packages/coding-agent/src/modes/app-server/turn-adapter.ts` routes initialized-client answers and progress, returning protocol errors for invalid answers and unknown response IDs.
- `packages/coding-agent/src/modes/app-server/protocol/methods.ts` registers the additive `item/tool/userInputProgress` client notification outside pinned Codex arrays.

### Why

- App-server clients need the same blocking and asynchronous question outcomes as other UI modes without reusing approval decisions. Idle timeout and the two-hour cap remain owned by the shared pending-question state machine.

### Why an extension could not handle it

- Correlation IDs, inbound protocol routing, subscriber replay, and session lifecycle are app-server-owned. Answers are not logged by this bridge; diagnostics contain no answer payloads.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/app-server/server/user-input-bridge.ts`, `packages/coding-agent/src/modes/app-server/server/user-input-types.ts`, and `packages/coding-agent/src/modes/app-server/server/approval-ui-context.ts`: user-input and approval adapter contracts.
- `packages/coding-agent/src/modes/app-server/runtime.ts`, `packages/coding-agent/src/modes/app-server/turn-adapter.ts`, and `packages/coding-agent/src/modes/app-server/protocol/methods.ts`: lifecycle wiring and additive protocol routing.

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
