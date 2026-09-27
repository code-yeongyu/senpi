## 2026-09-27 - RPC idle snapshots and cancellable event collectors

### What changed

- `packages/coding-agent/src/modes/rpc/rpc-client.ts`: `waitForIdle` subscribes before one `get_state` query and resolves from an idle snapshot in wire-frame order or a subsequent `agent_settled`. The private request signal cancels an unanswered snapshot when the event or deadline wins. Both event helpers share cleanup on settlement, timeout, transport loss, process exit and stop.
- `promptAndWait` observes the prompt and collector together and cancels the collector when prompting fails. Event dispatch snapshots its listeners so one completing waiter cannot skip a concurrent waiter.
- `test/suite/rpc-client-idle.test.ts` covers idle/active snapshots, response/event ordering, concurrent waiters, refused prompts and cleanup. `docs/rpc.md` records the unchanged local idle meaning.

### Why

In `packages/coding-agent/src/modes/rpc/rpc-client.ts`, an already-idle session produced no future settlement event, so the old client waited until its 60-second deadline. A refused prompt abandoned an event collector whose later timeout rejected without an observer. Event waits also outlived disconnected clients, and unsubscribing during array iteration skipped adjacent waiters.

### Why an extension could not handle it

`packages/coding-agent/src/modes/rpc/rpc-client.ts` owns the transport request, event listeners and timers. Extensions calling the interactive host's `waitForIdle` proxy cannot repair those client lifetimes.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/rpc/rpc-client.ts`: helper methods, event dispatch loops, stop/disconnect cleanup and the private `send` request lifecycle. Retain independent command-refusal and worker-listing changes when merging. The acknowledged-open deadline uses the same cancellation-safe pending-request rejection wrapper; queued acknowledgements stay outside collected agent events.


## 2026-09-27 - Share immutable replay boundaries and drain late attachments lazily

### What changed

- `packages/coding-agent/src/modes/rpc/session-event-fanout.ts`: retain boundary snapshots as privately owned JSON-normalized data with equal strings shared across the active message. Replay owns an attachment-time record list and serializes one record per socket drain; caller mutation cannot change late media placeholders.
- `packages/coding-agent/src/modes/rpc/session-event-writer.ts`: stop passing mutable source objects to snapshot retention. Already-emitted media variants are normalized alongside plain values so stateful toJSON results remain byte-identical; live delivery retains its existing serialization path.
- `packages/coding-agent/src/modes/rpc/socket-event-fanout.ts`: admit an ordered lazy replay cursor using the existing FIFO, queue limit, stall detector and close path. Queued live events remain behind replay; failure or disconnect closes its iterator and releases its references. Replay yields through Node setImmediate after a 4 ms elapsed slice so immediately resolved drains cannot starve timers; a single record remains synchronous.

### Why

- `packages/coding-agent/src/modes/rpc/session-event-fanout.ts`: full start/end boundaries repeat earlier tool arguments, so compacting only deltas still retained approximately 280 MB for a synthetic 0.53 MB final message with 128 tool calls. Shared normalized strings reduce the same source-level case to approximately 6.8 MB while retaining identical boundary records. This case establishes amplification, not the cause of any observed process OOM.
- `packages/coding-agent/src/modes/rpc/socket-event-fanout.ts`: eagerly queueing the same case's 139 MB replay disconnected a healthy late subscriber at the 64 MiB cap. The cursor budgets a conservative resident estimate and one materialized line, allowing transport backpressure to govern replay without expanding all wire history at once. Total replay serialization costs more CPU; the observed-shape 6-tool benchmark remains below 1 ms per emitted event.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/rpc/session-event-fanout.ts`, `packages/coding-agent/src/modes/rpc/session-event-writer.ts`, and `packages/coding-agent/src/modes/rpc/socket-event-fanout.ts`: shared-host snapshot ownership, socket queue ordering and drain accounting are below extension hooks.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/rpc/session-event-fanout.ts`: snapshot representation, reset/demotion and capability-filtered replay.
- `packages/coding-agent/src/modes/rpc/session-event-writer.ts`: snapshot capture call after live serialization.
- `packages/coding-agent/src/modes/rpc/socket-event-fanout.ts`: queue entry union, admission/overflow cleanup and drain loop. Ordinary live keyed demotion, worker acceptance credit and existing loop-served stall budgets remain intact.


## 2026-09-27 - Reject refused commands consistently in the RPC client

### What changed

- `packages/coding-agent/src/modes/rpc/rpc-client.ts`: validate acknowledged responses in the shared send path with the existing typed-error decoder. Void-returning methods now reject host refusals, like methods that read response data already did.
- `packages/coding-agent/test/rpc-client-reconnect.test.ts`: exercise refused steering, follow-up, custom messages, abort, close, and prompt over a real local socket. A refused close retains its lease; successful close releases it; rejected prompt callbacks fire exactly once.

### Why

- `packages/coding-agent/src/modes/rpc/rpc-client.ts`: a `success:false` response used to resolve void-returning commands. OMO could report a refused steering message as delivered, and a refused close could discard the client's live session handle.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/rpc/rpc-client.ts`: callers only receive the method's promise; the response and its refusal were discarded inside the shared client.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/rpc/rpc-client.ts`: the end of `send`. Synchronous response callbacks still run before promise settlement, fire-and-forget UI replies still require no acknowledgement, and classified transport-loss handling is unchanged.

## 2026-09-27 - Forward worker visibility through the RPC client

### What changed

- `packages/coding-agent/src/modes/rpc/rpc-client.ts`: accept and forward the existing `include_workers` listing option; omitted and false options retain the host's default privacy filter.
- `packages/coding-agent/test/suite/rpc-session-context.test.ts`: exercise the public client against the actual host command router, including opt-in followed by default listings.

### Why

- `packages/coding-agent/src/modes/rpc/rpc-client.ts`: OMO lifecycle reconciliation requests worker visibility, but this client silently dropped the option. A live worker was therefore absent from its liveness snapshot, permitting spurious recovery and stale task epochs.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/rpc/rpc-client.ts`: extensions consume this client; the shared method discarded the option before transport.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/rpc/rpc-client.ts`: the `listSessions` signature and command construction. The host protocol and default listing policy are unchanged.

## 2026-09-27 - Release superseded streaming snapshots from the replay cache

### What changed

- `packages/coding-agent/src/modes/rpc/session-event-writer.ts`: compute the existing delta-only serialization once and pass it to the replay cache and socket queue.
- `packages/coding-agent/src/modes/rpc/session-event-fanout.ts`: retain ordered deltas and the newest compact delta's full snapshot, releasing earlier cumulative JSON, media variants, and source references. Full start/end boundary records remain intact for existing clients.

### Why

- `packages/coding-agent/src/modes/rpc/session-event-fanout.ts`: retaining every cumulative prefix grows quadratically with the number of streaming deltas. A 64 KiB synthetic response previously retained about 102 MB of heap and replayed 67.5 MB, overflowing a healthy late attachment's default queue. The same case now retains about 0.84 MB and replays 0.35 MB. This removes delta-prefix amplification; it does not impose a global replay-cache cap.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/rpc/session-event-writer.ts` and `packages/coding-agent/src/modes/rpc/session-event-fanout.ts`: shared-host serialization and replay retention happen below extension hooks.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/rpc/session-event-writer.ts`: compact-delta serialization in the socket delivery path.
- `packages/coding-agent/src/modes/rpc/session-event-fanout.ts`: snapshot storage, replacement, and replay. Live delivery, boundary payloads, media capability filtering, and message-end cleanup retain their existing contracts.

## 2026-09-27 - Yield contended startup locks to the event loop

### What changed

- `packages/coding-agent/src/modes/rpc/ownership-safe-lock.ts`: disable SQLite's synchronous busy handler and use the existing asynchronous retry and cumulative deadline when ownership is contended.

### Why

- `packages/coding-agent/src/modes/rpc/ownership-safe-lock.ts`: each contender could block the shared event loop for 100 ms. Eight contenders repeatedly delayed a 50 ms release timer to about 806 ms; fail-fast attempts reduced the measured heartbeat gap to 5–6 ms while preserving exclusive ownership.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/rpc/ownership-safe-lock.ts`: RPC-host and app-server startup acquire this mutex below extension hooks.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/rpc/ownership-safe-lock.ts`: the acquisition PRAGMA and retry comment. The persistent database, exclusive transaction, release and legacy-artifact handling are unchanged.
## 2026-09-27 - open_session waits for the host that acknowledged it instead of a fixed 30 s (#2209)

### What changed

- `packages/coding-agent/src/modes/rpc/rpc-client.ts`: every request still waits `REQUEST_DEADLINE_MS` (30 s) for its answer. An `open_session` whose `queued` record the host sent (senpi#1844) switches to `OPEN_AFTER_QUEUED_DEADLINE_MS` (10 min), and a timeout after the acknowledgement names the queue position instead of reporting a bare timeout. A lost transport still rejects every pending request at once.
- `packages/coding-agent/src/modes/rpc/rpc-request-deadline.ts` (new): the two budgets and the restartable deadline the client arms per request.
- `packages/coding-agent/test/rpc-client-open-deadline.test.ts` (new): an acknowledged open answered after 57 s resolves; an unacknowledged open still fails at 30 s; an acknowledged open that never answers fails naming its queue position; a transport lost after the acknowledgement rejects at once.

### Why

A loaded in-process host builds a session on its one loop. Measured on a live host, it acknowledged an open after 3.2 s and answered it after 56.8 s. Every client gave up at 30 s, so task children failed at ~40 s (probe + 30 s) exactly when the host was busiest. The host then finished the session for a client that was already gone.

### Why an extension could not handle it

The deadline is armed inside `RpcClient.send`, which every embedder (task runners, desktop, CLI) uses directly; no extension runs in the client process.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/rpc/rpc-client.ts`: `send()`'s pending-request construction and `handleLine()`'s response dispatch.

## 2026-09-22 - Daemon status metrics read the process table through the kernel, never a `ps` child (omo-desktop#594)

### What changed

- `packages/coding-agent/src/modes/rpc/host-process-table.ts` (new): a zero-spawn whole-table reader. darwin reads `sysctl(KERN_PROC, KERN_PROC_ALL)` - the same table `ps` itself reads, zombies included - plus `proc_pidinfo(PROC_PIDTASKINFO)` for resident memory; linux scans `/proc/<pid>/stat`. `bun:ffi` is imported behind the runtime gate exactly like `child-reaper-syscalls.ts`, so Node resolves the loader to `undefined` instead of becoming unloadable. The pinned `kinfo_proc` offsets are verified on every read by a fail-closed self-check (the row for this process must exist with the kernel's own ppid and a non-zombie state, else `undefined`), and a too-small sysctl buffer grows geometrically - never depending on the kernel updating `oldlenp`.
- `packages/coding-agent/src/modes/rpc/host-process-metrics.ts`: `readHostProcessMetrics` no longer spawns `ps -A` per read. It walks the kernel table; when the reader is unavailable (Node, unsupported platforms) every field is `null` - "this platform does not publish it here" - rather than falling back to a child process. Tree walking, `open_fds`, and the win32 short-circuit are unchanged.
- `test/suite/regressions/issue-omo-594-host-status-zero-spawn.test.ts`: the RED/GREEN contract. Thirty status reads through the real metrics path must spawn zero probe processes (the unmodified tree spawns one per read); a bun-run fixture proves the kernel reader keeps the observability `ps` provided - real orphans under the host are counted, and the count returns to 0 once the reaper collects them - and that a 512-byte start buffer (forced first-call overflow) still recovers the table. A pure-parse unit test pins the fail-closed rule: tables laid out at the pinned offsets parse; a shifted ppid offset, a wrong row stride, a zombie self row, or a missing self row all yield `undefined`.

### Why

The omo production RPC host accumulated `<defunct>` children at client-driven cadence (omo-desktop-app#594: ~1.7 zombies/min, 0 live children, monotonic). The class, measured at scale in senpi#1507 (9,386 zombies), is a long-lived process spawning a short-lived probe child per request: on a runtime whose `execFile` does not reap, every probe becomes a permanent zombie. The watchdog lost its `ps` probe for exactly this reason (#1721) and the host got a reaper for terminated-worker orphans (f1d1bdaf8d); the status metrics - `host status` and the generations rows, polled per request, once per live generation - still ran `ps -A` per read on whatever long-lived process embedded them. This closes the last member of that class on the daemon-control surface the same way #1721 closed the watchdog's: by not spawning.

A read-only census of the live production hosts on this machine (three samples one minute apart) shows zero zombies under every `omo --mode rpc --multi-session` pid - consistent with #1721 and the reaper already covering the historical host-side sites; the surviving member of the class was this status path, which is why it moves to the kernel table rather than relying on the reaper.

### Why an extension could not handle it

The read happens inside the package's daemon-control surface (`readHostStatus`, `readGenerationRows`) before any extension loads; an extension cannot stop the package from spawning its own probe.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/rpc/host-process-metrics.ts`, against any change to the metrics fields or their null semantics.

## 2026-09-22 - durable_session_id on the worker registry, and a chosen id that is on disk at once (#2010)

### What changed

- `packages/coding-agent/src/modes/rpc/worker-session-registry.ts`: `openSession` validates `durableSessionId` with `assertValidSessionId` (refusing with `invalid_session_id`) and refuses an id any non-closed entry already holds with `session_id_in_use`, both synchronously before its first await; the requested id is recorded on the entry before that await so a concurrent open sees it, and `snapshot.state.sessionId` still overwrites it after commit. Re-opening the same path stays an attach.
- `.agents/skills/senpi-qa/scripts/scenarios/durable-session-id-qa.mjs` (new): drives the REAL `senpi --mode rpc --multi-session` process over stdio and asserts the whole contract - capability advertised, create under a chosen id, duplicate live id refused, malformed id refused, resume keeps its header id, reopen of the created path reads the chosen id back from disk, id reusable once its holder closed.

### Why

- #1956 added the collision guard to `RpcSessionRegistry` only. `multi-session-host.ts` instantiates `WorkerSessionRegistry` whenever a worker configuration is present - the real host's normal shape - and that registry forwarded the profile straight to `worker.prepare`, so on the real host two live sessions could share one durable id. The unit suite drove `RpcSessionRegistry` directly and stayed green while the host bypassed the guard; the real-surface scenario is what caught it.
- The format refusal did fire on the real host, but as `open_failed: invalid_session_id` from the worker's own `SessionManager` after the worker had already died. Validating at the registry boundary gives the caller the stable code before any worker is spawned.

### Why an extension could not handle it

- Both checks need the registry's view of every live session and run before any runtime or extension exists for the new session.

### Expected merge conflict zones

- `worker-session-registry.ts`: the prologue of `openSession` (after the `invalid_path` check) and the entry literal.

## 2026-09-22 - chatgpt-subscription provider id on the RPC surface (senpi#1989)

### What changed

- `packages/coding-agent/src/modes/rpc/rpc-client.ts` and `packages/coding-agent/src/modes/rpc/rpc-types.ts`: provider ids carried over RPC use the new spelling.

### Why

The OpenAI subscription provider id was renamed from `openai-codex` to `chatgpt-subscription` (senpi#1989): the old id named a CLI rather than the thing a user signs in with. These modules resolve or display that provider id at runtime, so they move with it. The wire api id `openai-codex-responses` is deliberately NOT renamed - it names the dialect, not the provider - and neither are file names or module paths.

### Why an extension could not handle it

The provider id is resolved inside the package before any extension loads, and these call sites compare or render it while building requests and UI. An extension cannot rewrite an id the package has already used.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/rpc/rpc-types.ts`, against any other provider-typed RPC payload change.

## 2026-09-22 - The observer reconnect chain survives failed retries, and unknown activity is bounded (#1979)

### What changed

- `packages/coding-agent/src/modes/rpc/observer-link.ts` (new): the supervisor's observer connection, its reconnect chain, and the rule for how long an unhealthy observer may count as busy. `createObserverLink()` retries on every failure until it reconnects or the supervisor settles, and records when it went unhealthy. `activeTurnsForIdleDecision()` returns the observed count while healthy, `1` while unhealthy inside `unknownGraceMs`, and `0` once that grace has elapsed; an infinite grace never elapses.
- `packages/coding-agent/src/modes/rpc/host-lifecycle.ts`: `runHostSupervisor` builds the link with a socket adapter, and `currentActivity()` feeds the decider through `activeTurnsForIdleDecision` with `decider.idleExitMs` as the grace, so a `persistent` host (infinite window) keeps its infinite pin. The inline `connectObserver()` and its two state variables are gone. Net +7 pure LOC on a file already past the ceiling: the extracted unit is 64 LOC, but the socket adapter that stays behind is about as long as the code it replaced.
- `test/suite/idle-exit-window-contract.test.ts` (characterization, green before the change), `test/suite/regressions/issue-1979-observer-reconnect-chain.test.ts`, `test/suite/regressions/issue-1979-unknown-activity-bound.test.ts`.

### Why

- The retry callback reused the `lost` handler of the connection that had already gone. That handler starts with `if (observer !== next) return`, and by the time a retry fails the supervisor owns no socket, so the guard was always true and nothing re-armed. One failed reconnect ended the chain for the life of the process. Since `currentActivity()` reported `activeTurns: 1` for an unhealthy observer, the idle window could never elapse - a second path to a host that outlives every client, next to the socket-gone case #1961 fixed.
- The fail-open itself is right: a momentary observer blip must not kill a turn. What was missing was a bound. One idle window is the natural one: after that, unknown has held the host open exactly as long as idleness would have been allowed to, and there is no longer anything it is protecting.

### Why an extension could not handle it

- The supervisor is a separate process that hosts no session; nothing an extension can reach observes its link or its idle decision.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/rpc/host-lifecycle.ts`: the supervisor state declarations near `clientSockets`, `currentActivity()`, the `observerSocket?.destroy()` line in `performShutdown`, the `observerLink` construction beside `publicSocketOwned`, and the removed `connectObserver()` body.

## 2026-09-22 - A worker that fails during open reports the failure, not `session_closing` (#1953)

### What changed

- `packages/coding-agent/src/modes/rpc/worker-session-registry.ts`: `openSession` remembers the reason its worker reported through the `failure` callback. The post-`commit()` guard that sees an entry which left `opening` now throws `open_failed: <reason>` when a worker failure caused it, and keeps `session_closing` only for the case it documents - an entry somebody else is closing. The registry also takes an optional `createWorker` factory, defaulting to the real `SessionWorkerClient`, so the failure path can be driven without a worker thread.
- `packages/coding-agent/test/suite/regressions/issue-1953-worker-failure-open-error.test.ts`: regression for the code the client receives.

### Why

- The worker's `failure` callback flips the entry to `quarantined` asynchronously, so a worker that dies mid-open leaves the guard looking at a state that is no longer `opening`. It answered `session_closing`, which tells the client the opposite of what happened: nothing was closing, the worker died. The real reason only reached stderr, which is how a red run shows `senpi rpc session rpc-1 quarantined: worker-failed` on one side and `session_closing` on the wire on the other.
- `open_failed: <detail>` already exists as a stable wire code and `RpcSessionRegistryError` already formats its reason, so this needs no new code on the protocol surface.

### Why an extension could not handle it

- This is the transport-side registry's own open path; extensions run inside a session that this code has not finished creating.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/rpc/worker-session-registry.ts`: the `openSession` worker construction block and the guard after `worker.commit()`.

## 2026-09-22 - Drain a generation whose public entry is GONE, not only one that was replaced (#1961)

### What changed

- `packages/coding-agent/src/modes/rpc/socket-ownership.ts`: `classifyEndpointOwnership()` answers `held` / `replaced` / `absent` / `unknown` from ONE stat, so the two loss questions can never disagree with each other across separate calls. `socketEntryReplaced()` keeps its exact contract and is now that classifier's `replaced` case.
- `packages/coding-agent/src/modes/rpc/host-supersession.ts`: the watch reports WHICH loss it saw (`"replaced" | "absent"`). An absent entry counts only after `ABSENT_CONFIRMATIONS` (3) consecutive polls and a stat that cannot answer resets the count instead of adding to it, so a momentary race is never read as a loss. The transition also latches now: clearing the interval cannot unsend the classifications already in flight, so several pending observations of one loss still deliver a single drain request - the once-only contract the module docstring already promised.
- `packages/coding-agent/src/modes/rpc/host-lifecycle.ts`: the supervisor's drain log names the loss it acted on.
- `packages/coding-agent/test/suite/regressions/issue-1961-public-endpoint-absent.test.ts`: fake-timer regression for the absent case.

### Why

- `socket-ownership.ts` deliberately answered `false` for an absent entry: "a name that is merely missing is somebody's `rm`, not a newer host". That is right for the supersession question and wrong for reachability. An unlinked unix socket name can never accept another connection, so the generation holding it is unreachable by construction - and because `coldStart=persistent` never idle-exits while an unhealthy observer reports activity as unknown (non-idle), the two conditions that prove such a generation useless were also the ones keeping it alive. Measured: a supervisor plus host pair alive 23h45m after its socket directory had been deleted. Reproduced on a pristine build in 60 seconds (`exited_after_seconds: "never"`, both pids alive) and closed by this change in 6 seconds (both pids gone, `processes_left: 0`).
- Draining rather than killing is what makes absence safe to act on: `session-command-router` refuses to park sessions that still have attachments and exits only at an empty registry, so live work finishes and only an unreachable, empty generation goes away.

### Why an extension could not handle it

- This is the supervisor's own lifecycle policy, decided before and outside any session. Extensions run inside sessions the host serves and can neither observe the endpoint's ownership nor decide whether the generation may keep running.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/rpc/socket-ownership.ts`: the block around `socketEntryReplaced()`.
- `packages/coding-agent/src/modes/rpc/host-supersession.ts`: the whole `watchForSupersession()` body and the module docstring.
- `packages/coding-agent/src/modes/rpc/host-lifecycle.ts`: the `watchForSupersession(...)` call site inside the startup try block.

## 2026-09-22 - Caller-chosen durable session id on open_session (#1951)

### What changed

- `packages/coding-agent/src/modes/rpc/rpc-types.ts`: `open_session` accepts an optional `durableSessionId`. Two new stable error codes, `invalid_session_id` and `session_id_in_use`, join the `RpcErrorCode` union.
- `packages/coding-agent/src/modes/rpc/custom-capability.ts`: new host capability `durable_session_id`, advertised from `get_protocol_info` by the multi-session router only.
- `packages/coding-agent/src/modes/rpc/session-registry.ts`: `RpcSessionLaunchProfile.durableSessionId` flows into `SessionManager`. `validateProfile` rejects a malformed id with `invalid_session_id` (reusing `assertValidSessionId`), and `openSession` refuses an id a LIVE session already holds with `session_id_in_use`. That collision scan and the entry's own `durableSessionId` are both taken SYNCHRONOUSLY, before the first await, so two concurrent opens naming one id cannot both pass. Re-opening the SAME path is exempt: that is an attach, and the id is the file's own.
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`: the D1 normative table lists `durableSessionId` among `open_session`'s params, the stable error-code list gains `invalid_session_id` and `session_id_in_use`, and the D6 identity notes explain why the field is not named `sessionId` and why it applies to create only.
- `packages/coding-agent/src/core/session-manager.ts`: `SessionManager.open` takes `NewSessionOptions`, and the private constructor forwards them into `_setSessionFile`, which applies them at both `_resetToNewSession` call sites - the missing-file branch and the empty-file branch. An existing, non-empty session file never reaches either, which is what makes a supplied id unable to overwrite a header id.

### Why

- A caller with its own stable record id for a conversation (a desktop thread, a job row, a tracker item) had no way to make the session carry that id, because the wire offered only `sessionPath`. Every such embedder kept a SECOND identity plus a translation layer, and every feature crossing the boundary - goal files, subagent and team attribution, resume cursors, adoption provenance - carried the mapping. When the mapping was lost the user-visible result was a dead-ended turn, not a recoverable error.
- Id injection already existed one layer down (`NewSessionOptions.id`, honored by `_resetToNewSession` behind `assertValidSessionId`) and `SessionManager.create` already took it. Only the wire and `SessionManager.open` were missing, and `open` is the branch that matters: a client that names its own session file always lands there.
- The duplicate guard is not optional. Two live sessions sharing one durable id would collide every per-session artifact a client keys by that id, so the host refuses rather than letting a caller create the collision.

### Why an extension could not handle it

- The field is part of the `open_session` wire contract, its validation runs inside the session registry before any runtime exists, and the collision guard needs the registry's view of every live session. No extension surface reaches any of those.

### Expected merge conflict zones

- `rpc-types.ts`: the `open_session` union member and the `RpcErrorCode` union both grow by additive lines; upstream edits to either list land in the same place.
- `session-command-router.ts`: the `get_protocol_info` capability set and the `openSession` profile literal each gain one entry.
- `session-registry.ts`: the prologue of `openSession` gains the synchronous collision guard directly above the path-reservation block, and `RpcSessionRegistryError`'s code union grows.
- `session-manager.ts`: `static open`'s signature and the `_setSessionFile` call in the private constructor; any upstream change to either signature conflicts textually.

## 2026-09-21 - Start a generation beside a stranded foreign one (#1936)

### What changed

- `packages/coding-agent/src/modes/rpc/host-ensure.ts`: in the `start` branch of `ensureHostLocked`, a record written by another process refuses `foreign_writer` only while something still ACCEPTS connections at the public path (`publicEndpointAccepts`: a missing entry and an entry nobody listens behind both read as free; win32 named pipes, abstract sockets and an entry that cannot be stat'ed always read as owned; an accepted-but-silent socket is owned, exactly as `host_busy` treats it). A live foreign generation whose endpoint accepts nothing is left running and `startHost` binds a new generation numbered after it: `startHost` takes a `generation` argument that flows into the daemon settings, the registration and `SENPI_RPC_HOST_GENERATION`, and appends to the daemon stderr log instead of truncating the file the stranded generation still writes. Own-writer behaviour (`host_busy`, stop-and-restart) is unchanged.

### Why

- `packages/coding-agent/src/modes/rpc/host-ensure.ts`: a supervisor that sees another entry over its path drains and exits only when its last session settles (#1893). Once that replacement exited and unlinked, every ensure met a silent probe, a live pid and a writer that was the ephemeral `senpi host ensure` child, and refused - one desktop lost its host for 75 minutes while nothing served the path.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/rpc/host-ensure.ts` is the daemon ensure itself; extensions run inside sessions the host serves and cannot decide whether a host may be bound.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/rpc/host-ensure.ts`: the `start` branch of `ensureHostLocked`, the `startHost` signature and `hostEnv`. Upstream has no shared daemon, so any conflict is structural.

## 2026-09-21 - Announce a supersession and park attached sessions (#1933)

### What changed

- `packages/coding-agent/src/modes/rpc/rpc-types.ts`: additive `RpcHostSupersededEvent` (`host_superseded` with `instanceId`, `generation`, `successor`) in the host lifecycle record union, and an optional `sessionPath` on `session_closed` so a `handoff_parked` record names the file to reopen on the successor. No existing field changed shape.
- `packages/coding-agent/src/modes/rpc/multi-session-host.ts`: `drainForHandoff` broadcasts `host_superseded` through the event writer before parking, exactly once per drain (a re-entered drain rescans only), and closes a connection once its last attached session parks.
- `packages/coding-agent/src/modes/rpc/session-command-router.ts`: the drain sweep parks attached sessions too, gated by `handoff-activity.ts`; a parked handle is answered by its terminal record and close rather than `unknown_session`, and `open_session` on a draining connection is refused with the new stable code `host_draining`.
- `packages/coding-agent/src/modes/rpc/handoff-activity.ts` (new): the handoff parkable predicate - turns and in-flight host requests block parking, durable wake-source holds do not.
- `packages/coding-agent/src/modes/rpc/host-lifecycle.ts`: `SENPI_RPC_HANDOFF_GRACE_MS` (default 600000) soft grace that rescans and reports without aborting work; the idle ticker is suppressed while draining; proxied clients drain their final records before the socket closes.
- `packages/coding-agent/src/modes/rpc/session-event-writer.ts`, `session-worker-client.ts`, `session-worker-protocol.ts`, `session-worker.ts`: publish the handoff predicate and flush a connection's records before it is closed, for both session runtimes.

### Why

- A superseded generation parked only the sessions nobody was attached to, so an attached idle client pinned the old host forever (the memory #1893's drain was meant to reclaim) and learned nothing about the handoff; its next command on a fresh connection reached the successor's empty registry and answered `unknown_session`.

### Why an extension could not handle it

- Supervisor signals, JSONL ordering on a shared connection, session-path reservations and the registry's parkable state are host transport internals; no extension can observe or drive them.

### Expected merge conflict zones

- `host-lifecycle.ts` drain/shutdown block, `multi-session-host.ts` connection accounting, `session-command-router.ts` sweep. Socket regression tests spawn real supervisors and hold a real model turn.

## 2026-09-21 - Correct the legacy navigation selection comment (#1892 follow-up)

### What changed

- `packages/coding-agent/src/modes/rpc/rpc-types.ts`: the `targetId` comment now describes the same selection rule as `entryId`: user/custom targets select their parent, root-user selection yields a null leaf, and other targets select themselves. Only the response shape is legacy.

### Why

- `packages/coding-agent/src/modes/rpc/rpc-types.ts` still promised a verbatim leaf move, contrary to the shipped core behavior and corrected RPC documentation.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/rpc/rpc-types.ts` owns the client-facing command contract; an extension cannot correct its type comments.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/rpc/rpc-types.ts`: the `navigate_tree.targetId` comment only. No type, dispatch, response shape, or selection behavior changes.

## 2026-09-21 - Exact-leaf navigation intent (#1926)

### What changed

- `packages/coding-agent/src/modes/rpc/rpc-types.ts`: additive `navigate_tree.intent: select | resume`, independent of existing addressing and response shapes.
- `packages/coding-agent/src/modes/rpc/connection-handler.ts`: validate inbound intent and forward it and `expectedLeafId` unchanged through core navigation. Omitted intent preserves the existing options and serialized response.
- `packages/coding-agent/src/modes/rpc/rpc-client.ts`: typed client options accept the same intent; transport already forwards those options.

### Why

- `packages/coding-agent/src/modes/rpc/rpc-types.ts`, `packages/coding-agent/src/modes/rpc/connection-handler.ts`, `packages/coding-agent/src/modes/rpc/rpc-client.ts`: branch resumption must preserve an unanswered user tail without redefining either released address. Real-handler and client regressions cover resumption, serialized retry payloads and stale tokens; shipping RPC/SDK docs describe the distinction.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/rpc/rpc-types.ts`, `packages/coding-agent/src/modes/rpc/connection-handler.ts`, `packages/coding-agent/src/modes/rpc/rpc-client.ts`: the wire union, JSON boundary and typed client are RPC-owned; leaf mutations must remain in core rather than an extension or transport workaround.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/rpc/rpc-types.ts`: `navigate_tree` command options/comments.
- `packages/coding-agent/src/modes/rpc/connection-handler.ts`: `navigate_tree` validation and option forwarding only.
- `packages/coding-agent/src/modes/rpc/rpc-client.ts`: `navigateTree` option type only.

## 2026-09-21 - Own one MCP registry per in-process host (#1915)

### What changed

- `packages/coding-agent/src/modes/rpc/multi-session-host.ts` creates one registry for each in-process host.
- `packages/coding-agent/src/modes/rpc/session-registry.ts` wraps the runtime factory once to inject the same registry on opens and session replacements.

### Why

- `packages/coding-agent/src/modes/rpc/multi-session-host.ts` owns the host lifetime; `packages/coding-agent/src/modes/rpc/session-registry.ts` retains that ownership across session replacement without changing attachment or parked/resumed semantics.

### Why an extension could not handle it

- Host construction in `packages/coding-agent/src/modes/rpc/multi-session-host.ts` and runtime-factory retention in `packages/coding-agent/src/modes/rpc/session-registry.ts` precede extension execution.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/rpc/multi-session-host.ts`: `createHostCore` in-process registry options.
- `packages/coding-agent/src/modes/rpc/session-registry.ts`: options and constructor. Worker runtime selection and session policies are unchanged.

## 2026-09-21 - Pause periodic work on retained detach (#1902)

### What changed

- `session-command-router.ts` emits the extension park transition on the last retained attachment release.
- `session-registry.ts` emits resume on the first attachment returning to an open retained runtime. Both transitions join the existing per-entry lifecycle ordering.

### Why

- Retention kept file-watch and cache-warming timers active with no client attached.

### Why an extension could not handle it

- Attachment counts belong to the RPC host; extensions previously had no event for these transitions.

### Expected merge conflict zones

- `releaseOwnedSession` and attach-on-open. Keep eviction, worker runtimes and positive attachment counts unchanged.

## 2026-09-21 - Drop the unreachable control-command guard in the session router (dead-code sweep after #1907)

### What changed

- `session-command-router.ts`: removed the module-level `controls` set and the `if (controls.has(command.type)) return undefined;` line in `dispatch`. Every member of that set (`get_protocol_info`, `list_sessions`, `open_session`, `close_session`) already returns from `dispatch` before that line, so the guard could never match a parsed command.

### Why

- Dead-code sweep over the files #1907 touched: the guard is an unreachable branch (LSP: one reference, itself). No behavior, public API or protocol table changes.

### Why an extension could not handle it

- The router is host-internal; extensions never see this dispatch path.

### Expected merge conflict zones

- LOW: the top-of-file constants and the `dispatch` tail in `session-command-router.ts`.

## 2026-09-21 — a loop stall no longer cuts live peers, teardown cannot leak a scope, and a critical host refuses new workers (#1905)

### What changed

Three changes on the shared in-process host.

- `socket-event-fanout.ts` + `loop-blocked-time.ts` (new) + `loop-lag-watchdog.ts`: the dead-peer
  budget (`DEFAULT_STALL_MS`, 30 s) counts loop-SERVED time. The watchdog deposits every measured
  drift into a process-wide ledger; when the stall deadline fires it asks how much blocked time
  landed inside its window and re-arms for that much (capped at one budget) instead of cutting. Only
  a window the loop fully served with no drain ends in `SocketEventQueueStallError`.
- `session-teardown.ts`: `closeScopeOnce` awaits `disposeOnce()` before `scope.close()`, so the
  grace-deadline path no longer closes the provider scope beside a still-running disposal.
  `config-reload/session-scoped-callback.ts` (new, used for the watch engine's `onRealChange` /
  `onError`) makes a callback bound to a session scope a no-op once that scope closed;
  `@earendil-works/pi-ai/node/provider-scope` gained `activeProviderScope()` for it.
- `host-memory-sampler.ts` + `session-registry.ts` + `session-command-router.ts` +
  `multi-session-host.ts` (wiring) + `worker-session-registry.ts` (no-op `setWorkerAdmission`):
  a second watermark, `SENPI_RPC_HOST_RSS_REFUSE_MB` (default twice `SENPI_RPC_HOST_RSS_WARN_MB`),
  raises `onCritical(critical, rssMb)`; the router forwards it as `registry.setWorkerAdmission(...)`,
  and an `openSession` that would CREATE a `kind: "worker"` session while it is set throws
  `RpcSessionRegistryError("host_memory_pressure", ..., { rssMb, retry_after_ms })`, which the
  router answers as the stable code `host_memory_pressure`.
- `rpc-types.ts`: `RPC_ERROR_HOST_MEMORY_PRESSURE` joins `RpcErrorCode`. Attaches to a live path,
  interactive opens and every existing session are untouched. The stderr pressure line names the
  policy in force.

### Why

One host lost every child of every attached session and then died. Its loop blocked for up
to 893 s; on unblock the wall-clock stall timer ran before the pending drain I/O and cut every
connection with queued bytes (`peer did not drain 358520 queued bytes within 30000ms`), so every
host-session child ended with `transport_gone` while its session kept running. Sessions torn down
during that window hit the grace deadline; their scope was closed beside the running disposal, the
binding's dispose refused with `Provider scope is closed`, and each dead session's config-reload
watch engine - and its watch Worker thread - stayed alive, throwing from its debounce timer on every
filesystem event (149 unhandled errors). RSS grew unbounded past 9 GB into a Bun SIGSEGV in a JSC
Worker thread (three crash reports, uptimes 3.6 h / 15.3 h / 16 h).

A future refactor must not break: the stall budget is served time, never wall time - a deadline
that fires after a long block must re-arm, not cut. `scope.close()` runs after disposal settles on
EVERY teardown path. `host_memory_pressure` is the only memory-driven refusal on the in-process
path, it keys on RSS (never a session count), it applies only to CREATING a worker session, and the
client's answer is to wait and retry - never to start a second host or a per-child process. Pinned by
`test/suite/regressions/issue-1905-*.test.ts` (stall verdict, teardown order, closed-scope callback,
worker admission).

### Why an extension could not handle it

All three live under the host's own loop, transport and registry: an extension cannot see the
socket dead-peer timer, the teardown order of a session it belongs to, or the registry's admission
decision.

### Expected merge conflict zones

`socket-event-fanout.ts` (`waitForDrainOrStall`), `loop-lag-watchdog.ts` (`tick`),
`session-teardown.ts` (`closeScopeOnce`), `host-memory-sampler.ts` (constructor and `sample`),
`session-registry.ts` (`openSession` admission check, `RpcSessionRegistryError.code` union),
`session-command-router.ts` (registry `Pick`, `setMemoryCritical`), `multi-session-host.ts`
(`startHostObservers`), `rpc-types.ts` (`RpcErrorCode`).

## 2026-09-21 — a superseded generation drains itself, and the daemon directory is pruned (#1893)

**What:** five changes that together end a generation nobody can reach.

- `host-supersession.ts` (new) + `socketEntryReplaced` in `socket-ownership.ts`: a generation polls,
  once a second on an unref'd timer, whether the public path still holds the entry it bound. The
  supervisor (`host-lifecycle.ts`) treats the loss as a drain request and runs the SIGUSR1 path it
  already had: park every retained session with no attachment, release its claims, exit when it holds
  no attached session.
- `host-reservations.ts`: a claim carries `attached`, republished through `setAttached` whenever a
  session gains its first client or loses its last (`session-registry.ts`, `session-teardown.ts`).
  A claim now STANDS only while its owner is the generation the pointer names or still has a client
  attached; a superseded, attachment-less claim is reclaimed. The refusal's `owner` carries `current`.
- `host-generations.ts` (new): `pruneDeadGenerations` drops generation directories naming dead pids,
  the pointer while it names one, and claims whose owner is gone - on every registration write
  (`host-daemon-registration.ts`) and on every `host status`. `readGenerationRows` answers one row per
  ALIVE generation with its own `rss_mb` and the number of session files it claims.
- `host-memory-sampler.ts`: `onIdlePressure` fires once per pressure episode for a host above the RSS
  threshold holding NO session; the socket host logs it and drains when it is also superseded.

**Why:** a handoff ASKS the predecessor to drain, and the request can miss - an unprovable owner is
never signalled, a client that binds its own entry over the path signals nothing, a wedged process
misses the signal. The superseded generation then held its retained sessions and all 59 of its path
claims while answering nowhere, so every `open_session` on those paths was refused with
`session_path_in_use` by a process no client could reach, and the directory described only dead pids
while three supervisors were alive.

**A future refactor must not break:** supersession is proven by the socket ENTRY, never by a missing
name - an absent path is somebody's `rm`, and draining on it would end healthy daemons. A claim
without the `attached` field is honored, which is what keeps a running older build from being
reclaimed from. A generation record that cannot be parsed is never pruned: an ensure may be writing
it right now. Pinned by `test/suite/regressions/1893-superseded-generation-drain.test.ts` (real
supervisor, socket taken over with no signal) and `1893-generation-records-and-claims.test.ts`.

## 2026-09-21 - Extension user-edit binding and client leaf visibility

### What changed

- `packages/coding-agent/src/modes/rpc/connection-handler.ts`: binds the extension user-edit action beside assistant edits and forwards navigation's `expectedLeafId` unchanged.
- `packages/coding-agent/src/modes/rpc/rpc-client.ts`: declares `navigateTree`'s already-shipped `leafId: string | null`, accepts the concurrency token, and adds the user-edit client method needed by the interactive host proxy.

### Why

- `packages/coding-agent/src/modes/rpc/connection-handler.ts`: an RPC-hosted extension must have the same capability and typed core refusals as print and interactive extensions.
- `packages/coding-agent/src/modes/rpc/rpc-client.ts`: a wire leaf that library callers cannot read is an incomplete API. The user-edit response preserves both `entry.id` (message address) and the potentially different metadata-advanced `leafId` (concurrency token).

### Why an extension could not handle it

- `packages/coding-agent/src/modes/rpc/connection-handler.ts` owns mode action binding.
- `packages/coding-agent/src/modes/rpc/rpc-client.ts` owns the public client's commands and decoded return types.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/rpc/connection-handler.ts`: extension `commandContextActions` beside navigation and assistant editing; dispatch is unchanged.
- `packages/coding-agent/src/modes/rpc/rpc-client.ts`: result imports, navigation signature, and message-edit methods.

## 2026-09-21 - Dispatch user-message edits and entry-addressed tree selection

### What changed

- `packages/coding-agent/src/modes/rpc/connection-handler.ts` dispatches `edit_user_message`
  through the same session-owned binding as assistant edits. It projects edited, unchanged,
  cancelled, and aborted results, maps core errors through their `.code` accessor, and includes
  the current leaf on successes (`data.leafId`) and refusals (`errorData.leafId`).
- `packages/coding-agent/src/modes/rpc/connection-handler.ts` replaces the temporary `entryId`
  refusal with core tree selection and its navigated/cancelled payload. Both addressing spellings
  forward `expectedLeafId` unchanged; both/neither addressing remain errors. The legacy
  `targetId` call and response shape remain intact.
- Core selection chooses the parent of user/custom entries, including a null parent at the root.
  Contrary to the earlier type entry's description, the shipped `targetId` path also applies that
  rule; it is not a verbatim leaf move. `docs/rpc.md` corrects that claim and explains selection of
  the current prompt after the core early-return fix. Tests preserve the real legacy response and
  prove that both root and non-root prompt retries resubmit without duplicating the prompt.

### Why

`packages/coding-agent/src/modes/rpc/connection-handler.ts` must make the already-typed edit and
selection operations reachable and let a stale client resynchronize without another request.

### Why an extension could not handle it

`packages/coding-agent/src/modes/rpc/connection-handler.ts` owns protocol dispatch and the routed
session binding; an extension cannot implement these top-level command and error envelopes.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/rpc/connection-handler.ts`: message-edit cases, tree-navigation
  dispatch, core error imports, and error response details.

## 2026-09-21 - `edit_user_message`, and `navigate_tree` addressed by `entryId`

### What changed

- `rpc-types.ts` adds the `edit_user_message` command beside `edit_assistant_message`
  (`{ entryId, text, expectedLeafId?, summarize?, customInstructions? }`) and its response member
  carrying the new `EditUserMessageResult` - `edited | unchanged | cancelled`, mirroring
  `EditAssistantMessageResult` field for field, `leafId` nullable on the two non-edited outcomes.
- `navigate_tree` gains a second way to name its target: the shipped `targetId` moves the leaf to
  that node verbatim, while the new `entryId` asks the host to apply the `/tree` selection rule of
  `docs/sessions.md` (a user or custom target selects its PARENT and returns its text as
  `editorText`; any other kind selects the entry itself; the root user message resets the leaf to
  an empty conversation, `leafId: null`). The command is ONE union member intersected with
  `{ entryId } | { targetId }`, so exactly one spelling is legal per record and `case
  "navigate_tree"` still narrows to a single shape. Both spellings accept `expectedLeafId`.
- `NavigateTreeResult` (`navigated | cancelled`) is the `entryId` payload; the shipped
  `{ cancelled, editorText?, aborted?, summaryEntry? }` payload still answers `targetId`, so the
  response member's `data` is the union of the two. Both now report `leafId: string | null` - the
  shipped payload gained it additively, and `connection-handler.ts` fills it from
  `sessionManager.getLeafId()`, so either spelling resynchronizes a client in one round trip.
- `RPC_ERROR_NOT_USER = "not_user"` joins the ONE shared `RpcErrorCode` union beside
  `RPC_ERROR_NOT_ASSISTANT`. The failure response stays the single catch-all member with
  `errorCode?: string` - there is no per-command narrowing in this protocol, and introducing one
  would be a breaking change to every error path. A command's codes are a documented SUBSET.
- `connection-handler.ts` gains the two addressing refusals (`not both`, `requires entryId or
  targetId`) that the command type already forbids but inbound JSON can still carry, plus ONE
  placeholder branch that refuses an `entryId`-addressed navigation with `navigate_tree entryId
  addressing is not dispatched yet`. The selection-rule dispatch and the `edit_user_message` case
  land with the handler work: that branch is replaced there, the two refusals above it stay.

### Why

`AgentSession.editUserMessage` exists, but the only way to reach it over RPC would have been the
interactive `/tree` selector, which no headless client has. A desktop client also cannot compute
the parent of a user entry safely - it would have to reimplement the selection rule against a
tree it only sees through `get_entries` - so the rule belongs on the host, reached by naming the
entry the user clicked. `expectedLeafId` is on both spellings because a navigation is exactly as
destructive to a stale window as an edit is: the leaf token the client last observed is the only
thing that refuses a move made against a view another window has already changed.

### Why an extension could not handle it

The command union and the shared error-code union are the protocol itself. An extension cannot
add a member to the type a client compiles against, and `extension_request` would hide the new
operations behind an untyped envelope, which is the opposite of the contract a desktop client
needs to generate its own types from.

### Expected merge conflict zones

- `rpc-types.ts` - the `RpcSessionCommand` / `RpcResponse` union additions and the `RpcErrorCode`
  members; upstream edits near `edit_assistant_message` and `navigate_tree` meet this change.
- `connection-handler.ts` - the `case "navigate_tree"` guard.

## 2026-09-19 — a pathless session now reserves the file it created (#1850)

**What:** `session-registry.ts` `syncRuntimeMetadata()` reconciles when the canonical
key it holds differs from the key the runtime is writing, not only when the path
moved: `currentPath !== entry.sessionPath || currentKey !== entry.reservationKey`.

**Why:** `open_session` without `sessionPath` puts the created file straight into
`entry.sessionPath` while `reservationKey` stays `undefined` (it was only ever
assigned from `profile.sessionPath`). The paths matched, so the reconciliation block
never ran and the file was never reserved — a later `open_session` on that exact path
missed the `reservations.has` guard and built a SECOND runtime over the same
transcript. On the shared daemon that is cross-client corruption.

**A future refactor must not break:** the canonical-key comparison is what preserves
the original symlink-spelling intent (SessionManager may report a resolved spelling
for a file that did not exist at open); comparing raw paths alone reopens #1850.
Pinned by `test/suite/regressions/1850-pathless-session-reservation.test.ts`.

## A queued open tells its client where it stands (#1844)

The in-process host serves `open_session` one at a time, so a parent fanning out children
queues behind itself: 32 concurrent opens on an idle machine finish in ~14 s with the fastest
taking 10.5 s, and under load the queue crosses the 30 s open deadline. The client's only
signal was `Timeout waiting for response to open_session. Stderr: ` - nothing after it,
because nothing crashed; the request simply never reached the front in time.

The router now sends the opener a `queued` record the moment its open is accepted, before the
open enters the loop: `{ type, for_request, position, in_flight }`. `in_flight` counts opens
accepted anywhere on the host, not just on that connection - every session shares one loop, so
the total is the wait this caller actually faces.

`for_request` carries the opener's request id deliberately, and the record never populates the
response-id field: a client settles pending requests by response id, so a queued record wearing
the open's id would be taken as the open's reply and the real reply logged as a late one.
The record goes to the opening connection only, and is dropped if that connection has already
left - a queue position is worthless to a client that is gone.

This does not make opens concurrent; it makes the queue visible. The serialization itself is
tracked on #1844.

## 2026-09-19 - A queued open tells its client where it stands (#1844)

### What changed

- `rpc-types.ts` adds `RpcOpenQueuedEvent`: `{ type: "queued", for_request, position, in_flight }`.
- `session-event-writer.ts` gains `sendOpenQueued`, addressed to one connection and dropped if
  that connection has already disconnected - a queue position is worthless to a client that left.
- `session-command-router.ts` emits it from `openWithBarrier` before the open reaches the loop,
  counting opens accepted across the whole host rather than per connection.

### Why

The in-process host serves `open_session` one at a time, so a parent fanning out children queues
behind itself: 32 concurrent opens on an idle machine finish in ~14 s with the fastest at 10.5 s,
against ~700 ms for a single open. Under load the queue crosses the 30 s open deadline and the
client saw only `Timeout waiting for response to open_session. Stderr: ` - nothing after it,
because nothing crashed. That silence produced four wrong diagnoses in one investigation. This
does not make opens concurrent; the serialization is tracked on #1844.

### Why an extension could not handle it

Queue depth lives in the router's own in-flight bookkeeping and the record has to leave before the
open reaches the loop. No extension surface observes either: an extension binds to a session that
does not exist yet at that moment, and host status is itself a request on the loop, so it queues
behind the opens it would report.

### Expected merge conflict zones

- `rpc-types.ts` - record union additions.
- `session-event-writer.ts` - the literal `type:` site the desktop event scraper reads.
- `session-command-router.ts` - `openWithBarrier`; upstream edits to the barrier meet this change.

## An open is given its own deadline, measured from when it is sent (#1719)

`SessionWorkerRequests` fixed its open deadline once, at construction: `Date.now() + openMs`.
Every later open shared what was left of that single budget, and once `openMs` had elapsed the
`Math.max(0, ...)` clamp handed the next open a 0 ms timer, which fired on the following tick.
The failure therefore arrived as an instant, silent fallback rather than as a slow open, and it
only showed up under load - because the gap between constructing the queue and sending the open
is exactly what a loaded host stretches.

Non-control commands were never timed and control commands were already budgeted per request;
only the open/handshake path read the shared instant. It now uses `SESSION_WORKER_LIMITS.openMs`
at send time, so each open gets its full budget and a genuinely stalled open is still bounded.

## An ensure never ends a host whose socket still accepts connections

A host serving many sessions can miss the 10 s `get_protocol_info` budget while its event loop is
busy. `probeProtocolInfo` collapsed every failure - unreachable, refused, slow - into "no answer",
and `ensureHostLocked` read that as a silent socket: if the pid was alive and this process had
written the record, it SIGTERM'd the host and started a replacement, destroying every live session.

The probe now reports whether the socket ACCEPTED the connection. A reachable-but-silent socket is
refused as `host_busy` instead of signalled, so the caller retries or falls back; only a socket that
cannot be connected to at all takes the stop-and-start path.

## 2026-09-18 - The RPC reference describes the daemon that shipped, cap-free and honestly priced (#1782)

### What changed

- `docs/rpc.md` "Session runtime": the in-process runtime now states its MEASURED cost - ~1 OS thread, ~2 file descriptors and 6-8 MB of RSS per open session, linear to 1,000 sessions (1,023 threads, 5.9 GB), with the thread attributed to the `config-reload` builtin's per-session watch Worker (senpi#1794) rather than to the session runtime, which allocates none. "Flat" is not claimed anywhere, because it is not true.
- `docs/rpc.md` occupancy section: retitled "Shared host occupancy (idle eviction, retention, empty-host exit)" - the old title advertised a "session cap" the daemon does not have. It now opens with the daemon having NO session limit, no admission counter and no eviction-for-room, and the 20-worker paragraph is scoped to the worker runtime (stdio hosts, embedders, an explicit `--session-runtime worker`), naming it as the only source of `too_many_sessions`.
- `docs/rpc.md` invariants: I3 (only the owning generation writes daemon state; every other client reads and fails closed) and I4 (worker sessions invisible without `include_workers: true`) join I1/I2 under "Attach, start or refuse", so the four invariants every client surface must keep are in one place.
- `docs/rpc.md` "The no-sync rule" (new, under host self-observation): the ban list, the ban-with-ledger audit that enforces it inside the engine, the same rule restated for extension authors where nothing can enforce it, and `host_stalled` as the report that names an offender.
- `docs/rpc.md` "Verifying a daemon build" (new): the two live QA drivers - `scripts/qa-rpc-socket/inprocess-daemon-qa.mjs` and `scripts/qa-rpc-socket/generation-handoff.mjs` - with what each proves and the receipt they end on.
- `docs/rpc.md` event table: `session_opened`, `session_closed` (with the `handoff_parked` reason), `session_parked` and `session_replaced` are listed as event types instead of being described only in prose; the kind/context section links the extension-side view.
- `src/modes/rpc/AGENTS.md`: the structure block covers the host-lifecycle and daemon-state modules and both session runtimes; new "Shared-daemon invariants (I1-I4)" and "The no-sync rule" sections; the where-to-look table gains the decision, handoff, daemon-state, `senpi host` and observability rows; validation lists the daemon suites, the fixture-reaper receipt and the two QA drivers.

### Why

- The reference still described the shape the host had BEFORE the in-process runtime became the socket default: a heading promising a session cap, and a 20-worker paragraph written as the rule rather than the worker-runtime exception. A client integrator reading it would have built admission control and sharding against a daemon that refuses nothing.
- The per-session cost is published because "unlimited" is only honest next to a number. The plan's phrasing ("thread count flat") did not survive measurement: threads grow ~1 per session with no plateau, and naming the cause (senpi#1794) is what lets an operator size a host and a maintainer fix it.
- I3 and I4 were enforced by code and proven by tests, but stated nowhere a client author would read. An invariant a second implementation cannot find is an invariant the second implementation breaks.
- The no-sync rule is the price of one loop serving every session, and extensions are the part of that loop no audit can gate - so it is documented where extension authors look, not only in the test that enforces the engine half.

### Why an extension could not handle it

- Documentation of the engine's own process-lifecycle and wire contracts; an extension cannot publish the protocol reference clients read before they connect.

### Expected merge conflict zones

- LOW: `docs/rpc.md` sections upstream rarely touches (multi-session host lifecycle, occupancy, event table) and this fork's own `AGENTS.md`.

## 2026-09-17 - `senpi host` - one command every client calls for the shared daemon (#1782)

### What changed

- `src/modes/rpc/host-runner.ts` (new): the four host requests as a discriminated union (`ensure` / `status` / `stop` / `handoff`, each carrying only its own fields) and `runHostRequest`, which performs one and answers `{ exitCode, payload }`. This is the whole behaviour behind the command, separated from the command line that expresses it, so the desktop and the omo launcher can drive it in-process. Ensure composes `probeHost` -> (policy `fallback`: `decideHostAction(..., "fallback")` -> exit 4) -> `ensureHost({ upgrade })` -> `probeHost`, and reports `action: "handoff"` exactly when the socket was already served and the instance id changed. Stop gates a hard stop on `foreign_attached + foreign_retained == 0` and prints the counts either way; a `--drain` is never gated. Handoff maps `handoff_unsupported` and win32's `upgrade_unsupported` onto ONE reason (`upgrade_unsupported`, with the original in `detail`), because to a caller they are the same answer: this build may not replace the running generation.
- `src/cli/host-command.ts` (new): the CLI surface - argv to a typed request, the usage text, and the ONE JSON line. The line is written with a synchronous `writeSync(1, ...)`, because `console.log` to a pipe is asynchronous and the `process.exit` that follows would truncate the only thing the caller parses. Exported as `runHostCommand(args) -> exit code`.
- `src/modes/rpc/host-launch-spec.ts` (new): what a launch spec IS (`spec_version`, `core.{session_runtime,multi_session,extensions}`, `tunables`, `env`), the boundary parse that produces it, and the trust proof - owner/mode of the file, extension containment inside the spec directory (lexical AND through `realpath`), the `^(SENPI|OMO|PI)_[A-Z0-9_]+$` env gate, and existence of every listed extension. Each failure is a `HostLaunchSpecError { reason, detail }` the CLI reports with exit 2.
- `src/modes/rpc/host-daemon-env.ts` (new): the daemon's environment ALLOWLIST, `daemonEnvOverrides` (every denied name mapped to `null`, which is how `ensureHost({ env })` removes an inherited variable), `daemonEnvKeys`, and the `env-keys.json` the ensuring client records in the daemon directory so `status` can report the scope a running daemon was granted. Case-sensitive on POSIX, case-insensitive on win32 plus the OS wiring (`SystemRoot`, `ComSpec`, `PATHEXT`, ...) a spawn there cannot run without.
- `src/modes/rpc/host-status.ts` (new): one record describing a daemon - identity from `get_protocol_info`, occupancy from `list_sessions`, generations and env scope from the daemon directory, process metrics from the OS - plus `readSessionCounts` (the numbers the stop gate is made on) and `hostSummary` (the `host` field of a refusal). An unreachable socket answers the SAME shape with `reachable: false`.
- `src/modes/rpc/host-process-metrics.ts` (new): `rss_mb`, `open_fds` and `zombies` for the daemon's whole process TREE (the registered pid is the supervisor; the host holding every session is its child), from one `ps -A` reading, with `/proc/<pid>/fd` for descriptors where it exists. Every field is `number | null`, and a failing probe degrades the report instead of failing the status.
- `src/cli/deferred-commands.ts` + `src/main.ts`: `dispatchHostCommand(args)` beside the app-server route, answering an exit CODE rather than a boolean, behind an `await import(...)` so `dist/main.js` still does not statically reach the host graph. It runs before `parseArgs`, so `host` never reaches the interactive path.
- `src/modes/index.ts` + `src/index.ts`: `runHostCommand`, `runHostRequest`, `readHostStatus`, `loadHostLaunchSpec`/`parseHostLaunchSpec` and their types are exported for the launcher and the desktop.
- `docs/rpc.md`: "The `senpi host` command" documents the four subcommands, the exit-code table, the status shape, the launch spec with its four refusals, and the daemon environment scope.
- Tests: `test/suite/host-cli.test.ts` (ensure start/reuse, the exact `status` shape, and the daemon's own environment read from the OS), `test/suite/host-cli-stop.test.ts` (a second connection holding a real session: refuse with counts, then `--force` past it to an ENOENT socket), `test/suite/host-cli-spec-trust.test.ts` (usage, the four spec refusals - each proven to leave NO daemon behind - a spec whose extensions reach the host's launch profile, and a handoff refused against a host that cannot drain), `test/suite/host-launch-spec.test.ts` (parse edges, a symlinked escape, the allowlist per platform) and `test/suite/host-cli-support.ts` (sandbox, spawned CLI, sweep).

### Why

- Every client was about to grow its own copy of "find the daemon, decide, start it, report it": the terminal, the desktop, the omo launcher and the task runner. That decision has invariants that cannot survive four implementations (never signal a host you did not start; compatibility is protocol plus capabilities, never a version string), so it ships as ONE command with a machine-readable contract.
- The spec is a file with an owner check because it chooses the extensions of a process that outlives the client and serves everyone on the machine. Nothing about stdin or an argv blob can be owner-checked, and a half-loaded profile is worse than no daemon - so a missing extension refuses to start rather than booting a daemon that would serve every client with half a profile.
- The environment allowlist exists for the same lifetime reason: a secret exported in one terminal was previously inherited by a daemon that answers other clients for hours. Names are matched, values are never read, and `status` publishes names only.
- `rss_mb`/`zombies` describe the process tree rather than the registered pid because that pid is the supervisor: reporting only it would answer "3 MB" for a daemon holding two gigabytes.

### Why an extension could not handle it

- This is the process-lifecycle surface of the engine itself: it decides whether a daemon is started, replaced, or refused, and it runs before any extension is loaded - a spawned daemon's extension set is one of its INPUTS.

### Expected merge conflict zones

- LOW: one import block plus one dispatch branch in `src/main.ts`, one new dispatcher in `src/cli/deferred-commands.ts`, and additive export lists in `src/modes/index.ts` / `src/index.ts`. Everything else is new files.


## 2026-09-17 - Name why a session closed or parked, and when the host stalls (#1782)

### What changed

- `rpc-types.ts`: `RpcSessionClosedReason` is the full vocabulary (`client_close` / `idle_evicted` / `host_shutdown` / `replaced` / `handoff_parked` / `error`). `RpcSessionClosedEvent` carries optional `reason` - absent on the wire unless the caller names one, never required in decoders.
- `session-event-writer.ts`: `closeSession` still omits `reason` when the caller does not pass one. Explicit close admission reserves the `client_close` bytes; overflow seals with `error`. `broadcastHostRecord` reconstructs `host_stalled` and `host_memory_pressure` from a typed switch so desktop `scripts/refresh-senpi-events.ts` (which scans literal `type:` sites in this file) sees both, plus the existing `session_closed` / `session_parked` literals.
- `session-command-router.ts`: callers pass the reason. `close_session` -> `client_close`; idle sweep of a non-retained session -> `idle_evicted`; idle sweep of a retained session with a path still emits `session_parked` instead of a close; drain still -> `handoff_parked`; `dispose()` (host exit) -> `host_shutdown`.
- `session-worker-client.ts`: a worker failure seals with `error`.
- `multi-session-host.ts`: socket shutdown disposes the router and flushes WHILE connections are still registered, then detaches. SIGTERM can therefore deliver `session_closed { reason: "host_shutdown" }` instead of dropping the socket first.
- Docs: `docs/rpc.md` Event Types table and a `session_closed.reason` / `session_parked` / `host_stalled` / `host_memory_pressure` section; occupancy idle-eviction names `idle_evicted` vs `session_parked` vs `host_shutdown`.
- Tests: `test/suite/rpc-inprocess-host.test.ts` asserts each path (explicit close, idle non-retained, idle retained -> `session_parked`, drain -> `handoff_parked`, host SIGTERM -> `host_shutdown`, and SIGTERM of a retained session still `host_shutdown` not a park).

### Why

- A parked session and a closed session used to be indistinguishable on the wire except for the new `session_parked` type, and a host going away looked like a dropped socket. Clients (desktop threads, senpi-task) need the reason to choose reopen-by-path vs forget vs reconnect-to-new-generation vs show an error.
- `reason` stays optional so an older client, and any record emitted before this vocabulary, keep working. Making it required in a decoder would fail closed against every host still in the field.

### Why an extension could not handle it

- These are host lifecycle records on the RPC wire. Extensions never see `session_closed` or emit it; the desktop event scanner reads the engine's `type:` literals.

### Expected merge conflict zones

- MEDIUM: `SessionEventWriter.closeSession` / `reserveCloseResponse` / `broadcastHostRecord`, `SessionCommandRouter.close` / `evictIdleSession` / `dispose`, and the socket-host shutdown order in `multi-session-host.ts`. Anything upstream that also emits `session_closed` or tears connections down before dispose conflicts there.
- LOW: the reason union in `rpc-types.ts`, the docs Event Types table, and the new cases in `rpc-inprocess-host.test.ts`.

## 2026-09-17 - The created host modules go back under the file-size ceiling (#1782)

### What changed

- `src/modes/rpc/host-daemon-paths.ts` (restored): WHERE one socket's daemon keeps its state - `createHostDaemonPaths`, `generationPaths`, `daemonDirectoryName`, the `HostDaemonPaths`/`HostGenerationPaths` shapes, the layout marker, the 0700/0600 mode bits, `createDaemonDirectories`/`createGenerationDirectory` and `HostDaemonStateError`. This is the module the layout-2 change had folded INTO `host-daemon-state.ts`; folding it in is what pushed that file to 399 lines, so it is a file again.
- `src/modes/rpc/host-daemon-state.ts` now holds only WHAT the settings say (`HostDaemonSettings`, `writeHostSettings`, `readHostSettings`) plus the three primitives every state file goes through (`writeStateFile`, `readFileOrUndefined`, `parseJson`, and the `isRecord` guard), shared with the registration module.
- `src/modes/rpc/host-daemon-registration.ts` (from the previous entry) keeps the pointer and generation RECORDS and the ownership predicates.
- `src/modes/rpc/host-protocol-info.ts` (new, out of `host-decision.ts`): the `HostProtocolInfo` shape and the tolerant boundary parse that produces it (`parseHostProtocolInfo`, `parseOrdinal`, `parseLaunchProfile`). The decision module now imports the type and re-exports both for its existing callers, so `host-decision.ts` is the truth table and nothing else.
- `src/modes/rpc/host-successor.ts` (new, out of `host-handoff.ts`): bringing the successor generation up - the bind path and its length guard, the settings and environment it is launched with, the spawn, the readiness observation on the PUBLIC socket (`awaitSuccessor`), the registration, the drain signal to the predecessor, and `abortReason`. `host-handoff.ts` is now the DECISION half: probe, the `generation_handoff` capability guard, the win32 refusal, the owner proof, and the refusal/result vocabulary.
- Importers follow the seams; no test assertion changed.
- `scripts/qa-rpc-socket/ensure-host.mjs`: brought to the compatibility contract this plan introduced. It asserted that a host with a different `serverVersion` is REPLACED, which is exactly the behaviour the capability/ordinal decision removed - so the driver was asserting a defect. It now proves, live against the real `ensureHost`: a fresh start, a reuse of that same host, a host advertising protocol 1 plus every required capability under a DIFFERENT `serverVersion` being REUSED rather than replaced, and a host missing `session_context` being REFUSED (`capability`) while staying alive - the refusal holding even though the registration names this process as the writer, which would otherwise permit a stop.

### Why

- Measured with `awk '!/^[[:space:]]*$/ && !/^[[:space:]]*\/\//' <file> | wc -l`, the files this work created were over the 250 ceiling: `host-daemon-state.ts` 399, `host-handoff.ts` 258, `host-decision.ts` 251. After the split: paths 149, state 83, registration 204, decision 200, protocol-info 66, handoff 100, successor 173, stop 80 - every created module under the ceiling, with `host-probe.ts` 106, `host-launch.ts` 45 and `host-reservations.ts` 136 unchanged.
- Each cut follows a seam the code already had: where files live vs what they contain; the wire parse vs the decision that consumes it; bringing a generation up vs deciding whether it may be brought up at all. No "utils" bucket was created.
- Pure move: a scripted symbol-body comparison against the previous commit (66 symbols before and after, comments and whitespace normalized) reports zero lost symbols and exactly one changed body - `startSuccessor`, which gained `export`. `writeStateFile`, `readFileOrUndefined`, `parseJson` and `isRecord` had already been exported by the previous split.

### Why an extension could not handle it

- Module boundaries inside the engine's host-lifecycle code; nothing about it is reachable from an extension.

### Expected merge conflict zones

- LOW: mechanical import moves plus three new files. Anything upstream that also edits the import blocks of `host-ensure.ts`, `host-handoff.ts` or `host-lifecycle.ts` conflicts on those lines only.

## 2026-09-17 - One daemon directory per socket, and no pidfile a legacy client can act on (#1782)

### What changed

- `src/modes/rpc/host-daemon-state.ts`: layout 2 lands IN the module that already owned the daemon state (where the files are and what they say is one responsibility; it measures 281 pure LOC against the 250 guideline - a deliberate call, recorded here rather than hidden, because a second paths helper beside this one is the thing worth avoiding). `createHostDaemonPaths({ socket, agentDir })` -> `<agentDir>/rpc-host-daemon/<sha256(canonical socket)[:16]>/` with `host.pid` (pointer), `settings.json`, `daemon.lock`, `stderr.log`, `generations/`, `reservations/`; `generationPaths(paths, instanceId)` -> `generations/<instanceId>/{host.pid,settings.json,scratch/}` plus the `generations/<instanceId>` string the pointer carries. `createDaemonDirectories` creates the chain at `0700` (mode set explicitly with `chmod`, because a directory that already exists keeps the mode it was created with) and writes the FLAT `layout.json { layout: 2, dir }` - the only file this build puts in the shared directory. Every failure becomes `HostDaemonStateError { path }`, so an unwritable directory names the path instead of surfacing a bare `EACCES`. `daemonDirectoryName` is deliberately total: it canonicalizes (POSIX path as-is, win32 `normalize().toLowerCase()`) without going through `resolveSocketTransportAddress`, which THROWS on a non-drive-qualified win32 path - naming a directory must never fail on a path shape the transport would reject.
- The pointer/record split in the same module: `readHostRegistration` reads the pointer, resolves `generations/<instance_id>/host.pid` and returns `{ record, writer, socket, instanceId, generation }`; `writeHostRegistration` writes the generation record (`{ pid, processStartTime, instance_id, generation, engineVersion, engineOrdinal, launchProfileId, socket, writer }`) and then moves the pointer onto it by `rename`, so no reader ever sees half a pointer. `clearHostRegistration` drops the pointer, the generation it names and the boot settings; `releaseGeneration` drops ONE generation while the files still name it, which is what lets a predecessor drain and exit after a handoff without deleting the successor's pointer. `readLegacyHostRecord` reads the flat pidfile and nothing else writes or removes it. `writeHostSettings` publishes the settings in both places they are read (the daemon directory for the supervisor's boot, the generation directory as the record of what that generation was started with).
- `host-ensure.ts`: `ensureHost` resolves the per-socket directory and `createDaemonDirectories` before taking the endpoint lock (unchanged: `<tmp>/senpi-rpc-host-locks/<sha256(socket)[:32]>.lock`). `startHost` mints the generation's `instanceId` BEFORE the spawn - the generation directory has to hold its settings before the host boots - and hands it to the host as `SENPI_RPC_HOST_INSTANCE_ID` along with `SENPI_RPC_HOST_DAEMON_DIR`; both are always SET, never inherited. A new guard sits in front of the start path: a flat pidfile whose process is still alive refuses with `HostEnsureRefusedError` reason `legacy_host` (added to `HostRefusalReason`), so a v2 ensure neither signals a legacy host nor binds a socket it may still be serving. An unreadable identity on a LIVE legacy pid counts as alive.
- `protocol-identity.ts`: `HOST_INSTANCE_ID_ENV`. A host uses the id its ensure chose (so `generations/<instanceId>` is the same id `get_protocol_info` reports) and mints its own when nobody ensured it.
- `host-stop.ts` also owns `signalGeneration(pid, signal)`: the ownership proof cannot close the window between proving an owner and signalling it, because a host is free to exit in between - a drained generation with an empty registry reaches its empty-exit about 660 ms after SIGUSR1 (measured on this branch). Delivery failure `ESRCH` therefore means "already gone", which is the outcome every caller here asked for, and is reported rather than thrown; any other signalling failure still throws. `stopHost` (drain and hard stop) and the handoff's SIGUSR1 to the predecessor go through it, so a stop against a host that just left answers `drained`/`stopped` instead of surfacing a raw `kill ESRCH`.
- `host-handoff.ts` + `host-stop.ts` (new): the successor gets its own `instanceId` and generation directory, and the pointer moves onto it only after it answers on the PUBLIC socket. `stopHost` moved into its own module - ending a generation is a different act from replacing one, and the handoff module had grown past the 250-line ceiling with the registration work - and a hard stop now drops the stopped generation's registration (`releaseGeneration`); a draining host keeps its registration until it exits, because it is still serving. The owner proof both modules need (`provenOwner`, formerly `drainableOwner`, now also returning the instance id it proved) moved to `host-daemon-state.ts`, which is where "who may act on this record" already lives. The barrel exports `stopHost` from the new module.
- `host-lifecycle.ts` (supervisor): resolves its paths from `launch.socket`, learns its generation from `SENPI_RPC_HOST_INSTANCE_ID` (a direct `--internal-rpc-host-supervisor` launch names itself so its child agrees), passes the daemon directory and instance id to the host child, lists the pointer AND its generation record in the child's crash-cleanup paths for an ordinary start (a successor still passes none), and releases only its own generation on shutdown.
- `host-reservations.ts` + `multi-session-host.ts`: `createEndpointReservations({ agentDir, socket, instanceId })` decides WHERE claims go, in the module that already defines what they are. The directory comes from `SENPI_RPC_HOST_DAEMON_DIR` (a supervised host binds a private hop, so it cannot derive the public endpoint's directory from what it listens on), falling back to the endpoint it listens on; a stdio host has no daemon directory, no successor generation and therefore no cross-process claim to publish.
- Docs: `docs/rpc.md` gains "Daemon state directory (layout 2)" with the tree, the modes, the canonical-socket rule and the fail-closed rationale; the ownership-state line, the reservations path, the handoff registration step, the `stopHost` paragraph and the win32 internal-hop path all name the per-socket directory.
- Tests: `test/rpc-host-daemon-dir.test.ts` and `test/rpc-host-legacy-fail-closed.test.ts` (new, sharing `test/helpers/rpc-host-daemon-sandbox.ts`) derive the directory name from the socket ITSELF (`sha256`, the way a client does) and pin the pointer/record contents, the `0700`/`0600` modes, a flat directory holding only `layout.json`, `stopHost` clearing pointer + generation directory, an unwritable directory failing as `HostDaemonStateError` naming that path with nothing spawned, and a live legacy flat pidfile refusing as `legacy_host` with the file byte-identical afterwards. The two fail-closed proofs are copies of the DEPLOYED clients: `readManagedHost` from the `v2026.9.16-3` desktop returns undefined against this directory, and that release's `ensureHostLocked` (spies in place of its spawn and stop) throws "owned by an unmanaged host" without stopping anything - the case that used to live in `rpc-host-ensure.test.ts` against a hand-made layout, now against the real one. `rpc-host-ensure.test.ts`, `rpc-host-lifecycle.test.ts`, `rpc-host-handoff.test.ts` and `rpc-host-identity-regression.test.ts` register hosts in the v2 shape; the handoff suite additionally asserts the pointer names the NEW generation's instance id. QA drivers (`ensure-host.mjs`, `host-lifecycle.mjs`, `compiled-host.mjs`, `interactive-host.mjs`, `generation-handoff.mjs`) read the registration through `readHostRegistration` instead of a flat path.

### Why

- One flat pidfile per AGENT DIRECTORY was ambiguous the moment a second socket appeared, and it was the wrong ownership unit for a machine-wide daemon: the state that decides who may signal a host has to be keyed by the host's endpoint.
- The absence of a legacy-parseable flat `host.pid` is the ONLY protection that holds regardless of the order clients update in. Measured against the published `v2026.9.16-3`: its ensure finds a flat pidfile it can parse, calls the new host incompatible (`serverVersion === VERSION`) and calls `stopManagedHost` - the RED captured in this change shows exactly that takeover firing, and the same file's absence turns it into a refusal. A dual-write "for compatibility" would therefore hand every deployed client a licence to kill the daemon.
- A pointer plus per-generation records is what makes a handoff safe on disk: two generations are alive at once, so a single record file would have to be overwritten while the host it describes is still serving. Separating them also gives the predecessor a way to clean up after itself (`releaseGeneration`) that cannot touch the successor's registration.
- The instance id is chosen by the ensure rather than the host because the generation's directory has to exist - with its settings - before the host boots. It is also the id the host reports, so a pointer naming a different id than the socket answers is visibly stale rather than silently wrong.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- This is the on-disk ownership evidence of the host process: which directory names an endpoint, which file authorizes a signal, and which file a foreign client must NOT be able to parse. No extension is loaded when those decisions run, and the failure mode of getting them wrong is another client's daemon being killed.

### Expected merge conflict zones

- MEDIUM: `host-ensure.ts` (paths, the start path, the environment), `host-handoff.ts` (successor registration, `stopHost`) and `host-lifecycle.ts` (startup, cleanup paths, shutdown) all move in several places, and `HostDaemonPaths` changed shape (`pidFile` -> `pointerFile`, plus `flatDir`/`generationsDir`/`reservationsDir`). Anything upstream that reads `paths.pidFile` or calls `createHostDaemonPaths(agentDir)` positionally conflicts there.
- LOW: the new paths module, the docs section, and the suites that register hosts by hand.

## 2026-09-17 - Test hosts are reaped with their sandbox, and the protocol fixture will not outlive it (#1782)

### What changed

- `test/fixtures/rpc-host-fixture.mjs`: two self-terminating bindings. The fixture exits when the socket path it serves disappears (POSIX; on win32 the sandbox directory holding its secret is the equivalent evidence), and when it has been reparented because the process that started it is gone. Both are checked on one unref'd 500 ms interval, so the fixture is never the reason a test process stays alive. Measured: a SIGKILLed parent leaves the fixture dead in ~50 ms.
- `test/helpers/spawned-host-reaper.ts` (new): `killAndWait(child)` (kill AND await the exit, so teardown cannot outrun it), `reapProcessesUnder(root)` (SIGKILL every process whose argv names a per-test `mkdtemp` sandbox AND every descendant of those processes, then wait for each pid to disappear), plus the shared `processAlive`/`waitForPidGone` the three host suites had copied between them. Descendants have to be included because a supervisor's host CHILD is named by its own private socket rather than by the sandbox, while it keeps writing into that sandbox until it notices its supervisor is gone - which lands after the removal and recreates the directory just deleted (observed: five leftover sandbox directories per handoff-suite run, with no process left in them). `processAlive` reads `ps -o stat=` and treats a ZOMBIE as gone: a host whose supervisor was SIGKILLed has no parent left to reap it, so its pid stays addressable for a moment after it exits.
- `test/rpc-host-ensure.test.ts`, `test/suite/regressions/1290-rpc-host-ensure-startup-error.test.ts`, `test/rpc-host-lifecycle.test.ts`, `test/rpc-host-handoff.test.ts`: every sandbox is swept before it is removed, and children are awaited rather than merely signalled. The ensure suite also gains two cases for the fixture's own bindings ("exits when the socket it serves disappears", "exits when the process that started it is gone").

### Why

- Measured on a developer machine: 19 live `rpc-host-fixture.mjs` processes, the oldest 10 h 39 m old, while `<tmp>/senpi-host-ensure-*` held ZERO directories - hosts outliving the sandboxes they were started in. Every leaked process carried `-unreadable-identity-` in its argv, which names the cause exactly: that case registers a host with `processStartTime: null` on purpose (the probe was starved), and the teardown's pidfile-based stop requires a string start time, so it skipped the very host the case had just started. The child itself was spawned by `ensureHost` - detached, pid only - so the suite held no handle either.
- The fix is two independent guards because each covers what the other cannot. The sandbox sweep reaps hosts no registration can name, including ones production code spawned; the fixture's own watch covers the case where no teardown runs at all, such as a SIGKILLed test runner or a crashed worker.
- A suite that strands hosts for hours also makes this plan's zombie claim unverifiable, since the measurement it rests on counts processes of exactly this kind.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- Test-only: a fixture process and the teardown of the suites that spawn it. No production code changed.

### Expected merge conflict zones

- LOW: one new test helper plus the `afterEach` blocks of four suites. Anything upstream that also rewrites those teardowns conflicts there.

## 2026-09-17 - A newer generation takes the socket while the old one drains (#1782)

### What changed

- `src/modes/rpc/host-handoff.ts` (new): `handoffHost({ socket, agentDir, hostArgs, env, policy })` performs a GENERATION HANDOFF and `stopHost({ socket, agentDir, drain, force })` ends one. The handoff spawns the successor with `--socket <public> --bind <public>.next-<gen> --replace <dev>:<ino>`, waits for a `get_protocol_info` answer on the PUBLIC socket whose `instanceId` differs from the generation being replaced, registers it (pidfile + `settings.json { socket, generation }`, the running generation's `coldStart`/`idleExitMs` carried forward), and only then sends the predecessor SIGUSR1. Refusals are typed and leave everything running: `no_host`, `handoff_unsupported` (the host does not advertise `generation_handoff`, and SIGUSR1 would kill it), `upgrade_unsupported` (win32), `unknown_owner` (the pidfile cannot prove which process serves this socket - I1), `socket_replaced`, `socket_path_too_long`, `successor_unavailable`. `stopHost({ drain: true })` is the same SIGUSR1 under the same two guards; a hard stop requires a host that reports no sessions, or `force`.
- `host-ensure.ts`: `EnsureHostOptions` gains PUBLIC `hostArgs`, `env` (a `null` value REMOVES an inherited variable) and `upgrade: "never" | "if-engine-differs"` (default `never`); `_test.hostArgs`/`_test.env` are gone and `_test.launch` (supervisor argv -> spawnable command) replaces the fixed `_test.spawn` for callers that need the real argv. Under `if-engine-differs` the ensure runs `decideHostAction` with policy `upgrade` and a launch profile derived from its own `hostArgs`, and a `handoff` decision calls `handoffHost`; a refused handoff ATTACHES (an upgrade that cannot happen never becomes a stop). The pidfile now records `socket`, and a record naming a DIFFERENT endpoint is neither signalled nor cleaned - today's daemon directory keeps one pidfile per agent directory, so an ensure for a second socket used to read the first socket's daemon as its own and stop it.
- `host-daemon-state.ts`, `host-probe.ts`, `host-launch.ts` (new, extracted from `host-ensure.ts` so the handoff can share them without a cycle): the daemon paths + pidfile/settings reader-writer (including the `writer` stamp and the new `socket` field), the socket probe (`probeHost`, `probeProtocolInfo`, `probeSessionCount`), and the supervisor launch (`defaultHostLaunch(supervisorArgs, compiled)` now takes the whole supervisor argv, so a bind/replace launch goes through the same re-entry route; `PINNED_HOST_CLIENT_CAPABILITIES` moved with it). `host-ensure.ts` re-exports all three, and shrank from 558 to 473 pure LOC.
- `host-lifecycle.ts` (supervisor): `--bind <path>` and `--replace <dev>:<ino>`; `prepareSocketPath`/`listen` target the BIND path and refuse any path over 103 bytes before binding; after the host answers, `adoptPublicSocket` re-stats the public path and renames its own entry over it ONLY while that path still holds the expected entry, then `publicSocketIdentity` is taken against the PUBLIC path and published as the ownership token. SIGUSR1 (POSIX only) = drain: stop accepting (the accept guard rejects new connections; the listening handle is deliberately NOT closed, because libuv unlinks a pipe's bound NAME on close and that name is the successor's entry), forward SIGUSR1 to the host child, and exit when the child does. Shutdown removes the pidfile and settings only while they still name THIS process, so a successor's registration survives the predecessor's exit; a generation launch also passes no state-file paths in the child's crash-cleanup list.
- `multi-session-host.ts`: a socket host advertises `generation_handoff` and installs the SIGUSR1 drain (park everything, then exit through the empty-host path even with the supervisor's observer connection attached); the drain also empties this host's copy of the crash-cleanup paths, since after a handoff those files describe the successor. The in-process registry is now built with a file-backed `pathReservations`.
- `host-reservations.ts` (new): `<agentDir>/rpc-host-daemon/reservations/<sha256(canonical path)[:16]>.json` = `{ instanceId, pid, processStartTime, sessionPath }`, written on open and removed on close/park. A claim whose owner is dead (or whose pid was recycled - the start time decides) is ignored, and a directory that cannot be written logs once instead of failing the open.
- `session-registry.ts`: an open for a `sessionPath` takes the in-process reservation synchronously (unchanged) and then consults the cross-generation claim; a live FOREIGN claim throws `session_path_in_use` carrying `{ owner, retry_after_ms: 2000 }` through the new `RpcSessionRegistryError.detail`, which `session-command-router.ts` publishes as `errorCode`/`errorData`. `syncRuntimeMetadata` moves the claim when a replacement moves the session file.
- `session-command-router.ts`: `beginDrain()` parks every session with zero attachments and no session-owned work (the same teardown the idle sweep uses) on a 50 ms unref'd sweep, and calls the host's empty-exit hook once the registry is empty; the terminal record for those is `session_closed { reason: "handoff_parked" }` (`session-event-writer.ts` gained the optional `reason`, typed as `RpcSessionClosedReason` in `rpc-types.ts` - the full vocabulary is a separate change).
- `host-watchdog.ts`: the inherited supervisor pipe is watched with a `net.Socket` instead of a file stream. REQUIRED, not cosmetic: a file-stream read parks a libuv thread-pool worker in `read(2)` for the host's whole life, and `process.exit()` joins the thread pool - so every self-exit of a supervised host hung until something killed it (measured: the drained host reached its last shutdown line and then sat in `uv_thread_join`). An anonymous pipe reports EOF through the event loop; a named FIFO does not on macOS, so the three watchdog unit tests now drive a REAL inherited pipe through `test/fixtures/rpc-watchdog-pipe.ts` - the production binding - instead of a FIFO stand-in.
- `socket-ownership.ts`: `MAX_SOCKET_PATH_BYTES` (103) and `generationBindPath(socket, generation)`.
- Barrel: `handoffHost`, `probeHost`, `stopHost` and their option/result types, plus `HostUpgradePolicy`.
- Docs: `docs/rpc.md` gains "Generation handoff" (the three steps, both fail-closed guards, win32, the `ensureHost` options) and "Session paths across generations"; the `session_path_in_use` row and the parking paragraph carry the new `errorData` and `handoff_parked` reason.
- Tests: `test/rpc-host-handoff.test.ts` (new) runs two REAL supervisors on one socket - a connection opened before the handoff still answers `get_state` while a new one reaches a different `instanceId`, the inode changes exactly once, the predecessor exits without unlinking the public socket and the successor's pidfile survives both that orderly exit and a SIGKILL of the drained supervisor, a retained session mid-turn answers `session_path_in_use { owner, retry_after_ms }` until it parks (`session_closed { reason: "handoff_parked" }`) and then reopens in the new generation with an intact JSONL, `stopHost({ drain: true })` exits a generation after its sessions park, and a public socket stolen by an unmanaged server aborts the handoff with nothing renamed or unlinked. `test/rpc-host-ensure.test.ts` gains the default-`never` policy, the older-ordinal client, the legacy host that is never renamed or signalled, win32 `upgrade_unsupported`, and the second-socket case. `scripts/qa-rpc-socket/generation-handoff.mjs` (new) is the same story against a sandbox agent directory for live QA.

### Why

- One machine-wide daemon holds every client's sessions, so "upgrade" cannot mean "kill it and start the newer one" - that is a data-loss operation dressed as a version bump. The handoff replaces the process while its work continues, which is the only shape of upgrade this daemon can offer.
- The successor binds `<public>.next-<gen>` rather than the public path because it has no right to unlink an endpoint another process is serving; `rename(2)` is what makes the switch atomic for every reader of the path, and `--replace <dev>:<ino>` is what keeps that rename from replacing a socket somebody else put there in the meantime.
- SIGUSR1's default disposition is TERMINATE. A host that does not advertise `generation_handoff` therefore must never be signalled - the drain request would be the kill the whole change exists to avoid - and the capability advertisement is exactly the proof that a handler exists.
- The predecessor keeps its listening handle open while draining because closing it would unlink the successor's socket entry by name. Nothing can reach that listener any more (the name moved), so the only thing the close would achieve is deleting the endpoint every client is now using.
- Two generations overlap for as long as the old one has work, and the in-process reservation set cannot see across processes. Two writers on one session JSONL interleave partial records, so the cross-generation claim turns "reopen the file the old host is still writing" into a bounded retry instead of a corrupted transcript - and a claim whose owner is dead is ignored, so a killed host can never make a session file permanently unopenable.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- This is the lifecycle of the host process itself - binding and renaming the socket, signalling another generation, deciding which process may be signalled at all. No extension is loaded when those decisions run, and the failure mode of getting them wrong is another client's sessions dying.

### Expected merge conflict zones

- MEDIUM: `host-ensure.ts` (options, the decision switch, the spawn/registration path) and `host-lifecycle.ts` (supervisor argv, startup, shutdown, signals) are both touched in several places, and three modules were extracted out of `host-ensure.ts`. Anything upstream that also moves the pidfile shape, `defaultHostLaunch`'s signature or the supervisor's startup sequence conflicts there.
- LOW: the new modules, the router's drain, the registry's claim, and the docs sections.

## 2026-09-17 - Host actions are decided by protocol, capabilities and ordinal (#1782)

### What changed

- `src/modes/rpc/host-decision.ts` (new): `decideHostAction(client, host, policy)` -> `{ action: "start" | "reuse" | "handoff" | "refuse" | "fallback", reason, upgradeable, warning? }`, the single place every client surface decides what to do with the process it found on the shared socket. `client = { protocolVersion, requiredCapabilities, identity: EngineBuildIdentity, launchProfile?, startedByUs, platform }` (the plan's `launchProfileId` is carried as the whole `RpcLaunchProfile`, because the superset rule needs `core.extensions`, and `profile_id` travels inside it); `host` is the parsed `get_protocol_info` answer or `undefined`; `policy` is `"never" | "fallback" | "upgrade"`. The result type is a discriminated union per action, so an impossible pair (`handoff` with `upgradeable: false`, `refuse` with reason `compatible`) cannot be constructed, and the `"never"` overload returns only `start | reuse | refuse`. Also exported: `HOST_PROTOCOL_VERSION`, `REQUIRED_HOST_CAPABILITIES` (`multi_session`, `extension_events`, `session_context`, `session_kind`), `GENERATION_HANDOFF_CAPABILITY`, and `parseHostProtocolInfo()` - the tolerant boundary parse of a reply, where every identity field an older host omits stays absent instead of being defaulted to zero.
- `host-ensure.ts`: `isCompatible` no longer compares `serverVersion` to `VERSION`; it asks `decideHostAction(..., "never").action === "reuse"`, so the attach decision and the post-spawn readiness gate cannot drift apart. `ensureHostLocked` now switches on the decision - `reuse` attaches, `refuse` throws the new `HostEnsureRefusedError { socket, reason: "protocol" | "capability" | "foreign_writer" }`, `start` falls through to the spawn path. The pidfile gains `writer: { pid, startTime }` (this process's identity at write time), and a managed host is stopped ONLY when its pid still matches AND that writer is this process; a foreign writer refuses with `foreign_writer` and the host is never signalled. `probeProtocolInfo` returns the full parsed answer (identity fields included), and the readiness diagnostic names the protocol version and the required capabilities instead of a version string.
- `src/modes/index.ts` / `src/index.ts`: the decision API, its types and `HostEnsureRefusedError` are exported from the barrel for the CLI, the omo runner and the desktop.
- Docs: `docs/rpc.md` gains "Attach, start or refuse (`decideHostAction`)" - the full table, the two warnings, and I1/I2 stated in the terms the code enforces.
- Tests: `test/suite/host-decision.test.ts` (new) is the truth table, one case per row, including the narrower-profile, spec-less-client, win32, uncomparable-ordinal and fallback rows; `test/rpc-host-ensure.test.ts` gains a compatible host with a DIFFERENT `serverVersion` being REUSED, a foreign-writer pidfile and a recycled-pid writer both refusing with the host still alive, a host missing `session_context` refused under policy `never`, and the D11 legacy proof: the published v2026.9.16-3 ensure decision, replayed with spies, fails closed against a daemon directory that carries no flat pidfile and never stops the host. `test/rpc-host-identity-regression.test.ts`'s fake host now answers with `protocolVersion` and the four required capabilities (its subject - not consulting the identity probe on a compatible endpoint - is unchanged).

### Why

- The old compatibility test was an exact equality between the host's `serverVersion` string and this build's `VERSION`, and it did not merely refuse a mismatch: it STOPPED the running host and started its own. With one machine-wide daemon serving the CLI, the task runner and the desktop, that turns "this client is a different build" into "every other client's sessions just died". Two builds with different version strings speak the same protocol; what a client actually needs to know is the protocol version and the capabilities, which is what the daemon advertises.
- Refusing rather than starting a second host on a capability mismatch is the same rule from the other side: the host that answers OWNS the endpoint. Binding a second host over it would leave two processes fighting for one socket path - so a client either attaches, or fails with a reason its caller can act on (omo's per-child fallback consumes `fallback:capability` exactly this way).
- The pidfile writer stamp is what makes I1 checkable at all. "Did I start this host?" was previously answered by "does the pid in the pidfile still exist?", which is true for every host on the machine, including one the desktop started thirty minutes ago. The recorded start time is the half that survives a pid the OS recycled after a reboot.
- `handoff` is returned but not yet executable (the drain handoff is the next change); a client that asks for policy `"upgrade"` today can already see the decision, and `ensureHost` itself passes `"never"`.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- This is the code that runs BEFORE a host exists - the probe, the compatibility decision and the spawn/stop lifecycle of the host process itself. No extension is loaded at that point, and an extension could not be trusted with a decision whose failure mode is killing another client's host.

### Expected merge conflict zones

- LOW: one new module, plus `ensureHostLocked`, the pidfile write and the probe/readiness helpers in `host-ensure.ts`, and two barrel export lists. Anything upstream that also touches `isCompatible` or the pidfile shape in `host-ensure.ts` conflicts there.

## 2026-09-17 - `get_protocol_info` advertises engine build identity, ordinal and launch profile (#1782)

### What changed

- `src/core/engine-build-identity.ts` (new): `engineBuildIdentity()` -> `{ text, ordinal: [y, m, d, n, epoch], scheme: "epoch" | "nodef" }` and `compareEngineOrdinal(a, b)`. The version is parsed from `VERSION` (package.json CalVer, `2026.9.16` or `2026.9.16-3`, `n = 0` without the suffix); `epoch`/`sha7` come from the compile-time defines `SENPI_BUILD_EPOCH`/`SENPI_BUILD_SHA7`, read through `typeof` guards so a source run or a define-less build degrades to scheme `nodef` with epoch `0` instead of throwing. Comparison is lexicographic over `[y, m, d, n]`; the epoch breaks a tie ONLY when both sides are scheme `epoch`, otherwise EQUAL. Exported from the barrel (`src/index.ts`).
- `src/modes/rpc/protocol-identity.ts` (new): `protocolIdentity()` = the identity fields of a `get_protocol_info` answer - `instanceId` (UUID minted once per host process), `generation` (`SENPI_RPC_HOST_GENERATION`, 0 when nobody ensured this host), `engineVersion`/`engineOrdinal` (the build identity above) and `launch_profile`. `hostLaunchProfile(argv, cwd)` derives the profile from the host's OWN argv through the production `parseArgs` + `resolveSessionRuntime`: `core = { extensions (absolute, deduplicated, sorted), multi_session, session_runtime }`, `profile_id = sha256` of the canonical JSON of `core` with keys in sorted order.
- `rpc-types.ts`: new exported wire types `RpcLaunchProfileCore`, `RpcLaunchProfile`, `RpcProtocolIdentity`, `RpcProtocolInfo`; the `get_protocol_info` response member now names `RpcProtocolInfo` instead of an inline shape.
- `connection-handler.ts` (classic) and `session-command-router.ts` (multi-session) spread `protocolIdentity()` into their `get_protocol_info` answer. Nothing else about the reply changed: `protocolVersion`, `serverVersion`, `capabilities` and `mode` are byte-identical.
- `scripts/build-binaries.sh`: resolves the built commit's committer epoch and short sha once and passes `--define SENPI_BUILD_EPOCH=<epoch> --define SENPI_BUILD_SHA7="<sha7>"` to both platform compile lines. Without git metadata it prints one line and compiles with epoch `0` (scheme `nodef`) rather than failing; both compile lines stay a single shell-quotable argv, which `scripts/build-binaries-flags.test.mjs` and `scripts/read-summary-release-contract.test.mjs` require.
- Docs: `docs/rpc.md` gains a "Host identity" section and an updated `get_protocol_info` row; the `rpc-mode.ts` D1 header table carries the same shape.
- Tests: `test/suite/engine-build-identity.test.ts` (parse table, the ascending CalVer chain `2026.9.16 < 2026.9.16-2 < 2026.9.16-3 < 2026.9.16-10 < 2026.9.17`, an explicit assertion that `semver.compare` DISAGREES with it, `nodef` -> EQUAL, epoch decides only when both sides carry one) and `test/rpc-protocol-identity.test.ts` (the pure argv -> profile and env -> generation derivations, plus two spawned hosts - a socket host launched with `--session-runtime in-process --extension <path>` and a classic stdio host - whose replies carry every field, a stable `profile_id` across two connections, and the `engineVersion` of this tree). `test/rpc-multi-session.test.ts`'s exact protocol-info pin gained the new fields.

### Why

- Three clients share one machine-wide host, and today's only identity in the reply is a `serverVersion` STRING. Deployed clients compare it for equality and kill the host when it differs (invariant I2 exists because of exactly that), so the daemon has to publish what a compatibility decision actually needs: which process this is (`instanceId`), which generation, which build, and what that build loads.
- The ordinal has to be a tuple rather than a string because this product's CalVer `-N` is a POST-release increment: `2026.9.16-3` ships after `2026.9.16`, while semver ranks the bare version higher. A client that reached for a semver comparison here would hand off backwards, which is why the module never imports semver and the suite pins the disagreement.
- "Uncomparable is EQUAL" is the I2 rule in code: a binary built without git metadata has no age, and the handoff rule is "strictly greater", so such a build attaches instead of replacing a running host.
- The launch profile is derived from the host's own argv rather than from a caller-supplied description because that is the only account of the host that cannot drift from what it actually loaded - and `profile_id` gives a client one value to compare instead of a path list.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- `get_protocol_info` is answered by the host before any session (and therefore any extension) exists; it is the probe a client uses to decide whether to attach at all. The build defines are compile-time inputs to the binary, and the launch profile describes the host process's own argv - none of it is reachable from an extension.

### Expected merge conflict zones

- LOW: two new modules plus one line inside each of the two `get_protocol_info` arms (`connection-handler.ts`, `session-command-router.ts`), the `get_protocol_info` member of `RpcResponse` in `rpc-types.ts`, the two compile lines in `scripts/build-binaries.sh`, and the protocol-info pin in `test/rpc-multi-session.test.ts`.

## 2026-09-17 - Load and contention proof for one in-process host (#1782)

### What changed

- `test/suite/rpc-inprocess-load.test.ts` (new, opt-in via `SENPI_LOAD_TESTS=1`, 300 s per cell): six measured cells against ONE host built from the production `createHostCore` seam with no `workerConfiguration` - i.e. the `RpcSessionRegistry` a `--listen` host selects, the real `createRpcSessionBinding`, and the real `createCliRuntimeFactory` runtime. (i) SCALE - 1,000 sessions open at once, `list_sessions { include_workers: true }` = 1,000 while a default listing stays at 0, RSS and threads per session, then 200 closed and reopened by `sessionPath` with the listing latency sampled at every reopen (p95 gated under 500 ms). (ii) CHURN - 2,000 open/close cycles. (iii) CONTENTION - time-to-first-event for one session at a time vs 50 streaming at once, reported as a ratio. (iv) NEIGHBOUR - `get_state` every 100 ms on one session while another runs a 3 s ASYNC tool (p95 gated under 50 ms), contrasted with a deliberately SYNCHRONOUS 3 s tool and with opening a 50 MB transcript (both recorded, never gated). (v) FD/PLUGIN - 200 `kind: "worker"` sessions with the real omo plugin bundle: RSS per session, `lsof` count, soft `RLIMIT_NOFILE` (recording). (vi) NODE - the same host booted under Node with 50 sessions, asserting the one `bun:ffi`-gated path (the child reaper) turns itself off with exactly one warning instead of failing the boot, with the Z-count recorded.
- `test/suite/rpc-inprocess-load-support.ts` (new): the load rig. A NATIVE faux provider registered from inside each session's own extension load, because a session runs inside its own `ProviderScope` and a scoped `getApiProvider` consults the scope overlay and the builtins only - the module-global faux registry is unreachable there. The rig stubs `SENPI_CODING_AGENT_DIR`/`OMO_CODING_AGENT_DIR` at its sandbox and clears every inherited RPC socket variable, so no cell can resolve a session against a live agent dir.
- `test/suite/rpc-inprocess-load-probes.ts` (new): the async and blocking 3 s tools, the `get_state` prober, the 50 MB transcript fixture, and the churn-cell runner.
- `scripts/qa-rpc-socket/load-1000.mjs` (new): the same SCALE and CONTENTION cells against a REAL `--listen` host process over its socket, with the fake model server from `scripts/qa-app-server/lib/env.mjs` as the only reachable model. Reports `{ sessions, errors, curve[{ sessions, threads, fds, rssMb, ...PerSession }], threadsPerSession, fdsPerSession, rssMbPerSession, ttfePairP95 { single, concurrent50 } }` as JSON, stops the host, and reports its own orphan count. The report also records WHICH runtime the host ran, never an assumption: `runtime { hostArgv, resolvedFromArgv, serverVersion, capabilities }`, where `hostArgv` is read back with `ps` and `resolvedFromArgv` is production `resolveSessionRuntime(parseArgs(<that argv>))`. `--session-runtime worker` reproduces the capped runtime's refusal (`firstError { index: 20, error: "open_failed: too_many_sessions" }`, exit 1), `--disable-builtin <id>` writes `disabledBuiltinExtensions` into the sandbox settings so a per-session cost can be attributed to a component instead of to "a session", and `--host-env K=V` starts the host with one extra variable so a runtime knob can be OBSERVED (never used as a fix). Its socket client lives in `scripts/qa-rpc-socket/lib/jsonl-socket.mjs`.
- `scripts/qa-rpc-socket/load-churn.mjs` (new): the churn cell on BUN, where `bunExtensionImporterStats()` can move and `Bun.gc(true)` can force the full collection that separates "retained" from "not yet swept". The vitest runtime is Node, so the counter would read zero there; this is the same reason `test/extensions/bun-extension-regressions.test.ts` spawns `bun`.
- `test/suite/rpc-worker-host-support.ts`: added a `stderrText()` accessor so the Node cell can assert on what the host warned. `test/suite/rpc-inprocess-host-support.ts`: exported its `assistantMessage` helper for the transcript fixture. No production file changed.

### Why

- The daemon's whole premise is that one process holds every session, so the claim needs a number, not an argument: 1,000 sessions on one host with zero errors, and a measured per-session cost for threads, memory and file descriptors. The measurement contradicts the plan's "thread count flat" premise exactly as todo 7's did - a session costs ~1 thread under Bun and ~2 under Node - so the cells REPORT the per-session cost and gate only on the honest bound (below the worker runtime's measured 3/session), while the hard proof stays the refusal a capped host answers with.
- That thread has a named owner, measured rather than assumed: the `config-reload` builtin builds one watch event source per session (`builtin/config-reload/index.ts:164`), and on macOS every watch it registers is offloaded to a `node:worker_threads` Worker (`builtin/config-reload/watch-event-source.ts:79,100-102,120-125`). The report therefore samples a cost CURVE (threads, fds, RSS at 10/100/1000 sessions) rather than one endpoint, because that is what separates a bounded pool from a per-session thread. Same live host, same driver, one settings key: at 1,000 sessions the host holds 1,023 threads / 2,014 fds with the builtin and 18 threads / 1,014 fds with `disabledBuiltinExtensions: ["config-reload"]` - linear at 1.00 thread/session, and zero without it. It is not the session runtime, the registry, the binding, the transcript writer (fds grow 1/session in BOTH columns) or Bun's blocking-I/O pool (`UV_THREADPOOL_SIZE=2` does not move it, and the pool stays at 6-7 named `Bun Pool` threads).
- Latency under contention is not a contract this host controls, so the contention and neighbour contrast numbers are printed as ratios instead of asserted against a wall-clock threshold. The one latency budget that IS gated - a neighbour's `get_state` p95 while another session runs an ASYNC tool - is the invariant the audit in `test/suite/session-path-audit.ts` exists to protect, and the synchronous-tool contrast in the same cell is what makes that number mean something.
- The contention cell asserts the faux provider's `callCount`, because a model whose api resolves to nothing inside the session's provider scope still emits `agent_start`: without that assertion the cell would silently time the host's error path and still print a ratio.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- These are tests and QA drivers, not product behavior; they measure the host's registry, binding, event writer and runtime factory, all of which live below the extension boundary. No extension can open a session, observe another session's latency, or read the host's thread and descriptor counts.

### Expected merge conflict zones

- LOW: three new test files and two new QA scripts that upstream does not have. The only touched existing files are two test-support modules (`rpc-worker-host-support.ts` gains one accessor on its returned object; `rpc-inprocess-host-support.ts` exports an existing helper).

## 2026-09-17 - A reopen waits out the teardown that still holds the path (#1782)

### What changed

- `session-registry.ts` (`RpcSessionRegistry.openSession`): before the reservation decision, an open for a `sessionPath` whose reservation is held by an entry in state `closing` awaits that entry's `closeCompletion` (`settleClosingReservation`), then re-reads the reservation set as before. The wait is bounded by `closeGraceMs` - the same window `closeMarkedSession` force-releases at - so a wedged disposal falls through to the ordinary `session_path_in_use` instead of an open that never answers. Nothing else in the open path moved: an `opening` entry still refuses, a fully open entry still attaches, and a released path still opens fresh (`attached` absent).
- `worker-session-registry.ts` is deliberately unchanged: a worker's teardown ends with an OS thread exit that no host deadline bounds, and `test/suite/rpc-close-backpressure.test.ts` pins that an open must not block behind a wedged worker.
- Docs: `docs/rpc.md` (the `session_path_in_use` row and Duplicate/idempotency) and the `rpc-mode.ts` D1 header carry the rule and the runtime it applies to.
- Tests: `test/suite/rpc-inprocess-host.test.ts` gains "reopens a closed path while the previous session is still tearing down" - open, attach, the opener closes, the surviving connection drops, and the path is reopened WHILE the teardown is held at `waitForIdle` by the new `TeardownGate` in `test/suite/rpc-inprocess-host-support.ts`. The gate makes the teardown window deterministic instead of a race the test would usually win; RED without the fix is `open_session 0 failed: session_path_in_use`.

### Why

- The close/reopen contract silently depended on disposal latency. A session keeps its path reservation until its runtime is disposed, so `open_session { sessionPath }` issued right after that session ended was refused for a session that no longer exists - and no client can time the retry, because the disposal window is the host's, not the client's. Measured on a loaded machine, the path stayed refused for 300 ms - 1 s after the last attachment went away, on BOTH session runtimes. Waiting for the teardown the open would otherwise be refused by turns that race into a contract.
- This is a PRE-EXISTING defect, not a regression of any change on this branch. `test/rpc-socket-host.test.ts > reopens the path after explicit close and dropped surviving attachment` fails on the `origin/main` baseline c32a67a2d8 itself - three consecutive runs there, plus three more on each of befc3cbdac, b2464c3560 and 58ccadbd7f, all `1 failed | 17 passed (18)` - because the case waits a fixed 100 ms for a teardown the host does not promise to finish in 100 ms. It passes or fails with the machine rather than with the code; the branch's added host-loop work only makes the loss reliable. Nothing here reverts or weakens a session-runtime, kind/context, retention or park behavior.
- The in-process runtime is where this is safe to fix: its teardown is bounded by the host's own grace window (`closeMarkedSession` force-releases the entry at the deadline), so the wait has a ceiling the host controls. It is also the runtime a `--listen` socket host - the shared daemon - selects.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- The path reservation, the teardown window and the open's admission decision are registry internals below the extension boundary; an extension cannot observe a disposal in flight, let alone hold an open until it completes.

### Expected merge conflict zones

- LOW: the head of `RpcSessionRegistry.openSession` and the private method that follows `peek()`. Upstream has neither surface.

## 2026-09-17 - Per-session `open_session.auto_title` (#1782)

### What changed

- `rpc-types.ts`: `open_session` accepts additive `auto_title?: boolean`. When present it decides titling for THAT session; when absent the host `--auto-title-sessions` / appMode / `auto_title_sessions` capability default applies. A non-boolean is refused with `RPC_ERROR_INVALID_LAUNCH_PROFILE` (`invalid_launch_profile`).
- `rpc-input-validation.ts`: `sessionAutoTitleError(value)` parses the field at the wire boundary (absent or boolean only).
- `session-command-router.ts`: validates `auto_title` before the registry call, puts a boolean onto the launch profile as `autoTitle` (not host lifecycle policy), and advertises host capability `auto_title_per_session`.
- `src/main.ts` `resolveAutoTitleSessions`: optional `sessionAutoTitle` wins over the host-wide decision; context-message resumes still never retitle. `createCliRuntimeFactory` passes `launchProfile?.autoTitle`. Interactive TUI default is unchanged (no `open_session`, so the override is always absent).
- `src/cli/args.ts`: `--auto-title-sessions` is documented as deprecated for shared hosts; the flag is not removed.
- `custom-capability.ts`: `AUTO_TITLE_PER_SESSION_CAPABILITY`. `rpc-client.ts` exposes `openSession({ auto_title })`. `docs/rpc.md` and `rpc-mode.ts` carry the field, the capability and the error code.

### Why

- `--auto-title-sessions` is a process-wide launch-profile bit. A machine-wide daemon serving the desktop (titles on) and omo task children (titles off) cannot express both with one flag. Per-session `auto_title` is the OpenCode-level equivalent and stops that collision without removing the flag this release.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- Session title generation is started by `AgentSession` from a flag set at runtime construction. The wire field, the launch profile and the resolver live below the extension boundary.

### Expected merge conflict zones

- LOW: the `open_session` member of `RpcCommand` in `rpc-types.ts`, the capability set and the `open()` arm of `SessionCommandRouter`, `resolveAutoTitleSessions` in `src/main.ts`, and the advertised-capability pins in `test/rpc-multi-session.test.ts` and `test/auto-title-sessions-flag.test.ts`.

## 2026-09-17 - Parked retained sessions announce themselves; a close needs the caller's own attachment (#1782)

### What changed

- `rpc-types.ts`: new `RpcSessionParkedEvent` (`{ type: "session_parked", sessionId, sessionPath }`), the terminal record of a PARK. `rpc-client.ts` adds it to the public `RpcClientEvent` union.
- `session-event-writer.ts`: `parkSession(sessionId, sessionPath)` seals the session exactly like `closeSession` and publishes `session_parked` instead of `session_closed`, with no close response (nobody requested this teardown). Delivery reuses the `session_closed` rule: a `kind: "worker"` session's record goes to its attached connections, an interactive session's is broadcast.
- `session-command-router.ts` (`evictIdleSession`): the idle sweep reads the entry BEFORE claiming it and, when the entry is retained and has a session file, emits `parkSession` as the terminal record instead of `closeSession` + the synthesized `close_session` response. The teardown itself is byte-identical, so retention still never outlives the idle window and a parked entry leaves the registry (the empty-host exit window starts at that tick). A retained entry with no session file to reopen by falls back to the ordinary close.
- `session-command-router.ts` (`close`): a `close_session` whose connection holds no attachment for that handle is refused with `unknown_session` before any reply debt is reserved or any attachment is released. Hosts with no per-connection identity (stdio, in-process embedders) have no ownership to check and keep answering every close as before.
- Docs: `docs/rpc.md` (lifecycle-record visibility, idle eviction, retained sessions, the D1 `close_session` row, duplicate/idempotency) and the `rpc-mode.ts` D1 table carry both rules.
- Tests: `test/suite/rpc-inprocess-host.test.ts` gains the retention contract on the IN-PROCESS runtime (the daemon path; PR #1777's cases run on the worker registry) - detach + re-attach by path, a turn that settles after its client dropped (asserted on the persisted transcript), the unflagged session closing as before, an explicit close of a retained detached session, the park record reaching a connection that stayed attached with reopen-by-path, the empty-host exit firing once after the park, and the refusal of a foreign `close_session`. The rig lives in `test/suite/rpc-inprocess-host-support.ts`.

### Why

- A retained session exists to outlive its clients, so the desktop and the omo task runner must be able to tell "the host put this session to disk, reopen it by path" from "this session ended". Before this, both arrived as `session_closed`: the only correct client reaction (reopen) was indistinguishable from the only correct reaction to a close (forget), and a parked desktop thread would have been dropped from the UI.
- Parking deliberately keeps the eviction teardown. Retention that survived the idle window would make one abandoned session pin a daemon forever; the park record is what makes the eviction recoverable instead of silent.
- The close guard closes a hole that only becomes reachable on a shared daemon: `list_sessions` publishes every routing handle, and `close_session` decrements the refcount of whoever asks. A client that never attached could therefore release another client's attachment - and close a single-attachment session it never opened. Ownership is already tracked per connection for the drop path; the close now uses the same map.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- The idle sweep, the attachment refcount and the event fanout are host infrastructure below the extension boundary; an extension cannot observe a teardown it is being disposed by, nor refuse another connection's command.

### Expected merge conflict zones

- LOW: the terminal-record branch of `SessionCommandRouter.evictIdleSession`, the head of `SessionCommandRouter.close`, and the block after `SessionEventWriter.closeSession`. Upstream has none of these surfaces.

## 2026-09-17 - Session kind and opaque per-session context; worker sessions hidden by default (#1782)

### What changed

- `rpc-types.ts`: `open_session` accepts two additive optional fields - `kind?: "interactive" | "worker"` (default `interactive`) and `context?: Record<string,string>` (default `{}`) - `list_sessions` accepts `include_workers?: boolean` (default false), and two stable error codes join `RpcErrorCode`: `RPC_ERROR_INVALID_SESSION_CONTEXT` (`invalid_session_context`) and `RPC_ERROR_INVALID_SESSION_KIND` (`invalid_session_kind`). The `SessionKind`/`SessionContext` types are re-exported from `../../core/extensions/types.ts`, which owns them because the extension API publishes them.
- `rpc-input-validation.ts`: `sessionContextError(context)` and `sessionKindError(kind)` parse both fields at the wire boundary against `SESSION_CONTEXT_LIMITS` (32 keys, key `^[a-z][a-z0-9_]*$`, value <= 16 KiB, <= 32 KiB of JSON in total). The detail names the cap and its byte budget; an unknown `kind` is refused rather than downgraded to `interactive`.
- `session-command-router.ts`: `open_session` validates both fields before the registry call and answers `invalid_session_context: <detail>` / `invalid_session_kind: <detail>`; it passes them into the launch profile (never into `RpcSessionOpenOptions`, which is host lifecycle policy), tells the writer the new session's kind, filters `kind: "worker"` rows out of a default `list_sessions` and strips `context` from every row of that listing, and advertises the host capabilities `session_context` and `session_kind`.
- `session-registry.ts`: `RpcSessionEntry` gains frozen `kind` and `context`; `frozenProfile` (now exported) also freezes the supplied `context` object, `sessionIdentity(profile)` normalizes the pair once, and `list()` returns the shared `RpcSessionRow` type with `kind` and `context` on every row. `worker-session-registry.ts` stores and publishes the same pair through the same two helpers.
- `session-event-writer.ts` + `session-event-fanout.ts`: `setSessionKind(sessionId, kind)` records a session's visibility class, and `closeSession` delivers a worker session's `session_closed` through the new `SessionEventFanout.deliverToSession` (attached connections only) instead of `broadcast`. Interactive sessions keep today's broadcast, and no other lifecycle record changed, so the desktop mirror and the supervisor's unattached idle observer are unaffected.
- `custom-capability.ts`: `SESSION_CONTEXT_CAPABILITY` and `SESSION_KIND_CAPABILITY` host strings. `rpc-mode.ts` and `packages/coding-agent/docs/rpc.md` carry the updated D1 tables, the new error codes and a "Session kind and context" section.

### Why

- One machine-wide daemon serves interactive clients and machine-driven work (task children, team members) from the SAME process and the SAME extension set. Without a visibility class, every desktop that lists sessions mirrors every subagent, and every connection sees subagent lifecycle churn; without an opaque per-session map, an extension loaded once per session cannot tell which session it is serving, and the alternative (per-session extension sets or CLI flags on the wire) would make the host's launch profile client-controlled.
- `context` is deliberately inert: it is stored frozen, handed to that session's extensions, and republished only on `list_sessions { include_workers: true }`. It never reaches `CliRuntimeConfiguration.parsed`, so it cannot move a model, an auth decision or a CLI flag. It is bounded at the boundary because the host holds it per session and republishes it per listing.
- `context` is withheld from a default listing because an opener may put routing detail in it (omo puts `role`, `task_id` and team ids); only a caller that asked for workers gets the blob.
- Only `session_closed` becomes attached-only. `agent_start`/`agent_settled`/`agent_idle`/`session_opened` stay broadcast for every kind, because the host's own occupancy accounting reads them from an unattached observer.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- The wire contract, the session registry and the event fanout are host infrastructure below the extension boundary, and the point of the change is to give extensions a per-session identity they cannot construct themselves.

### Expected merge conflict zones

- LOW: the `open_session`/`list_sessions` members of `RpcCommand` in `rpc-types.ts`, the capability set and the `list_sessions` arm of `SessionCommandRouter.handle`, the `RpcSessionEntry` literal in both registries, and the `session_closed` emission in `SessionEventWriter.closeSession`. Upstream has none of these surfaces.

## 2026-09-17 - Guard and attribute event-loop stalls on the shared host (#1782)

### What changed

- `loop-lag-watchdog.ts` (new): an unref'd 200 ms timer measures how late it is invoked. Drift above `SENPI_RPC_LOOP_LAG_WARN_MS` (default 500) writes one stderr line per 10 s (`senpi rpc host stall: event loop blocked <drift>ms (sessionId=… tool=…)`); drift above `SENPI_RPC_LOOP_LAG_ERROR_MS` (default 5000) also emits a `host_stalled { driftMs, sessionId?, tool? }` lifecycle record to every connection. `tick()` is public so tests measure on an injected clock instead of waiting for real drift.
- `session-attribution.ts` (new): `AsyncLocalStorage` carrying `{ sessionId, tool }` plus a clock-free activity registry (monotonic sequence, open spans, last finished activity). `SessionCommandRouter.handle` now wraps every routed command in `runWithSessionAttribution` and delegates to a private `dispatch`; `session-binding.ts` opens a span per `tool_execution_start` and closes it on `tool_execution_end`, on `agent_settled`/`agent_idle`, and on binding disposal. The watchdog samples the registry per tick and blames the synchronous work that finished inside the measured window, else the tool still executing; otherwise the record carries no session.
- `host-memory-sampler.ts` (new): an unref'd 30 s sampler reads RSS. Above `SENPI_RPC_HOST_RSS_WARN_MB` (default 4096) it emits `host_memory_pressure { rssMb, sessions }` to every connection on every sample, writes one stderr line per 5 minutes, and raises a pressure flag on the router; `SessionCommandRouter.setMemoryPressure` HALVES the idle-eviction window while it is raised and restores it when RSS falls back. No admission control, no cap, no kill policy was added, and `sessionCount` is exposed only to publish the count.
- `multi-session-host.ts`: `startHostObservers(router, writer)` arms both observers for the stdio and socket hosts and stops them on shutdown. `session-event-writer.ts` gained `broadcastHostRecord`, which delivers one host-level record to every registered connection (or the shared stdio lane), untagged - `host_stalled` carries the handle it blames, `host_memory_pressure` belongs to the process.
- `rpc-types.ts`: `RpcHostStalledEvent` and `RpcHostMemoryPressureEvent`.
- Audit (test-only): `test/suite/no-sync-in-session-path.test.ts` + `session-path-audit.ts` walk the transitive call graph (classic TypeScript API from `@typescript/typescript6`, as `scripts/check-runtime-deps.mjs` already does) rooted at `session-registry.ts`, `session-binding.ts`, `connection-handler.ts`, `session-command-router.ts`, `src/core/agent-session.ts`, `src/core/auth-storage.ts` and every `src/core/tools/**` module. Blocking primitives (`execSync`, `execFileSync`, `spawnSync`, `Bun.spawnSync`, `Bun.sleepSync`, `Atomics.wait`, including import aliases, resolved through the checker) fail unless `no-sync-in-session-path.ledger.json` already records that exact call site; synchronous filesystem calls are reported against the same ledger with a byte-size note, failing only on a NEW entry or a higher count. The ledger records the six pre-existing blocking call sites that are NOT the credential/footer probes; `src/core/resolve-config-value.ts` (3) and `src/core/footer-data-provider.ts` (1) are deliberately absent, so the audit is RED until they go async.

### Why

- The socket host now runs every session in the host process, so one session's synchronous work is the whole daemon's outage. The host could not say that it had stalled, which session caused it, or how much memory it was holding; an operator saw an unresponsive daemon and a desktop client saw silence. Detection, attribution and memory reporting are the observability half of that trade-off.
- Attribution is registry-based rather than read from `AsyncLocalStorage` at the tick: the timer callback runs AFTER the blocked stack unwound, where the async context of the blocking work no longer exists. The registry is ordered by a monotonic counter instead of a clock, so the whole path is deterministic under an injected clock and needs no fake timers.
- Pressure halves the idle-park window because parking is the only memory lever a daemon may pull that is invisible to clients: an evicted session reopens by path. Refusing or killing sessions is explicitly out of scope (capacity is memory, never a refusal).
- The audit is a ban with a ledger rather than a bare ban because the clean tree is not empty: the credential lock (`auth-storage.ts`), the settings lock (`settings-manager.ts`), the `which`/`where` probe and win32 `taskkill` (`utils/shell.ts`) and the tool `--version`/extraction probes (`utils/tools-manager.ts`) are reachable today and are not part of the credential/footer work. Recording them with their bounds keeps the gate honest AND actionable: anything new fails immediately, and the two files that are being made async are the only RED.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- Event-loop drift, RSS of the host process, the routed-command dispatch seam and the idle-park window are host infrastructure below the extension boundary; an extension runs inside the very loop that is being measured.

### Expected merge conflict zones

- LOW: the `handle`/`dispatch` split and the idle-window expression in `session-command-router.ts`; the record pump in `session-binding.ts` (it became a closure so the tool spans and the writer share one walk); the observer start/stop lines in both hosts of `multi-session-host.ts`; the new method beside `closeSession` in `session-event-writer.ts`. The three new modules and the audit have no upstream counterpart.

## 2026-09-17 - Socket hosts reap the children a terminated worker orphaned (#1782)

### What changed

- `child-reaper.ts` (new): the reaping policy. `createChildReaper({ syscalls, now?, minWaitableMs?, log? })` returns a `tick()` that enumerates the host's DIRECT children, peeks at each with the `waitid(..., WNOWAIT)` oracle, and consumes with `waitpid(pid, WNOHANG)` only a pid that stayed waitable across two ticks at least `minWaitableMs` apart (default 30 s, hard floor 5 s). `waitpid(-1, ...)` is never called, so the reaper can never take a child it did not identify first. `startHostChildReaper(log)` arms it on a 1 s unref'd interval and returns the stop function.
- `child-reaper-syscalls.ts` (new): the platform bindings behind `loadChildReaperSyscalls()`. darwin enumerates with libproc `proc_listchildpids` (which lists zombies) and names children with `proc_name`; linux scans `/proc/<pid>/stat` for the ppid and reads `comm` from the same file; both call `waitid`/`waitpid` through `bun:ffi` (`bun-ffi.d.ts`, new, mirrors the `bun:sqlite` declaration precedent). No `ps` spawn anywhere - a reaper that spawns children to find children is the bug #1721 removed. `proc_pidinfo` is NOT used to detect zombies.
- `multi-session-host.ts`: `runSocketHost` arms the reaper before it listens and stops it in `shutdown`. The stdio host is unchanged: it lives and dies with the embedder that owns it.
- Environment: `SENPI_RPC_HOST_REAPER=0` disables reaping; `SENPI_RPC_HOST_REAPER_MIN_WAITABLE_MS` raises the window (clamped to the 5 s floor). Under Node (no `bun:ffi`) the host logs one warning at startup and reaps nothing.
- Observability: while at least 10 children sit waiting, or whenever a tick reaped, one line per 5 minutes carries `reaped=`, `waiting=` and the three commonest command names.
- QA: `scripts/qa-rpc-socket/spawn-zombie-probe.mjs` + `spawn-zombie-matrix.mjs` (new) produce the {spawn API} x {thread} x {runtime} x {lifecycle} table; `worker-spawn-zombie.mjs` gained `--case quarantine` (terminate a session worker while its bash child runs) and `--reaper-ms`. Test: `test/suite/rpc-host-reaper.test.ts` (+ `rpc-host-reaper-support.ts`).

### Why

- Measured on this branch (56 cells, darwin arm64, bun 1.4.2): every steady-state cell is 0 - 50 short spawns through one in-process session, and every {`child_process.spawn`, `Bun.spawn`, `Bun.$`} x {main thread, worker thread} x {bun source, compiled binary, Node} combination where the spawning thread stays alive. Every cell where a Worker is terminated with children that exited or exit later leaks 20/20, on all three APIs and all three runtimes, and the zombies survive for the life of the process. The product path that does exactly that is the session-worker quarantine (`session-worker-client.ts`): measured, it leaks 1 zombie per quarantined session with a live child, and 0 with the reaper armed.
- A long-lived machine-wide daemon is the process where those zombies accumulate; a stdio host dies with its embedder, which is why only the socket host arms the reaper.
- Why the window is 30 s and not the 5 s floor: a zombie carries no hint about which thread meant to wait on it, so only time separates "abandoned" from "its owner is blocked". Measured: stealing a child from a thread blocked in `execSync` makes `child_process` and `Bun.spawn` reject with `ECHILD` and `Bun.$` never settle at all. With a 5 s window the 12 s blocked-thread cell loses its child's exit code; with the shipped 30 s window every blocked cell still resolves with the real code 7.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- Reaping is a process-wide operation on the host's own children, below the extension boundary: an extension cannot see children it did not spawn, and a per-extension reaper would race every other one.

### Expected merge conflict zones

- LOW: the `shutdown` preamble and the import block in `multi-session-host.ts`. Both new source files and both new QA scripts are additive; upstream has no host reaper.

## 2026-09-17 - Socket hosts run their sessions in the host process (#1782)

### What changed

- New CLI flag `--session-runtime in-process|worker` (`packages/coding-agent/src/cli/args.ts`: `SessionRuntimeKind`, `isSessionRuntimeKind`, `resolveSessionRuntime`, one parse branch, one help line). It selects where a multi-session host runs its sessions. Default: `in-process` for a `--listen` SOCKET host, `worker` for a stdio host (`--multi-session` without `--listen`, and `--listen stdio://`) and for embedders. An explicit flag wins; any other value is a parse error, which `main.ts` already fails the process on.
- `packages/coding-agent/src/main.ts` (the only producer of `MultiSessionHostOptions.workerConfiguration`) passes that configuration only when the resolved runtime is `worker`. `createHostCore` is unchanged: it selects `WorkerSessionRegistry` when a `workerConfiguration` is present and `RpcSessionRegistry` otherwise, so withholding it is what selects the in-process registry. The runtime factory (`createCliRuntimeFactory`) is still built from the same configuration on both paths.
- Nothing was removed from the worker path: `SESSION_WORKER_LIMITS.workers = 20` still bounds `WorkerSessionRegistry` admission, and a socket host started with `--session-runtime worker` still answers the 21st `open_session` with `open_failed: too_many_sessions`.
- `packages/coding-agent/test/suite/rpc-worker-host-support.ts` now passes `--session-runtime worker` by default (every `rpc-worker-*` suite asserts worker-isolate behavior) and exposes `startInProcessHost()`, which omits the flag so the host picks the socket default.
- QA driver `packages/coding-agent/scripts/qa-rpc-socket/worker-spawn-zombie.mjs` (new): routes N `bash` spawns through one session on either runtime and reports Z-state children of the host process after a settle window (`--runtime`, `--spawns`, `--settle-ms`, `--max-zombies`, `--out`).

### Why

- The shared socket host is meant to be ONE machine-wide daemon that every client (CLI, task runner, desktop) attaches to, so its session count is a property of how many conversations the machine holds, not of an isolate budget. The worker runtime caps admission at 20 and answers `too_many_sessions` beyond it - a client-visible refusal that a daemon may never produce. The in-process registry (`session-registry.ts`) has no cap, and the host already contained both registries; this change only decides which one a socket host selects.
- The worker runtime stays the default where it is load-bearing: a stdio host multiplexes one JSONL stream owned by a single embedder process, and its isolates are what keep one session's crash or blocking work away from that stream.
- Accepted trade-off: an in-process session shares the host event loop, so one session blocking it blocks the host, and no per-session opening deadline (#1719) applies on that path. Measured on the socket host: 45 sessions opened on one host add ~2 threads per session (watchers), against ~3 per session on the worker runtime (isolate + watchers) - i.e. sessions are not free on either runtime, but the daemon path adds no isolate.
- Zombie baseline for the daemon runtime (recorded before the change, on the unmodified engine): 50 `bash true` spawns through one in-process session leave 0 Z-state children of the host after 6 s (worker runtime: also 0).

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- Host process topology and registry selection are CLI/host wiring below the extension boundary.

### Expected merge conflict zones

- LOW: the `--listen`/`--multi-session` parse branches and the RPC block of `printHelp` in `src/cli/args.ts`; the `appMode === "rpc" && parsed.multiSession` block in `src/main.ts`; the argv array and options type in `test/suite/rpc-worker-host-support.ts`. `createHostCore`, both registries and the router are untouched.

## 2026-09-17 - Supervisor launch routes through its own module (senpi#1781)

### What changed

- New `packages/coding-agent/src/modes/rpc/supervisor-route.ts` owns the internal-supervisor argument detection and launch, so `main.ts` reaches `host-lifecycle` (and the rest of the RPC host cluster) only through an `await import(...)` on the supervisor branch.

### Why

- `host-lifecycle`, `rpc-mode` and `multi-session-host` were static imports of `main.ts`, adding 35 modules to every interactive boot that never runs an RPC host.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- Mode routing happens in the host entry before extensions load.

### Expected merge conflict zones

- LOW: the new module; MEDIUM where `main.ts` detects supervisor arguments.

## 2026-09-17 - Socket credit on queue acceptance, dead-peer stall budget, deliverable cut notice (#1774)

### What changed

- `session-event-writer.ts`: `waitForSessionBackpressure` now settles socket destinations through `acceptActors` (`SocketEventSinkActor.waitForAcceptance()`), i.e. the record having been ACCEPTED into each connection's bounded queue, instead of `settleActors` (drain to empty). `flush()` and `drainUntilEmpty()` keep `settleActors`, so close/shutdown still drain. The empty-fanout (stdio/embedder) path still returns `flush()` and keeps its stdout backpressure wait. The actor lookup moved into a private `sessionActors()`.
- `socket-event-fanout.ts`: `DEFAULT_STALL_MS` 4000 -> 30000, redocumented as a dead-peer liveness budget that is independent of `SESSION_WORKER_LIMITS.controlMs`; new `waitForAcceptance()` states the credit contract at the queue that owns it. Byte overflow at `maxQueueBytes` still cuts immediately, and the stall cut is otherwise unchanged (notice + `onFailure(SocketEventQueueStallError)`).
- `socket-sink.ts` (extracted from `multi-session-host.ts`, same behaviour for `writeRaw`/`waitForBackpressure`): `close()` half-closes with `socket.end()` and destroys only after `SOCKET_CUT_GRACE_MS` (5 s) if the peer has still not read, instead of `socket.destroy()`. `writeRaw` is a no-op after the cut (no write-after-end on a connection that is going away).

### Why

- Worker credit was returned only after every connection's queue had drained to the kernel (`session-worker-client.ts:224` -> `waitForSessionBackpressure` -> `actor.flush()`), so the slowest client paced the producing worker, whose thread waits at most `controlMs` (5 s). That forced the stall cut below 5 s, and a client merely busy for 4 s with >= 16 KB pending (macOS unix stream buffers are 8 KB each way) was cut as dead, releasing every session it owned. Credit at acceptance removes the coupling; the cut becomes a real liveness detector.
- The notice that explains a cut was written to a transport the peer was not reading and then dropped by `socket.destroy()`, so clients saw an unexplained `end`. A half-close delivers it to any peer that resumes within the grace, and the grace keeps a peer that never returns bounded.
- Accepted trade-off: the producer is no longer paced by the reader, so a session that outruns a peer fills that peer's 64 MiB queue and the peer is cut on overflow. Producer-side bounding of multi-MB bursts is #1438.
- Tests: `test/suite/rpc-socket-credit.test.ts` (10 s stalled peer, 50 records/~200 KiB, credit due with zero clock movement, no cut, all records delivered after resume), `test/suite/rpc-socket-cut-notice.test.ts` (real unix socket pair: stall and overflow notices readable before EOF inside the grace, destroy at the grace), `test/suite/rpc-socket-stall.test.ts` (budget pinned at 30 s and above `controlMs`; credit without drain; only the dead peer cut; the stdio lane survives).

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- Transport flow control, worker credit and socket teardown are host infrastructure below the extension boundary.

### Expected merge conflict zones

- LOW: the `settleActors`/`acceptActors` aggregation sites in `session-event-writer.ts`, `DEFAULT_STALL_MS` and its comment in `socket-event-fanout.ts`, and the removed `socketSink` body in `multi-session-host.ts` (now `socket-sink.ts`). Upstream has no socket fanout.

## 2026-09-17 - Retain a session across its last client's disconnect (#1776)

### What changed

- `open_session` accepts `retain_on_disconnect?: boolean` (default false). A retained session answers a connection drop with a DETACH: `beginClose` releases the attachment but leaves the entry `open` at zero attachments instead of transitioning to `closing`, in both the worker registry (`worker-session-registry.ts`) and the in-process registry (`session-teardown.ts`, shared by `session-registry.ts`).
- `session-command-router.ts` passes the flag as host lifecycle policy (`RpcSessionOpenOptions`), not as part of the immutable launch profile, claims a drop-release with `{ detach: true }`, and skips the streaming-defer for retained sessions - there is no teardown to defer, so the attachment is released immediately and the turn settles on its own.
- `list_sessions` rows carry an additive `attachments` count; `get_protocol_info` advertises the host capability `retain_on_disconnect` in multi-session mode.
- Wire and client surface: `rpc-types.ts` types the request field and the additive `attachments` row field, `custom-capability.ts` defines the `RETAIN_ON_DISCONNECT_CAPABILITY` host string (advertised only by the multi-session router, since classic mode has no attachment refcount), `rpc-client.ts` exposes both to the in-repo client (`openSession({ retain_on_disconnect })`, `listSessions()[].attachments`), and `rpc-mode.ts` carries the updated D1 normative table in its module documentation.
- `claimClose` options are typed so `drainAttachments` and `detach` cannot be combined: draining ENDS a session (dispose, idle eviction) and must always reach zero, while only a detach may be answered by staying open.

### Why

- Every session owned by a dropped connection went through the refcounted close, so a client that lost its socket for one second lost every idle session it owned and its reconnect raced the teardown (see #1774 for the stall cut that produces those disconnects). A reconnecting client needs the session to outlive the socket and to be re-attached by `sessionPath`.
- Retention is deliberately not a new lifetime: an explicit `close_session`, host shutdown and the idle-eviction window still end a retained session, and an attach may only turn retention on, never off for clients already relying on it.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- Attachment refcounting, teardown and capability advertisement are host lifecycle; no extension surface reaches them.

### Expected merge conflict zones

- LOW: `beginSessionClose()` in `session-teardown.ts`, `beginClose()`/`attach()`/`list()` in `worker-session-registry.ts`, `openSession()`/`list()` in `session-registry.ts`, and `open()`/`releaseConnection()`/`claimClose()` in `session-command-router.ts`.
- LOW: the additive field/type lines in `rpc-types.ts`, `custom-capability.ts`, `rpc-client.ts` and the D1 table in `rpc-mode.ts`; the advertised capability set is pinned exactly by `test/rpc-multi-session.test.ts` and `test/auto-title-sessions-flag.test.ts`, so any lane adding a capability conflicts there. Does not touch `socket-event-fanout.ts`, `session-event-writer.ts` or `session-worker-client.ts`.

## 2026-09-15 - Watchdog ppid fallback: zero-spawn supervisor check (#1507)

### What changed

- `host-watchdog.ts` `watchPpid` drops the 250ms `readProcessIdentity` (`ps -o lstart=`) probe: a dead supervisor is reaped by its own parent and this process is then reparented, so `kill(pid, 0)` plus the `process.ppid` comparison (both free syscalls) detect the loss with no child process at all.

### Why

- A long-lived shared RPC host spawned `ps` 4x/second against its live supervisor; on runtimes whose `execFile` does not reap, those children accumulated as zombies (9,386 measured, every spawn on the host then failed with EAGAIN). The probe also fired the watchdog (host shutdown) after three consecutive probe failures against a LIVE supervisor - an observability gap, not a death.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- The watchdog is internal host lifecycle; no extension surface reaches it.

### Expected merge conflict zones

- LOW: `watchPpid` body and the removed `HOST_WATCH_PPID_PROBE_TIMEOUT_MS`. Fire reasons and the fd path are unchanged; supervisor death is still detected (at reparenting instead of during the zombie window).

# changes

## 2026-09-14 - Publish RPC close only after registry removal (#1656)

### What changed

- `closeMarked()` still replies on the close-grace deadline and keeps the entry until native exit, so a worker stuck in a syscall cannot hang cancel/close. The router waits for that exit callback before emitting `session_closed` or the close acknowledgement.
- `session-worker-client.ts` defers worker-failure terminal records until after the same exit callback, so error and failure frames observe an empty registry too.
- `shutdown.ts` makes reentrant `shutdown()` join the in-flight disposer and preserve a non-zero exit code (serializer-error overlapping stdin EOF).

### Why

- An immediate `list_sessions` after close must never return the closed session, including when the worker fails instead of a clean `close_session`.
- A second shutdown caller must not `process.exit` while watcher disposal is still outstanding.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- Session registry ownership and process exit are host lifecycle, outside session extensions.

### Expected merge conflict zones

- LOW: `closeMarked()` in `worker-session-registry.ts`, `fail()` in `session-worker-client.ts`, and the stdio `shutdown()` wrapper in `rpc-mode.ts`. Does not touch `host-lifecycle.ts` / `host-ensure.ts`.

## 2026-09-14 - Keep bundled workers out of supervisor entry dispatch

### What changed

- `packages/coding-agent/src/modes/rpc/host-lifecycle.ts` excludes the Node bundle from its standalone supervisor entry check. Explicit supervisor dispatch, unbundled Node, and Bun behavior are unchanged.

### Why

- esbuild gives every inlined module the unsplit worker's URL. The supervisor's source-file equality check therefore mistook the session worker for the supervisor CLI and exited with usage before the worker could open a session (Refs #1656).

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/rpc/host-lifecycle.ts` performs entry dispatch before session runtime or extension initialization.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/rpc/host-lifecycle.ts`: config import and standalone entry guard.

## 2026-09-13 - Reset supervisor idle time at occupancy transitions (#1290)

### What changed

- `packages/coding-agent/src/modes/rpc/host-lifecycle.ts` updates its idle decider when a public client attaches or detaches and when an observed turn starts or settles, not only on timer ticks. The timer remains the shutdown trigger.
- A clock-controlled subprocess regression exchanges real RPC records between ticks, reconnects successfully, and proves clean exit only after the new continuous idle window expires.

### Why

- A short readiness connection could begin and end between ticks without resetting a previous idle window. The next tick could close the public listener immediately after readiness, producing a Windows named-pipe `ENOENT` before the lifecycle test could open a session. Occupancy transitions must invalidate the old window synchronously.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- Connection occupancy and the shutdown clock belong to the shared supervisor, outside session extensions.

### Expected merge conflict zones

- LOW: the public proxy's attach/detach callbacks and observer event handling in `host-lifecycle.ts`.
## 2026-09-13 - Register compiled provider modules in each session worker

### What changed

- `packages/coding-agent/src/modes/rpc/session-worker.ts` imports the Bun runtime registration entry through a literal dynamic import when `isBunBinary`, before accepting messages.

### Why

- Provider overrides are isolate-local: registration in the launcher cannot satisfy lazy implementation loads in a shared-session worker. Relocated compiled probes and a worker-registration mutation distinguish both paths.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/rpc/session-worker.ts` owns isolate startup before the session loads extensions and accepts RPC commands.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/rpc/session-worker.ts` startup imports and initialization before `parentPort` message subscription.

## 2026-09-12 - Queued RPC input carries its source to extension `input` handlers

### What changed

- `packages/coding-agent/src/modes/rpc/connection-handler.ts`: `steer` and `follow_up` commands pass `{ enqueueOrder, source: "rpc" }` to `AgentSession.steer()` / `followUp()`, so queued input runs extension `input` handlers and skill or template expansion with `source: "rpc"` instead of the interactive default (upstream faa9863cb, adopted per D-N in the fork's `inputId` / disposition shape).
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts` keeps the fork deletion of `handleCommand`; the upstream two-line change lives in the connection handler.

### Why

- Extensions that filter or rewrite input by source were bypassed for queued RPC messages while `prompt` already honored them.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- The handler dispatch happens inside the session before any extension sees the message.

### Expected merge conflict zones

- The `steer` / `follow_up` command branches in `connection-handler.ts` and the `InputSource` union in `src/core/extensions/types.ts`.

## 2026-09-12 - Release session-write grants a worker no longer holds (senpi#1612)

### What changed

- `packages/coding-agent/src/modes/rpc/session-path-reservations.ts` is the new owner of canonical
  path ownership: it grants, counts, reconciles against a worker's live writers, and reports
  `granted` / `conflict` / `limit` with the wire code each denial maps to.
- `packages/coding-agent/src/modes/rpc/worker-session-registry.ts` reconciles a fully open entry on
  every snapshot (releasing superseded paths and re-keying the entry), reconciles once more before
  denying a full budget, exposes `reservationCount(handle)`, and only maps an opening spelling to a
  grant that is still held. Opening, closing and quarantined entries keep every path until exit.
- `packages/coding-agent/src/modes/rpc/session-worker-protocol.ts` carries `liveSessionPaths` on
  `WorkerSnapshot` and names the wait-signal codes (`WORKER_CREDIT_CODES`, `SessionWriteGrant`).
- `packages/coding-agent/src/modes/rpc/session-worker.ts` publishes those live paths and delegates
  its blocking host exchanges to the new
  `packages/coding-agent/src/modes/rpc/session-worker-credit.ts`, which reports an exhausted budget
  as `session_reservation_limit` and a held path as `session_path_in_use`.
- `packages/coding-agent/src/modes/rpc/session-worker-client.ts` gains the `reconcile` callback,
  answers a reservation with the host's grant, and encodes wait signals through the new
  `packages/coding-agent/src/modes/rpc/session-worker-signals.ts`.
- `packages/coding-agent/src/modes/rpc/rpc-types.ts` and `session-registry.ts` add the
  `session_reservation_limit` error code; `packages/coding-agent/docs/rpc.md` documents the
  release-on-supersede semantics and the new code.
- `packages/coding-agent/test/suite/regressions/1612-rpc-session-grant-release.test.ts` pins 70
  consecutive `new_session` commands on one worker, the superseded path reopening in a new worker,
  the budget-versus-conflict denial codes, and the live-writer registry.

### Why

- Grants were held for a worker's whole lifetime, so a long-lived session died at the 64-path cap
  with `session_path_in_use` and its earlier session files stayed unopenable for the host's life.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- Path grants, worker snapshots and the shared host's reservation budget live in the RPC transport
  layer, above the worker isolate an extension runs in.

### Expected merge conflict zones

- MEDIUM: `worker-session-registry.ts` reserve/attach bookkeeping.
- LOW: the `session-worker.ts` credit exchange, the client's `receive` switch, and the
  `WorkerSnapshot` shape.

## 2026-09-12 - Keep a live host whose identity probe is starved

### What changed

- `packages/coding-agent/src/modes/rpc/host-ensure.ts` registers a spawned host whose process
  identity stayed unreadable with a guard-less pidfile (`processStartTime: null`) instead of
  throwing and terminating the child, and the unhurried second read now honors the injected test
  probe so the starved-probe path is reachable without a Windows runner.
- `matchesPidFileOrUnknown` maps `ProcessIdentityUnreadableError` to "not ours" for the reuse
  decision, so an observation gap starts a fresh host instead of failing the whole ensure.
- `packages/coding-agent/test/rpc-host-ensure.test.ts` pins the registration, the guard-less
  reuse path, and the restart from a guard-less pidfile.

### Why

- Every win32 identity attempt spawns `powershell.exe` with `Get-CimInstance` under a 1s timeout.
  On a loaded runner all attempts time out, so a healthy host that had already bound its pipe was
  refused and killed with `started but its process identity stayed unreadable`. The comment above
  that throw already stated the intended behavior - keep the healthy host - while the code did the
  opposite; this is the CI failure observed on the `RPC named pipes (Windows)` job.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- Host registration and ownership probing run inside the RPC supervisor before any extension is
  loaded.

### Expected merge conflict zones

- LOW around the `startHost` identity block and `ensureHostLocked`'s ownership call in
  `host-ensure.ts`.

## 2026-09-11 - Preserve shared hosts across transient empty identity probes

### What changed

- `packages/coding-agent/src/modes/rpc/host-ensure.ts` now reaches the compatible endpoint
  decision before consulting an ownership identity probe, so concurrent callers can reuse a
  healthy shared host even when the platform probe is temporarily unavailable.
- `packages/coding-agent/test/rpc-host-identity-regression.test.ts` records the live-PID
  observation-gap and compatible-endpoint reuse contracts.
- The regression diagnostics distinguish compatible reuse from ownership probing, and retain the
  original readiness/cleanup evidence instead of replacing it with a termination side effect.
- The existing-host probe installs its named-pipe error listener before sending the Windows
  handshake, so a pipe removed during idle exit is observed as an absent endpoint instead of
  escaping as an unhandled `ENOENT`.

### Why

- Windows named-pipe startup could misclassify a live shared host after an empty or unavailable
  process identity observation, then enter replacement startup and terminate the valid host. A
  second ensure after idle exit could also race the pipe removal and fail before it could start
  a fresh host.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- Endpoint ownership, compatibility probing, and host replacement are RPC supervisor operations
  that execute before extension code is available.

### Expected merge conflict zones

- LOW around `host-ensure.ts` endpoint compatibility and ownership probe ordering.

## 2026-09-11 - Partial ask-user responses resolve with unanswered ids

### What changed

- `packages/coding-agent/src/modes/rpc/connection-question-bridge.ts` now resolves a response
  containing at least one answer as `answered` even when other question ids remain unanswered.
  An empty answer map with no comment remains `question_incomplete`.

### Why

- The TUI and desktop can intentionally submit a partial decision. RPC must preserve that action
  instead of leaving the question pending or requiring an unrelated comment.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- The RPC bridge owns response correlation and terminal resolution before the extension receives
  the result.

### Expected merge conflict zones

- LOW around `ConnectionQuestionBridge` response validation and the existing question resolution
  event; preserve the one-resolution guarantee.

## 2026-09-10 - Optional display-name account descriptor (senpi#1495)

### What changed

- `packages/coding-agent/src/modes/rpc/rpc-types.ts`: `RpcProviderAccount` gains optional `displayName`, matching the safe shared descriptor returned by `get_provider_accounts`. `name` remains the immutable selector ID; credentials never enter this projection.

### Why

- `packages/coding-agent/src/modes/rpc/rpc-types.ts`: clients need human-readable labels without changing their pin/remove selectors or existing legacy payloads.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/rpc/rpc-types.ts` defines the host-owned typed response contract, not an extension-local message.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/modes/rpc/rpc-types.ts` account descriptor interface.

## win32 supervisor bootstraps its own internal directory and public secret (2026-09-10)

### What changed

- `packages/coding-agent/src/modes/rpc/host-lifecycle.ts`: the win32 branch of `createInternalSocketPath()` now creates `<baseDir>/internal-<uuid>` with `recursive: true` instead of `recursive: false`. The function is exported and takes an injectable `platform`, mirroring `spawnableChildLaunch(launch, platform)` in the same module, so the win32 bootstrap is coverable from any host. The posix branch is unchanged. `runHostSupervisor()` now provisions the public socket secret through the new `ensurePublicSocketSecret()` helper (`ensureSocketSecret` instead of `readSocketSecret`) before it allocates the internal hop or spawns the child, so the direct launch route owns the secret its own listener authenticates with; a provisioning failure is rethrown naming the bootstrap step and the secret path.
- `packages/coding-agent/docs/rpc.md`: the shared-host lifecycle section records that the win32 internal hop directory is created recursively and that the supervisor self-provisions `<publicSocket>.secret`, reusing an existing valid secret.
- `packages/coding-agent/test/suite/regressions/1370-rpc-internal-socket-mkdir.test.ts`: a subprocess regression drives the real `--internal-rpc-host-supervisor` CLI route on a fresh profile through readiness, connection and a `get_protocol_info` response; two cases drive `runHostSupervisor()` itself with `process.platform` stubbed to win32 to prove a missing secret is created and an existing one preserved; the `createInternalSocketPath()` cases remain as supplemental unit coverage.

### Why

- `runHostSupervisor()` passes `paths.dir` (`<agentDir>/rpc-host-daemon`) as the base directory. `ensureHost()` creates that parent before spawning, but the hidden `--internal-rpc-host-supervisor` launch route does not, so on a fresh Windows profile the supervisor died during bootstrap with `ENOENT: no such file or directory, mkdir '<agentDir>\rpc-host-daemon\internal-<uuid>'` (#1370). The posix branch never hit this because it roots the directory in `tmpdir()`, which always exists.
- The same fresh profile then died on the second failure reported in #1370: `readSocketSecret()` requires `<publicSocket>.secret`, which only `ensureHost()` wrote, so the direct route never reached `listen()`. Reuse (not rotation) is mandatory because `resolveSocketTransportAddress()` derives the win32 pipe name from the socket path AND the secret, so a fresh secret would move the endpoint away from the one the caller published.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- The failure happens inside the supervisor's own bootstrap, before any session, runtime, or extension surface exists.

### Expected merge conflict zones

- LOW: the `createInternalSocketPath` signature and its win32 `mkdir` call, the secret provisioning at the top of `runHostSupervisor` and the `ensurePublicSocketSecret` helper in `host-lifecycle.ts`, and the internal launch route paragraph in `docs/rpc.md`.

## The refused-switch entry crosses the RPC seam and stays bookkeeping (2026-09-10)

### What changed

- `packages/coding-agent/src/modes/rpc/rpc-input-validation.ts`: `validSessionEntry` accepts `model_change_rejected` (`provider`, `modelId` and `detail` must be strings), so an `append_session_entry` carrying the entry is no longer refused as malformed.
- `packages/coding-agent/src/modes/rpc/connection-handler.ts`: the deferred-entry gate counts `model_change_rejected` as auto-appended bookkeeping next to `model_change`/`thinking_level_change`, so a session whose only content is a refused switch keeps shipping status snapshots without its entry list.

### Why

- `model_change_rejected` (#1526) is appended by the session itself on a refused switch. Without the validator branch the entry could not cross the `append_session_entry` seam `rpc-client.ts` exists for, and without the bookkeeping exclusion recording a refusal silently turned every `get_state` for that session into a full entry dump.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- Both are RPC-mode internals: the command validator runs before any extension sees the command, and the state snapshot is assembled by the connection handler.

### Expected merge conflict zones

- LOW: the `validSessionEntry` switch and the `entries` spread inside the state snapshot builder.

## An aborted question carries the extension's outcome (2026-09-10)

### What changed

- `connection-question-bridge.ts`: the abort listener installed for `opts.signal` no longer hard-codes `cancelled`. It reads the abort reason and resolves `timed_out` when the aborting side already settled the question that way, so the broadcast `question_resolved` outcome matches the response the model received. Every other abort (dismissal, superseded question, session close) still resolves `cancelled`.

### Why

- The ask-user builtin owns the authoritative idle timer and aborts the dialog controller when it fires. The bridge's own equal-length timer lost that race in RPC mode, so an idle timeout broadcast `question_resolved{outcome:"cancelled"}` while the framed notice and tool result carried the timeout text - and `docs/rpc.md` documents `timed_out` as the outcome desktop clients map onto the resolved row (probe scenario `async`).

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- The outcome broadcast to connections is written by the bridge; an extension only sees its own `QuestionResponse`.

### Expected merge conflict zones

- LOW: the `cancel` closure inside `ConnectionQuestionBridge.ask`.

## open_session of an existing session file starts as a resume (2026-09-10)

### What changed

- `session-registry.ts`: `openSession` passes `sessionStartEvent: { type: "session_start", reason: "resume" }` to `createAgentSessionRuntime` when the requested `sessionPath` already exists on disk (the same `isResume` predicate that already restores the persisted model and thinking level). A session created by the open still starts with the default `reason: "startup"`.

### Why

- `AgentSession` defaults to `reason: "startup"` when no event is supplied, so re-opening a session over RPC fired `session_start{startup}`. Extensions that rebuild per-session state only on a resume never ran: after a host crash the ask-user builtin's dangling-question hook (`resume.ts`, `reason` must be `resume`/`reload`) left the pending tool call hanging with nothing re-presented and no orphaned-after-restart message (probe scenario `resume`). Interactive `/resume` already emits the event through `AgentSessionRuntime.switchSession`; the RPC restart path now mirrors it.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- The start reason is decided by the runtime factory call inside the registry, before any extension is bound; an extension cannot observe why its session was created.

### Expected merge conflict zones

- LOW: the `isResume` block and the `createAgentSessionRuntime` options in `RpcSessionRegistry.openSession`.

## Pending questions survive the opening connection's drop (2026-09-10)

### What changed

- `session-command-router.ts`: `releaseConnection` no longer calls `cancelPendingExtensionUiRequests()` for every session a dropped connection owned. The cancellation moved into `releaseOwnedSession`, on the branch where the close claim made this caller the finalizer - i.e. the attachment refcount already decided the session is being torn down. A drop that leaves other attachments alive now keeps the shared binding's pending questions pending.

### Why

- A question is session-owned: `docs/rpc.md` promises pending questions are broadcast to every attached connection and replayed to connections that attach later. Cancelling on any owner drop resolved the question `cancelled` for all peers, made `open_session` hydrate zero pending questions, and rejected the surviving connection's answer with `question_already_resolved` (probe scenario `owner-drop`).

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- Connection lifecycle, attachment refcounting and binding teardown are router-private; no extension hook observes a dropped socket or the close claim that decides whether the session survives.

### Expected merge conflict zones

- LOW: the attachment loop in `releaseConnection` and the finalizer branch of `releaseOwnedSession`.

## edit_assistant_message command and typed edit errors (2026-09-10)

### What changed

- `rpc-types.ts`: new command member `edit_assistant_message { entryId, text, expectedLeafId?, summarize?, customInstructions? }`, response `data: EditAssistantMessageResult` (`edited | unchanged | cancelled`), and five `RPC_ERROR_*` constants (`streaming`, `not_found`, `not_assistant`, `empty`, `stale_leaf`) folded into `RpcErrorCode`.
- `connection-handler.ts`: `case "edit_assistant_message"` beside `fork` - validates the shape, calls `session.editAssistantMessage` on the connection's bound session (the same routed session `get_entries`/`get_tree` use), maps outcomes, and turns `AssistantEditError`/`SessionStreamingError` into `errorCode`; the extension `commandContextActions` gain `editAssistantMessage`.
- `rpc-client.ts`: `editAssistantMessage()` plus `RpcCommandError` (an `Error` subclass carrying `errorCode`/`errorData`) now thrown by `getData()` for every failed command instead of a bare `Error` with the same message.

### Why

- The TUI-only edit from `/tree` (#1532) was unreachable from RPC clients such as the desktop, and clients had no typed way to learn why an edit was refused.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- The RPC command surface and the error envelope are owned by this directory; an extension cannot add a wire command.

### Expected merge conflict zones

- LOW: `rpc-types.ts` command/response unions and the `RPC_ERROR_*` block; `connection-handler.ts` switch (one new case next to `fork`); `rpc-client.ts` `getData()`.
## Client writer for question draft progress (2026-09-10)

### What changed

- `rpc-client.ts`: `sendExtensionUIProgress` writes an `extension_ui_progress` stdin record fire-and-forget (no reply wait), and `send()` now preserves the host request id for progress records exactly as it already does for `extension_ui_response` (never minting `req_<n>`).

### Why

- A TUI attached to a shared RPC host debounces question-overlay drafts (todo 10) and needs a client-side writer to forward them so the host can reset the question's idle deadline.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- The record must go out on the RPC stdin stream the client owns, with the routing/id rules private to `RpcClient.send`.

### Expected merge conflict zones

- LOW: the new method beside `sendExtensionUIResponse` and the id-preserving branch at the top of `send`.

## Session-owned question bridge (2026-09-10)

### What changed

- `connection-question-bridge.ts` implements question submission, progress-driven idle deadlines, draft-preserving timeout, cancellation, late-answer errors, and sequential select/input fallback. `connection-handler.ts` gates native questions on client capabilities and projects pending questions into session state.
- `session-event-fanout.ts` retains pending questions independently of assistant snapshots, replays them once on attachment, refreshes deadlines, and forgets terminal questions. `session-event-writer.ts` clears retention on session close; questions remain broadcast.
- `session-worker.ts` publishes question state changes across the existing snapshot IPC. `session-registry.ts`, `session-worker-requests.ts`, and `worker-session-registry.ts` admit progress alongside UI responses during closing.

### Why

- Multi-client question prompts must survive completion of the assistant message and detachment of the asking client, accept drafts without resolving, and resolve exactly once for all peers.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- RPC routing, socket replay, client capabilities, and worker snapshots are runtime-owned. Extensions cannot implement these transport guarantees.

### Expected merge conflict zones

- `connection-handler.ts` UI binding and input dispatch; worker output snapshot selection; privileged routing allowlists; fanout snapshot retention and attachment replay.

## Question extension-UI wire types and client capability (2026-09-10)

### What changed

- `rpc-types.ts`: additive `extension_ui_request{method:"question"}` (`RpcQuestionUiRequest`), `{answers, comment}` `extension_ui_response` member, inbound `RpcExtensionUIProgress` on `RpcInboundRecord`, outbound `question_updated` / `question_resolved`, and optional `RpcSessionState.pendingQuestions`.
- `custom-capability.ts`: export `QUESTION_CAPABILITY = "question"` next to the existing client-capability constants.

### Why

- The ask-user tool needs a typed RPC wire for broadcasting a multi-question prompt, receiving partial drafts and a final `{answers, comment}` reply, hydrating late-attaching clients from session state, and gating on an explicit client capability. Older clients that never advertise `question` keep today's select/input path.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- RPC record shapes, session-state hydration fields, and the client-capability handshake are host protocol, below every extension hook.

### Expected merge conflict zones

- LOW: the `RpcExtensionUIRequest` / `RpcExtensionUIResponse` union tails in `rpc-types.ts`, the `RpcSessionState` field list, and the capability constants in `custom-capability.ts`.

## Cut stalled socket peers before they consume the session worker credit (2026-09-10)

### What changed

- `packages/coding-agent/src/modes/rpc/socket-event-fanout.ts`: `SocketEventSinkActor` bounds each write's drain wait with `stallMs` (`DEFAULT_STALL_MS` = 4000, pinned below `SESSION_WORKER_LIMITS.controlMs`). A peer that has not accepted the write in time fails the actor exactly like a byte overflow: one best-effort `{"type":"overflow","error":"stalled, resync required"}` notice, actor closed, `onFailure(SocketEventQueueStallError)` (the fanout removes the connection and closes its socket).
- `packages/coding-agent/src/modes/rpc/session-event-writer.ts`: `waitForSessionBackpressure`, `flush` and `drainUntilEmpty` settle socket actors through `settleActors`, which treats a rejected actor flush as a cut peer. Previously any actor rejection (byte overflow, now also stall) propagated into `Promise.all`, rejected the writer-wide drain and called `fail()` on the shared host writer, or reached the session worker client which then killed the worker.
- `registerConnection` accepts `stallMs` (tests use a short budget); `packages/coding-agent/docs/rpc.md` documents the stall cut and that a cut connection never withholds session credit.

### Why

- Live on mengmotaHost 2026-09-09 17:17 and 2026-09-10 11:07 (two runtimes): a desktop client stalled on its own downstream ack pacing, the kernel socket buffer filled during a large `eval` tool result, `waitForSessionBackpressure` never resolved, and the session worker failed itself with `session_worker_credit_timeout` after 5 s — the user's running turn was truncated (`session_closed` with no final assistant message) although the session and every other peer were healthy. One slow consumer must not kill the producer; the writer already had fail-closed overflow semantics for slow peers, they were just byte-only.
- `test/suite/rpc-socket-stall.test.ts`: stall budget < worker deadline; a stalled actor is cut with the notice while a sibling drains; the writer returns session credit and closes only the stalled connection; the writer and its stdio lane survive a stalled peer (this last case failed the whole writer before the fix).

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- Transport credit, socket drain and worker liveness are host infrastructure below the extension boundary.

### Expected merge conflict zones

- LOW: `SocketEventSinkActor.drain` and the three actor-flush aggregation sites in `session-event-writer.ts`. Upstream has no socket fanout.

## Bound quarantined and joined close reply admission (2026-09-08)

### What changed

- `packages/coding-agent/src/modes/rpc/session-event-writer.ts` counts admitted close reply records and serialized bytes against the existing stdio queue budgets before they are queued. The first closer reserves both terminal records; direct duplicate replies use the same admission gate. Saturation emits a bounded `rpc_close_output_overflow, resync required` notice, not one buffered reply or stderr line per rejected command. Stdio keeps one notice per episode. Socket notices target only the rejected requester, with at most one outstanding notice per sink until consumption; actor identity isolates reconnects without retaining dead connections.
- `packages/coding-agent/src/modes/rpc/session-command-router.ts` admits reply debt before claiming an attachment or awaiting finalization. Rejected commands do neither; admitted replies transfer their reservation to FIFO output, with release on every completion/error path. Native-exit canonical ownership is unchanged.
- `packages/coding-agent/docs/rpc.md` documents close admission, overflow recovery, and the distinction between an overflow notice and a successful acknowledgment.

### Why

- Broadcasting one global socket notice incorrectly told healthy peers to resynchronize and suppressed notification for later affected requesters. Deterministic two-connection tests reproduce both failures and preserve independent peer progress. They also drain socket actors without a stdio lane, then saturate the same actors again: first-closer terminal records survive, reply debt is reclaimed, and later episodes receive fresh requester-only notices without reconnecting.
- A native-FIFO-blocked quarantined worker can remain resident indefinitely. Previously, 4,196 duplicate closes queued 4,196 noncompactable replies beyond the 4,096-record bound; checking only at enqueue also leaves unbounded reply debt in joined finalization promises.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- Output budgets, reply admission and attachment claims are transport/router infrastructure below extension hooks.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/modes/rpc/session-event-writer.ts` close/output admission and `packages/coding-agent/src/modes/rpc/session-command-router.ts` close routing. Tests cover count and byte saturation with real quarantined workers and held finalization; existing terminal/FIFO and native-pressure proofs remain intact.

## Shared RPC session workers retain ownership until exit (2026-09-08)

### What changed

- `packages/coding-agent/src/modes/rpc/session-worker-client.ts` accepts the build-time `SENPI_RPC_SESSION_WORKER_ENTRY` define so external Bun wrappers can embed the published dist worker under their own explicit compile root. Compiled entries are resolved against `import.meta.url`, converted with `fileURLToPath`, and normalized to forward slashes before Worker construction. On Windows Bun 1.4.0, passing a URL lets `node:worker_threads` convert it to a backslash path: the embedded file exists but worker startup reports ENOENT. Passing the same absolute path with forward slashes starts the embedded worker; POSIX paths remain unchanged. Source/Node resolution and the standalone source-entry default are unchanged.
- `packages/coding-agent/src/modes/rpc/session-worker.ts`, `session-worker-protocol.ts`, `session-worker-client.ts`, `session-worker-requests.ts`, and `worker-session-registry.ts` introduce per-session workers, prepare/grant/commit opening, bounded requests and IPC credit, and main-owned reservations retained through quarantine until actual worker exit.
- `packages/coding-agent/src/modes/rpc/multi-session-host.ts` selects the worker registry for CLI shared hosts and reports stdio capacity failures without terminating sibling sessions.
- `packages/coding-agent/src/modes/rpc/session-registry.ts` carries worker ownership and internal quarantine while retaining the injected in-process registry seam. `worker-session-registry.ts` publishes quarantined workers as the existing `closing` wire status, preserving desktop eager-reattach semantics without releasing ownership.
- `packages/coding-agent/src/modes/rpc/session-binding.ts` and `connection-handler.ts` keep classic semantics inside each worker and flush shared-session events into the bounded transport synchronously.
- `packages/coding-agent/src/modes/rpc/session-command-router.ts` routes snapshots and requester identity across IPC, releases unrelated connections' sessions independently, preserves exact settlement events, and removes exited-worker attachment bookkeeping.
- `packages/coding-agent/src/modes/rpc/session-event-writer.ts` returns worker credit only after the session's own destinations drain and bounds stdio queues with visible overflow and terminal-failure records.

### Why

- A session's synchronous filesystem operation or JavaScript loop must not freeze the shared transport or other sessions. Neither timeout nor routing closure proves worker termination, and a second writer must not be admitted while the old worker can resume.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- Canonical admission, transport credit, routing ownership and worker lifetime are host infrastructure below the extension boundary. The classic handler still owns command semantics inside the worker.

### Expected merge conflict zones

- MEDIUM: `packages/coding-agent/src/modes/rpc/session-command-router.ts` attachment/close paths, `session-event-writer.ts` output scheduling, `session-binding.ts` and `connection-handler.ts` binding options. LOW: `multi-session-host.ts`, `session-registry.ts`, `rpc-types.ts`, and the new worker modules.

## Watchdog reads the ownership token before it removes the scratch directory (2026-09-07)

### What changed

- `host-watchdog.ts`: `HostWatchdogConfig.beforeCleanup` runs when the watchdog fires, before `scratchDir` and `cleanupPaths` are removed; a failing hook never blocks the cleanup or the shutdown behind it.
- `multi-session-host.ts`: a supervised host passes a hook that reads the supervisor's `public-socket.owner` token if the startup wait has not loaded it yet, so the ownership-checked removal of the public socket has something to prove with.
- `test/suite/rpc-socket-ownership.test.ts`: the two removal assertions wait, bounded, for the path to disappear instead of stat-ing one snapshot at `close`.

### Why

The supervisor publishes the token right after its `listen()` and prints `ready` immediately after, while the host learns the token through a 25 ms poll. Under load (CI, or the earlier cases of the same test file) the supervisor could be SIGKILLed while the host was still polling. The watchdog then removed the scratch directory first, the host's shutdown ran `unlinkOwnedSocket(publicSocket, undefined)`, correctly refused (`ownership unknown; leaving it`), and the public socket outlived both processes. `test/suite/rpc-socket-ownership.test.ts` failed on `main` exactly this way (senpi #1442); standalone the same sequence passed, which is why it read as a flaky test rather than the startup race it is.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

The watchdog fires inside the host's transport lifecycle below every extension hook.

### Expected merge conflict zones

- LOW: `host-watchdog.ts` config field and `fire()`; the `armHostWatchdog` call in `multi-session-host.ts`; the two assertions in the ownership test.

## Socket teardown is ownership-checked, never path-only (2026-09-07)

### What changed

- New `socket-ownership.ts`: `statSocketIdentity()` (dev+ino of a socket path entry), an ownership token sidecar in the lifecycle supervisor's private scratch directory (`public-socket.owner`), and `unlinkOwnedSocket()`, which unlinks a socket path only while its current stat identity matches the recorded one. ENOENT is nothing to do; a mismatch logs `socket path ... now owned by another host; leaving it`; an unknown identity is never guessed at and the path is left.
- `multi-session-host.ts`: the socket host records its bound entry's identity right after `listen()` (same step as the existing 0600 chmod) and its shutdown replaces the unconditional `unlink(socketPath)` with the ownership-checked removal. A supervised host additionally removes the supervisor's public socket through the same check, using the token its supervisor published; that covers the watchdog crash path, which previously removed the public socket by path from `HOST_CLEANUP_PATHS`.
- `host-lifecycle.ts`: the supervisor stats the public entry it just bound, publishes the token into its scratch directory for its child, and its shutdown replaces `rm(publicSocket)` with the ownership-checked removal. On POSIX the public socket is no longer listed in `HOST_CLEANUP_PATHS` (the child removes it token-checked); Windows named pipes keep the old behavior since they have no filesystem entry to own.
- `test/suite/rpc-socket-ownership.test.ts`: for both a direct multi-session host and a supervisor-managed one, a replacement socket renamed over the live path (the takeover dance) survives SIGTERM shutdown and still connects, while the no-takeover path is removed and an already-absent path is tolerated; a supervisor SIGKILL (watchdog crash path) preserves a taken-over path and still removes an untaken one.

### Why

The startup path already refuses to touch a socket path owned by a live server (`prepareSocketPath` probes before unlinking), but every teardown path removed by path only. The OmO desktop replaces a socketless host by starting the new host on `<socket>.takeover-<pid>`, renaming it over `rpc.sock`, then SIGTERMing the old host; the old host's shutdown unlinked `rpc.sock` - now the NEW host's entry - leaving the supervisor alive, `rpc host ready on .../rpc.sock` logged, the socket absent, and every desktop session failing `connect ENOENT rpc.sock`. The same blind removal existed on the supervisor's own shutdown and on the child watchdog's crash-path cleanup (`HOST_CLEANUP_PATHS`). A probe-if-live check alone does not close this: after the rename and before the new host's listen completes, a probe would also fail, and crash/signal paths reintroduce the race. The dev+ino token captured at bind is what closes every teardown path deterministically.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

Socket bind, unlink, and process-teardown ordering are transport lifecycle internals below every extension hook; no extension observes or intercepts host shutdown.

### Expected merge conflict zones

- LOW: `socket-ownership.ts` is fork-only and additive.
- LOW: the `listen()` tail and shutdown-removal call in `multi-session-host.ts`, and the public-socket cleanup swap plus token write in `host-lifecycle.ts`.
- LOW: `test/suite/rpc-socket-ownership.test.ts` (new).

## Shared-host logical sessions are unlimited by default (2026-09-06)

### What changed

- `multi-session-host.ts` and `session-registry.ts`: the session-count admission gate is removed. Logical session admission is unlimited; attach/path/lifecycle safety and idle/empty-host resource reclamation remain.
- `docs/rpc.md`: the occupancy and D1 sections now define unlimited logical sessions as the only production behavior.
- `test/rpc-session-occupancy.test.ts`: regression coverage opens 12 distinct sessions through the registry and 9 through the host core, then verifies close/reopen/attach lifecycle behavior.

### Why

- The cap refused `open_session` with `too_many_sessions` once 8 sessions were concurrently opening/open, which is a client-visible failure for an ordinary desktop workload that keeps more than eight logical sessions around. Admission control was the wrong lever: idle eviction and empty-host exit reclaim resident resources without failing a user's open.
- A user session is never rejected because another session exists. Resident-resource reclamation remains lifecycle-driven and does not evict or borrow another user session as an admission workaround.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- Admission happens inside `RpcSessionRegistry.openSession`, beneath every extension surface; no extension observes or overrides the registry's open path.

### Expected merge conflict zones

- LOW: the `resolveHostIdlePolicy` tail in `multi-session-host.ts`, the occupancy section in `docs/rpc.md`, and the `(4.2)` regression block in `test/rpc-session-occupancy.test.ts`.

## `ensureHost` teardown never outranks the readiness diagnostic (2026-09-04)

### What changed

- `host-ensure.ts`: the readiness-failure path captures a `stopManagedHost` failure into the diagnostic instead of letting it propagate, so the readiness message is still composed, still appended to stderr, and `cleanupState` still runs.
- `host-ensure.ts`: new `pidFileOwnsProcess` absorbs an identity-probe failure as "cannot prove ownership" instead of throwing; `signalValidated` and `waitForGone` route through it, and the probe is threaded into `stopManagedHost` so both are injectable.
- `host-ensure.ts`: `_test.readProcessStartTime` overrides the probe, making the win32-only failure reproducible on any platform.
- `host-ensure.ts`: the readiness-failure teardown stops the child through its still-attached handle (`stopSpawnedChild`: SIGTERM → childExit → SIGKILL) instead of re-validating our own pidfile with the identity probe whose failure is the very symptom on a loaded runner. `stopManagedHost` stays for hosts this call did not spawn, and its `signalValidated`/`waitForGone` read ownership as a tri-state (`owns`/`gone`/`unknown`, one probe per poll): unknown never signals and never counts as gone.
- `../app-server/daemon/process.ts`: `processMatchesPidFile` no longer leaks a probe failure as a verdict. A failed probe against a pid that is not live is "gone" (`false`); against a LIVE pid it is an observation gap that is retried within a bounded budget (`IdentityProbeRetry`, default 5 × 200 ms) and only then surfaces as the typed `ProcessIdentityUnreadableError`. `readProcessIdentity` applies the same rule one layer down: a query that fails (timeout or non-zero exit) against a dead pid is `absent` on every platform, not `error`. This is the seam shared by `host-ensure.ts`, `app-server/daemon.ts` and `host-lifecycle.ts`, so all of them inherit it.
- `host-ensure.ts`: `_test.readProcessStartTime` now governs every probe on the ensureHost path (startup `waitForStartTime`, the unhurried fallback read, attach-path ownership, teardown), so the Windows-only failure shapes are reproducible on any platform.
- `test/rpc-host-ensure.test.ts`: startup succeeds, then the probe fails during teardown (the CI shape); a pinned probe after registration; concurrent starts with a probe that fails transiently on a live pid; a failing probe against a genuinely dead pid reads as gone and a fresh host starts; and seam-level cases for `processMatchesPidFile` (retry-then-answer, dead-pid short-circuit, typed error on exhaustion).

### Why

- `RPC named pipes (Windows)` failed with `Command failed: powershell.exe -NoProfile` instead of `did not answer get_protocol_info` (senpi #1290; hit PR #1357 attempt 1, passed on attempt 2). `readProcessStartTime` throws when the CIM read fails, and `stopManagedHost` runs before the diagnostic is built, so the probe error replaced the real reason and skipped `cleanupState`, leaving the pidfile and socket behind.
- The starved-probe fix in this same tracker covered the STARTUP path (`waitForStartTime`) and only the TIMEOUT shape; a probe process that exits non-zero (`Command failed: powershell.exe … Get-CimInstance …`) still threw from every other caller, and `serializes concurrent starts for one socket across agent directories` kept failing on main with that message after #1355.
- A probe failure is an observability gap, not a verdict about the pid: treating it as a match would signal a pid this start cannot prove it owns, so "cannot prove ownership" is the only safe reading.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- Host spawn, pidfile ownership and endpoint cleanup live inside `ensureHost`; no extension observes the window between a failed readiness poll and the teardown that follows it.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/rpc/host-ensure.ts` — `stopManagedHost`, `signalValidated`, `waitForGone`, and the readiness-failure tail.

## `waitForStartTime`: a starved identity probe is UNKNOWN, not a dead child (2026-09-04)

### What changed

- `waitForStartTime` (`../app-server/daemon/process.ts`) takes an `isLive` probe (default `processIsLive`) and returns `string | undefined`. When the budget expires it now throws ONLY if the pid is really gone; a live pid yields `undefined` (UNKNOWN).
- Both callers — `host-ensure.ts` (RPC socket host) and `app-server/daemon.ts` — treat UNKNOWN by taking one unhurried `readProcessStartTime(pid, platform, 15_000)` read, and only fail when that also comes back unreadable. Neither writes a pidfile without an ownership identity.

### Why

- Windows CI failed on PR #1351 and #1352 with `spawned daemon pid N had no process start time` (runs 33839093178, 33842155236) while the spawned host was healthy; both PRs touched only prompts, and `--failed` reruns passed.
- `readProcessIdentity` defaults to a **1s** timeout on win32. `host-ensure.ts` called `waitForStartTime(pid, 10_000)` without a probe timeout, so on a loaded runner where `Get-CimInstance` needs longer than 1s, every attempt times out, throws, is swallowed by the existing retry, and the 10s budget dies after ~9 attempts. The retry was already there; the defect was that an OBSERVABILITY failure was reported as a startup failure, and liveness was never consulted on this path (#1294 added that distinction only to the lifecycle watchdog).

### Why this cannot be expressed externally

- The pidfile ownership guard requires a real process identity, so the decision between "no identity yet" and "child died" has to be made where the child handle is still owned. A caller outside this module cannot tell a timed-out probe from an absent process.

## `media_placeholders`: inline tool-result images are replaced at one choke point (2026-09-03)

### What changed

- New pure module `media-placeholders.ts` exports `omitInlineMedia(record)`. It replaces `{type:"image", data:<base64>}` blocks with `{type:"image_ref", mimeType, byteLength, ref:{toolCallId, contentIndex}}` inside every object carrying `role:"toolResult"` and inside `tool_execution_end.result.content`. `byteLength` is derived from the base64 string length (`floor(len*3/4) - padding`); the payload is never decoded. User-authored images (`prompt.images`) are left intact.
- The transform is type-gated first: only `tool_execution_end`, `message_start`, `message_end`, `turn_end`, `agent_end`, `entry_appended`, and `response` records whose command is one of `get_messages`, `get_entries`, `get_tree`, `get_state`, `open_session` are walked. `message_update` — one record per token — is never walked.
- The walk is copy-on-write and returns the SAME record reference when nothing changed, so unchanged sub-trees keep their identity and live agent state handed to `success()` by reference is never mutated.
- `SessionEventWriter.enqueue` applies it once, after `targets()`: when no target advertises `media_placeholders` the record is not walked and `serializeJsonLine` is still called exactly once, byte-identical to before. Otherwise the placeholder line is built once and each target is handed the variant it advertised.
- `SessionEventFanout` gained the generic `connectionHas(id, capability)` accessor; the four hard-coded `"rendered_components"` string checks now go through it with `RENDERED_COMPONENTS_CAPABILITY`. Behavior is unchanged.
- `SnapshotRecord` gained `placeholderLine` and the source record. `replaySnapshot` picks the variant by the attaching connection's capability; the variant is derived on the first capable replay and memoized, so a session with no capable client pays nothing and replay stays O(1) per record.

- `rpc-types.ts` adds the `get_media {toolCallId, contentIndex}` command, its `get_media` response and `RPC_ERROR_MEDIA_NOT_FOUND`; `connection-handler.ts` answers it (`findToolResultMedia`: durable session entries first, live messages second) and lists `media_placeholders` in classic-mode `get_protocol_info`; `session-command-router.ts` lists it in multi-mode `get_protocol_info`; `rpc-client.ts` gains `getMedia()`; `custom-capability.ts` declares `MEDIA_PLACEHOLDERS_CAPABILITY`.

### Why

- Four base64 `read` results overflowed a socket queue in one burst (2026-09-03, omo-desktop) and the host then dropped every record and command response for that connection. Gating the bytes on a client capability is the structural fix the previous entry recorded as a follow-up.
- The image-carrying wire paths are not enumerable reliably: beyond the obvious events, `entry_appended`, `get_entries`, `get_tree` and `open_session`'s `state.entries` all carry `ToolResultMessage.content`. Every one of them converges on `SessionEventWriter.enqueue` in multi-session mode, so the transform runs there once instead of at each call site.

### Why this cannot be expressed externally

- The rewrite has to live inside the host: only the host knows which connection advertised the capability and which records converge on `SessionEventWriter.enqueue`; a client-side filter would still receive the bytes it wants to avoid. Classic single-connection stdio mode is out of scope: applying the transform there needs a second application point in `connection-handler.ts`, and no stdio client asks for placeholders.
- A default client (one that never advertised `media_placeholders`) receives byte-identical output.

### Expected merge conflict zones

- LOW: `session-event-writer.ts` `enqueue` fan-out loop and `session-event-fanout.ts` snapshot record shape.

## Socket fan-out: lossless supersession, and overflow closes the socket (2026-09-03)

### What changed

- `SocketEventSinkActor.enqueue` takes an optional delta-only line for keyed records. When a later record with the same key supersedes a queued one, the queued entry is rewritten to that delta-only form (`message: null`, `partial: null`, delta kept) and keeps its position; only the newest record carries the cumulative snapshot. Keyed records without a delta-only form are kept verbatim (the key is dropped) instead of being replaced.
- `SessionEventWriter` supplies the demoted line for compact `message_update` deltas on the socket path, through the same `demoteToDeltaOnly` the stdout queue's `demoteAndMerge` uses.
- On queue overflow the actor raises `SocketEventQueueOverflowError` (queued/incoming/max bytes + a preview of the incoming record) and `SessionEventFanout` now logs it to stderr and calls the connection's new optional `close()` (`RpcConnectionSink.close`, implemented by `socketSink` as `socket.destroy()`), after the existing `overflow` record is written.
- `DEFAULT_QUEUE_BYTES` rises from 4 MiB to 64 MiB.

### Why

- A desktop RPC client assembles assistant text from `text_delta` records. Latest-wins replacement of queued `message_update` lines dropped every delta a stalled reader had not received yet; live (2026-09-03, omo-desktop) an assistant message lost 252 chars of head and 159 chars of thinking tail and rendered as "ared Claude conversation…". The stdout path already demotes-and-merges losslessly; the socket path did not.
- Overflow used to write `{"type":"overflow"}`, close the actor and forget the connection while the socket stayed open. From then on the host silently dropped every session record and every command response for that connection; the desktop froze and every RPC timed out. Four image `read` results (base64) exceeded the 4 MiB cap in one burst on an otherwise healthy reader.

### Follow-ups

- Image/binary tool-result payloads still travel inline to every attached RPC client; gating them on a client capability (metadata + on-demand fetch) is the structural fix for the cap.

## RPC logins answer mid-flow OAuth prompts over the dialog channel (2026-09-03)

### What changed

- New `modes/rpc/login-prompts.ts` exports `createRpcLoginPromptCallbacks(ui, signal)`. It bridges the provider's `onPrompt` and `onSelect` callbacks onto the extension UI dialog channel: `text`, `secret`, and `manual_code` prompts become an `extension_ui_request` with method `input` (title = prompt message, optional placeholder); `select` prompts become method `select` with the option labels, and the chosen label is mapped back to the option id in-process.
- `connection-handler.ts` `startLogin()` spreads those callbacks in place of the old `rejectInteractive` pair. A second `settled` AbortController is combined with the login controller via `AbortSignal.any`, and the `finally` block aborts it first, so an unanswered dialog is released (pending entry deleted) the moment the login settles for any reason: success, failure, or `login_cancel`.
- Cancel semantics mirror the TUI's `showAuthPrompt`: a dismissed dialog (`cancelled: true`) or an aborted prompt signal rejects with `Error("Login cancelled")`, which surfaces as `auth_login_end` with `success: false`.
- `onManualCodeInput` stays undefined on purpose; `AuthStorage.handleLegacyPrompt` already routes `manual_code` to `onPrompt`.
- Secrets never cross the wire. Only the prompt message, placeholder, and option labels go out; the client's answer is consumed in-process and never echoed back.

### Why

- senpi#1316: providers whose OAuth flow needs mid-flow input could not log in over RPC. Anthropic Claude Pro/Max is the loud case: `loginAnthropic` races the local callback listener against a `manual_code` prompt right after emitting the auth URL. The old `rejectInteractive` threw immediately, which set `manualError`, called `server.cancelWait()`, and closed the listener roughly 150ms after `auth_login_url` went out. The browser then landed on connection refused, and the login failed no matter what the client did.
- With the prompt parked on a real dialog, the race resolves the way it does in the TUI: whichever side finishes first wins, and the loser is released. A client that never answers loses nothing, because the browser/callback path completes the login and the settled signal drops the dangling request.

### Why this cannot be expressed externally

- The login callbacks are wired inside the RPC connection handler when it calls `AuthStorage.login`; no extension seam sees them.

### Expected merge conflict zones

- LOW: the `startLogin` callback object and its `finally` block in `connection-handler.ts`, plus the doc comment above it.

## Startup failures keep their own diagnostic (2026-09-02)

### What changed

- `host-ensure.ts` `startHost()` latches whether the child had already exited (`exitedBeforeCleanup`) BEFORE the cleanup kill runs, and both the rethrow guard and the `exited ... before answering get_protocol_info` diagnostic now read that latch instead of the live `exitedEarly`.

### Why

- The cleanup kill is indistinguishable from a real self-exit at the observation point: `child.kill("SIGTERM")` makes the `exit` listener assign `exitedEarly = { code: null, signal: "SIGTERM" }`, so by the time the catch re-checked it the `!exitedEarly` rethrow was skipped and the original startup error was discarded forever. Every genuine startup failure was therefore reported as the host dying unprompted, with the host's stderr empty because it never got far enough to write any.
- That is the root of the `RPC named pipes (Windows)` flake tracked in #1290 variant 1: the 4-vCPU runner produces the transient startup failure, and this code path replaced the evidence with a misleading self-inflicted message. Four separate sessions read those CI logs without being able to find a cause, because the cause had been thrown away.
- Reproduced deterministically on macOS via the new `_test.beforePidFileWrite` hook, which fails registration while the child stays healthy — the same shape a loaded runner produces. The flake was never Windows-specific; Windows only made the triggering failure frequent.

### Why this cannot be expressed externally

- It is the mode's own spawn/registration error path.

### Expected merge conflict zones

- LOW: the `startHost()` catch block in `host-ensure.ts` and the `_test` option shape.

## [Unreleased] - Feed the supervisor's observer lifecycle records

### What changed

- `session-event-fanout.ts` delivers content-free lifecycle records (`agent_start`, `agent_settled`, `agent_idle`, `session_opened`, and `session_closed`) to every registered socket connection, including unattached observer connections. Session content, rendered component records, responses, and dialog requests retain their attachment/requester scoping.
- The lifecycle supervisor's always-on internal observer therefore receives the turn boundaries required to prevent idle shutdown during an active turn without reopening cross-session content delivery.

### Why

- The supervisor must observe active turns independently of client session attachments; otherwise attached-only delivery leaves it believing an active host is idle.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- Socket fan-out and supervisor lifecycle accounting are transport behavior below the extension API.
## 2026-09-02 - Reap orphaned host dirs outside the endpoint lock

### What changed

- `packages/coding-agent/src/modes/rpc/host-ensure.ts` runs `reapOrphanedInternalHostDirs()` before `acquireOwnershipSafeLock()` instead of inside the locked section.
- `packages/coding-agent/test/rpc-host-ensure-lock-scope.test.ts` pins that ordering at the seam.

### Why

- The reaper's cost is unbounded in the size of the whole temp directory: it `readdir`s `tmpdir()` (measured: 132,035 entries, 394-467ms on a fast local SSD), then per `senpi-rpc-host-internal-*` candidate reads `.owner`, re-reads the directory, and calls `processMatchesPidFile()`. On win32 that last call spawns `powershell.exe Get-CimInstance` per candidate with a 1s default timeout. Running that opportunistic GC inside the exclusive endpoint lock made hold time scale with temp-directory size and PowerShell latency, so on the 4-vCPU `windows-latest` runner a concurrent `ensureHost` waiter could exhaust even the 42s lock budget and surface a raw `database is locked`. Raising the budget cannot fix a critical section whose cost is unbounded; the GC simply does not belong inside the lock.
- The reaper's own guards already make it safe unlocked: it only removes directories older than 60s whose owner pid is provably dead, so it never contends with the caller's own ensure.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- The reap runs inside the host handshake below the extension API.

### Expected merge conflict zones

- LOW: the `reapOrphanedInternalHostDirs()` / `acquireOwnershipSafeLock()` ordering at the top of `ensureHost`.
## 2026-09-02 - Size the ensure-host lock wait to the startup critical section

### What changed

- `packages/coding-agent/src/modes/rpc/host-ensure.ts` derives the ensure-lock wait budget (`ENSURE_LOCK_WAIT_MS`, 42s) from the longest critical section a holder can run - existing-host probe, incompatible-host stop (SIGTERM wait plus SIGKILL grace), then spawned-host readiness - instead of the previous 10s (100 x 100ms) constant that only covered a fraction of it. The stop/readiness/SIGKILL literals now share named constants with that derivation.

### Why

- Two concurrent `ensureHost` callers for one socket serialize on the SQLite ensure lock; when the first holder's section outlived 10s the second surfaced a raw `database is locked` instead of reusing the host. This flaked the Windows RPC named-pipes CI job (`serializes concurrent starts for one socket across agent directories`) and is the same failure a second interactive session would hit on a slow machine.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

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

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

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

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

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

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- Socket fan-out and client lease filtering are transport behavior below the extension API.

## [Unreleased] - Preserve launch capabilities for undeclared multi-session clients

- `session-command-router.ts`: connection-owned session bindings now fall back to the host launch capabilities when the client has not sent `set_client_info`; an explicit empty capability declaration still wins.

### Why

- Multi-session hosts launched with `extension_events` advertised the capability but did not forward extension events to clients that never declared capabilities, breaking omo-desktop-app subagent/monitor liveness since 2026-08-28.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

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

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

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

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- Idle accounting, admission, and host lifetime live in the routing and supervisor layers beneath every extension surface; extensions cannot observe routed-command timing, registry occupancy, or process exit classification.

### Expected merge conflict zones

- LOW: the registry options/entry tail in `session-registry.ts`, the router constructor tail plus the sweep/eviction methods in `session-command-router.ts`, `createHostCore` with the policy constants in `multi-session-host.ts`, the child-exit handler in `host-lifecycle.ts`, and the `forgetSession` accessor in `session-event-writer.ts`.

## 2026-08-30 - Shared-host rendered component capability lifecycle

### What changed

- `widget-line-renderer.ts`, `connection-handler.ts`, `rpc-types.ts`, `custom-capability.ts`, `host-ensure.ts`, `session-binding.ts`, `session-command-router.ts`, `session-event-writer.ts`, and `multi-session-host.ts` implement per-connection rendered-component delivery, capability-aware snapshot replay, shared width registration, and renderer/provider teardown and recreation.

### Why

- Shared socket clients can join or leave independently, so factory-rendered UI provenance, capability state, and live renderer resources must follow connection lifecycle without affecting surviving sessions or leaking footer watchers.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

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

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

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

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

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

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

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

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

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

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

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

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

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

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

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

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

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

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

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

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

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

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

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

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

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

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

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

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

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

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

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

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

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

## 2026-09-12 - Sync CI repair: RPC client stop kills the real spawned host under bun re-exec

### What changed

- `packages/coding-agent/src/modes/rpc/rpc-client.ts`: `RpcClient.stop()` kills the process tree of the RPC host it spawned, not only the wrapper pid, so under `SENPI_RUNTIME=bun` (where cli.ts re-execs the node wrapper under Bun) the real Bun host is terminated instead of being orphaned and leaking an ENOTEMPTY temp-dir error into `afterEach`.

### Why

- The wrapper exits immediately after re-exec, so resolving `stop()` on the wrapper's exit event left the real host holding the session dir open; the merged bun re-exec made that wrapper indistinguishable from the host.

### Why (flake audit, requested after a 2-in-28 failure under load)

- Two waits in this area were satisfied by ELAPSED TIME rather than by an observed signal, and both fail as a bare `Error: kill ESRCH` - a failure with no assertion text, which is exactly what a count-only loop reports. (1) `test/rpc-host-handoff.test.ts:37-38` read `processAlive(pid)` and then signalled: TOCTOU in the SHARED teardown, so it can fail any case in the file. (2) `test/rpc-host-handoff.test.ts:101` SIGKILLed the predecessor after a handoff in a case that opened no session, so the predecessor's registry was empty and its drain sweep called the empty-exit hook on the first pass; the test then ran a `stat` and a full `probeHost` round trip before signalling. Measured budget for that window: the predecessor is gone ~660 ms after the handoff is requested, and a probe on a loaded runner can outlast it.
- The fixes are state-based, not wider timeouts: the teardown signals through `signalGeneration` (already-gone is a `false`, not a throw), and the kill9 case now holds an ATTACHED session on the predecessor, which the drain sweep refuses to park (`session-command-router.ts` skips entries with `attachments > 0` and exits only at `registry.size === 0`), so the process is alive by invariant when the case signals it.
- `test/rpc-host-signal.test.ts` (new) locks the helper: a live pid reports delivery and the process exits with that signal; a pid that has already exited reports `false`. Reverting the helper to a bare `process.kill` fails the second case with `Error: kill ESRCH`.

### Why an extension could not handle it

- Process lifecycle for the RPC transport is host-side plumbing below the extension layer.

### Expected merge conflict zones

- LOW: the `stop()` implementation and the spawn bookkeeping in `rpc-client.ts`.


## 2026-09-27: Release closed RPC session and connection bookkeeping

### What changed

- `packages/coding-agent/src/modes/rpc/session-command-router.ts` now forgets a closed handle after runtime teardown and its terminal records, removes released connection capabilities and empty width maps, and suppresses an orphaned pending open response.
- `packages/coding-agent/src/modes/rpc/session-binding.ts` stops late async command output and shutdown callbacks after binding disposal before entering a closed provider scope.

### Why

- `packages/coding-agent/src/modes/rpc/session-command-router.ts` previously retained one writer seal for every explicit close; connection capability and empty width maps also outlived their owners. Idle eviction already forgot seals, but explicit close did not.
- `packages/coding-agent/src/modes/rpc/session-binding.ts` must make disposed producers silent before those seals can be released; a command completing later could otherwise emit after the terminal response or throw from its closed provider scope.

### Why an extension could not handle it

- `packages/coding-agent/src/modes/rpc/session-command-router.ts` owns shared-host attachment, finalization, and writer bookkeeping.
- `packages/coding-agent/src/modes/rpc/session-binding.ts` owns the scoped output sink and its disposal boundary; extensions cannot close that transport lifetime.

### Expected merge conflict zones

- `packages/coding-agent/src/modes/rpc/session-command-router.ts`: pending-open completion, shared width callbacks, connection release, and final close ordering.
- `packages/coding-agent/src/modes/rpc/session-binding.ts`: scoped sink creation and binding disposal.
