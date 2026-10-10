# packages/coding-agent/src/modes/rpc

JSONL-over-stdio RPC mode for driving Senpi sessions programmatically (TUI-less). One UTF-8 JSON object per LF-delimited line; requests in, events out. The public protocol reference is `packages/coding-agent/docs/rpc.md`.

## STRUCTURE

```text
rpc-mode.ts               Mode entry: session binding, main loop
connection-handler.ts     Connection lifecycle; owns the command-digest baseline,
                          get_commands responses, commands_changed emission
jsonl.ts                  Strict LF framing; MAX_RPC_LINE_CHARACTERS (16 MiB)
                          ceiling with oversized-record resynchronization
rpc-input-validation.ts   Inbound bounds: MAX_RPC_MESSAGE_CHARACTERS (1,000,000)
rpc-command-surface.ts    RpcSlashCommand snapshot, digest, baseline comparison
rpc-command-invocation.ts command_invocation / skill_invocation event types
multi-session-host.ts     Multi-session RPC host; selects the session runtime
session-registry.ts       IN-PROCESS runtime (default for `--listen`): every session on the
                          host loop, NO session cap of any kind
worker-session-registry.ts WORKER runtime (stdio hosts, embedders): one isolate per session,
                          20-worker capacity, the ONLY source of `too_many_sessions`
session-binding.ts, session-command-router.ts,
session-event-writer.ts, session-event-fanout.ts,
session-extension-ui-requests.ts                            Session wiring
host-session-control.ts   `registerControlEndpoint` on a host session + the `wake` command (drain passes)
session-release.ts        `release_session`: hand a session to a local runtime (bookkeeping entry, park teardown)
session-release-interrupt.ts  An `interrupt` release: take queued input (`dropped`), abort, bounded settle
session-attribution.ts    AsyncLocalStorage {sessionId, tool} the stall watchdog blames by
loop-lag-watchdog.ts      200 ms drift probe -> stderr line + `host_stalled` record
host-memory-sampler.ts    30 s footprint sampler (core/process-footprint.ts) -> `host_memory_pressure`; halves the idle window
child-reaper.ts           Reaps exited children no live thread is left to wait on
host-ensure.ts            ensureHost(): probe, decide, spawn through the lifecycle supervisor
host-ensure-lock.ts       The per-endpoint ensure lock ensure, handoff and gc all take (canonical socket key)
host-decision.ts          decideHostAction(): start|reuse|handoff|refuse|fallback (I1, I2)
host-protocol-info.ts     get_protocol_info boundary parse (identity, ordinal, launch profile)
host-handoff.ts, host-successor.ts, host-stop.ts, host-probe.ts, host-launch.ts
                          Generation handoff: bring the successor up, drain the predecessor
host-daemon-paths.ts, host-daemon-state.ts, host-daemon-registration.ts
                          Per-socket daemon directory, pointer pidfile, generations (I3)
host-launch-spec.ts       `--launch-spec` parse + trust proof; host-daemon-env.ts = env allowlist
host-runner.ts            The `senpi host` requests -> { payload, exitCode }
host-session-runner.ts    Short-lived attached clients for `senpi host session`; host-session-ref.ts resolves a
                          session reference, host-session-wait.ts the event-driven `wait`, host-session-errors.ts the exit mapping
host-status.ts, host-process-metrics.ts   status report: identity, sessions, generations, tree
host-status-rows.ts       status detail: listed session rows, reservations/ claim rows
host-endpoints.ts, host-status-all.ts     `status --all`: enumerate endpoint dirs (`endpoint_kind` rpc_host | tui), report without pruning
host-endpoint-liveness.ts `classifyEndpointLiveness`: routable | live_unresponsive | dead; per-kind probe budget (tui 1.5 s)
tui-socket.ts             Terminal control socket name `t-<16hex>.sock`; a client sends the secret first on every platform
rpc-session-state.ts      `buildRpcSessionState`: the one wire projection of a session (RPC `get_state`, `open_session`, TUI endpoint)
host-gc.ts, host-gc-evidence.ts           `host gc`: remove dead endpoint dirs on three-part evidence
host-gc-pass.ts, host-gc-pass-marker.ts   The budgeted gc pass ensure schedules after returning (`gc-last-run.json`)
host-ensure-{start,stop,client,types}.ts, host-internal-dir-reaper.ts, host-ensure-liveness.ts   ensureHost's start + readiness gate, the recorded stop path, client identity, options, tmpdir reaper, stall refusal
host-observers.ts, host-zero-session-trim.ts  Host self-observation: stall watchdog, memory sampler, zero-session trim (`host_trimmed`)
host-lifecycle.ts, supervisor-route.ts    Supervisor that owns the public socket + idle exit (orchestration only)
host-lifecycle-{launch,proxy,activity,drain,shutdown,scratch,stall-wait}.ts, host-cli-entry.ts, host-supervisor-log.ts
                          Supervisor argv/child launch (CLI entry resolution), public proxy, idle activity, drain, teardown + child stop,
                          scratch dir, the bounded wait for a stalled child, the supervisor's stderr log line
host-stop-intent.ts, host-child-exit.ts, host-crash-record.ts
                          Stop intent per generation, how a generation's end is read, `crashes.jsonl`
host-stalled-evidence.ts  Per-generation stall evidence + heartbeat, stop progress; `host_stalled` refusals read it
loop-lag-threshold.ts     The stall threshold shared by the host's watchdog and every evidence reader (a supervisor leaf)
host-endpoint-names.ts, host-generation-paths.ts, host-state-json.ts
                          Endpoint dir/socket names, a generation's file paths, the atomic JSON writer the evidence files use
host-lifecycle-policy.ts  Cold-start / idle-exit policy resolution + the pure IdleExitDecider
host-client-occupancy.ts, host-observe-request.ts
                          Which public clients count for idle exit; `observe: true` reads never do
rpc-client.ts, rpc-types.ts, custom-capability.ts, event-output-buffer.ts
changes.md                Fork-specific RPC behavior record
```

## COMMAND-SURFACE LIFECYCLE

- On bind/rebind, `connection-handler.ts` builds the ordered `RpcSlashCommand` snapshot and digests it (`rpc-command-surface.ts`).
- The baseline digest starts `undefined`: the first snapshot is recorded WITHOUT emitting `commands_changed`. That baseline suppression is intentional (it removed the initial client-refresh feedback loop) — do not "fix" it into an emission.
- `commands_changed` fires only when a later snapshot differs (extension reload, rebind, config change); clients refetch via `get_commands`.
- `command_invocation` / `skill_invocation` are additive typed metadata on prompt events; they do not replace `loaded_surfaces_changed` / `get_loaded_surfaces`.
- Skill expansion (`$name`, `$skill:name`) happens in prompt preprocessing and must not reset or reorder MCP loaded surfaces.

## INVARIANTS

- Framing is strict LF. Records over `MAX_RPC_LINE_CHARACTERS` are dropped with resynchronization rather than killing the stream; preserve that recovery behavior.
- Inbound messages over `MAX_RPC_MESSAGE_CHARACTERS` are rejected with a typed error; non-object JSON is rejected.
- Pending work is rejected on disconnect or child exit; preserve request/response correlation.
- Child stderr is emitted and embedded raw; treat diagnostics as secret-bearing.

### Shared-daemon invariants (I1-I4)

One host per endpoint; a client may run many endpoints under one agent dir (omo runs one per parent session, the Desktop one per thread, under `rpc/shards/`); every invariant below holds per endpoint, for every surface that touches it - CLI, desktop, task runner:

- **I1** — never terminate, signal or replace a host this process did not start. A mismatch ends in `refuse`, never in a second host bound over somebody else's endpoint. The only carve-outs are `stopHost` against a validated own-writer pidfile with zero foreign attached/retained sessions (or explicit `force`), and a drain, which ends no work. A handoff may also bind over an IDLE host that no registration proves (#2701): that host is never signalled - it drains itself on losing the public entry - and a busy one is refused.
- **I2** — compatibility is `protocolVersion` + capabilities, never a version-string comparison. An uncomparable `engineOrdinal` is EQUAL, and a handoff needs STRICTLY greater, so an unknown-age build attaches instead of upgrading.
- **I3** — only the owning generation writes its daemon state; everyone else reads. Clients fail CLOSED (report, or start their own private host) and never edit, unlink or delete another generation's files, socket or pidfile. Layout 2 deliberately writes no flat `host.pid`, which is what makes pre-layout-2 clients fail closed instead of taking the daemon over. An ensure may claim `owner.json` only for the matching serving generation, under the endpoint lock and attach hold, and only while unowned or after confirmed owner death. The other cross-writer is the stop intent (`host-stop-intent.ts`): whoever is about to signal a generation writes `generations/<instanceId>/stop-intent.json` into THAT generation's directory first, because the target cannot know who is about to stop it; no code reads or removes another generation's intent, the supervisor layers its own step over an outer intent instead of overwriting it, and a drain writes none. Every caller that SIGKILLs a supervisor writes that generation's terminal record into `crashes.jsonl` BEFORE it releases or clears the registration that holds the intent (senpi#2566).
- **Endpoint removal** — `gcEndpoint` (`host-gc.ts`) is the ONLY code that removes an endpoint directory, reached from exactly two entry points on the same evidence: `gcHostEndpoints` (`senpi host gc`) and the budgeted pass `ensureHost` schedules AFTER it returned a host (`host-gc-pass.ts`: detached and unref'd, never awaited by the ensure, outside every lock, at most once per 5 min per agent dir, 1.5 s / 32 endpoints, a fair rotation resumed after the marker's cursor, uncollectable endpoints skipped with a 10 min to 24 h backoff, the ensure's own endpoint never judged). It removes an endpoint directory (`endpoint.json` included), its socket or its `.next-*`/`.shield-*` siblings, and only on the three-part evidence read INSIDE that socket's ensure lock (`hostEnsureLockTarget`): no live generation pidfile (the pointer's generation included), no live claim owner, a socket that refuses or is absent (successor binds included). It removes siblings, then the socket, then the directory LAST (a failed removal stays listed for the next gc), leaves a directory-typed sibling in place (`skipped`), and records one endpoint's failure as `failed` without stopping the run. It never signals, never runs inside the ensure lock or `status`, and never touches a layout-1 flat directory or a directory whose socket nothing names.
- **I4** — worker sessions are invisible by default: `kind: "worker"` rows need `include_workers: true`, `context` is published on that listing only, and their `session_closed`/`session_parked` records go to attached connections only.
- **Endpoint kinds** — a `tui` endpoint (a terminal's control socket, `t-<16hex>.sock`) is owned by its terminal process. `runHostRequest` refuses `ensure`/`handoff`/`stop` against one with `unsupported_endpoint_kind` (exit 3) from `endpoint.json` or the socket name alone, BEFORE any connection; `status --all` sends it `get_protocol_info` + `list_sessions` only and reports `owner`; `gc` reaps a dead one on the same three-part evidence. `alive` is judged from the socket's own `get_protocol_info` answer (`probeHostStatus().answered`), never from the recorded generation the report falls back to.
- **Wake** — `wake` on a host session has the terminal endpoint's contract: one `WakeScheduler` pass, answered with its `{ admitted }`; no registered drain answers `admitted: []`. A host session's registration binds nothing (the host socket is the endpoint) and is `unsupported_mode` without a public `host_socket`.
- **Release** — `release_session` is the only way a host gives a live session's file to another writer, and only a QUIET session: no run, no prompt in preflight (`binding.pendingPrompts`), no unwritten admitted delivery, no bash/compaction/barrier work (the handoff fields), and no OTHER in-flight router request for the session (`activeRequests` minus the release). `isStreaming` alone is not enough - a user bash and a prompt in preflight both write after it. Only the FINAL check, `externalAdmission.close()` and the close claim are one synchronous step (an `interrupt` release awaits before it) - a drain pass still running cannot admit into a session being torn down. `interrupt` empties the queues first (`clearQueue`) and answers what it took in `dropped { deliveries, user_messages }` - on success AND on every refusal after it, which also reopens admission (`try/finally` in `releaseSession`): queued input never vanishes silently and a refused release never leaves admission closed; a `queued` refusal carries `retry_with: { interrupt: true }`; a throw after admission closes (the entry write, the teardown) is answered `release_failed { detail, interrupted?, dropped? }` and reopens admission - the release entry is written with `appendCustomEntry`, and a failed append keeps nothing in memory, so a failed write leaves no phantom entry; a refusal without `interrupt` (`turn_active`, `session_busy`, `attached`, `release_unsupported`, `host_draining`) changes nothing; attached clients are told `session_closed { reason: "released" }`, never `session_parked` (reopening the path on the host would make a second writer).

### The no-sync rule

- The in-process runtime puts every session on ONE loop: a synchronous wait taken on the session path is an outage for every client. `execSync`, `execFileSync`, `spawnSync`, `Bun.spawnSync`, `Bun.sleepSync` and `Atomics.wait` are banned on that call graph; `test/suite/no-sync-in-session-path.test.ts` fails on any call site the checked-in ledger does not already record, and reports sync fs against the same ledger.
- The in-process path has NO session cap. If a change makes the shared daemon refuse an `open_session` for occupancy, it is a defect, not a policy - `too_many_sessions` belongs to `worker-session-registry.ts` alone. Memory never refuses an open either (senpi#2207): each endpoint reports its own pressure and halves idle parking, while every pressured endpoint still admits worker opens. `host status --all` exposes `rss_mb` for the endpoint process tree and `host_rss_mb` for its supervisor plus host; never turn either measurement into an admission gate.
- The socket dead-peer budget counts loop-SERVED time (`loop-blocked-time.ts`): a host stall must never cut a live peer. A session's provider scope closes only after its disposal settles (`session-teardown.ts`), and a config-reload callback bound to a closed scope is a no-op (`session-scoped-callback.ts`).
- Capacity is memory and threads: roughly 1 thread / 2 fds / 5-8 MB per open session, the thread coming from the `config-reload` builtin's per-session watch Worker (senpi#1794). Never claim it is flat.

## WHERE TO LOOK

| Task | File |
|---|---|
| Add/change a command-surface event | `rpc-command-surface.ts`, `connection-handler.ts` |
| Change framing or input bounds | `jsonl.ts`, `rpc-input-validation.ts` |
| Invocation metadata on prompts | `rpc-command-invocation.ts` |
| Session wiring / multi-session | `session-*.ts`, `multi-session-host.ts` |
| Daemon ensure/attach/refuse decision | `host-decision.ts`, `host-ensure.ts` |
| Generation handoff, drain, stop | `host-handoff.ts`, `host-successor.ts`, `host-stop.ts` |
| Daemon state directory + generations | `host-daemon-paths.ts`, `host-daemon-registration.ts` |
| `senpi host` behaviour / exit codes | `host-runner.ts`, `../../cli/host-command.ts` |
| Stall or memory reporting | `loop-lag-watchdog.ts`, `session-attribution.ts`, `host-memory-sampler.ts` |
| Protocol documentation | `packages/coding-agent/docs/rpc.md` |

## VALIDATION

- Focused tests live in `packages/coding-agent/test/rpc-*.test.ts` (rpc-jsonl, rpc-input-validation, rpc-command-invocation, rpc-commands-changed, rpc-multi-session-input, rpc-loaded-surfaces, rpc-classic-compat, rpc-prompt-response-semantics).
- Daemon suites: `test/suite/host-cli*.test.ts`, `test/rpc-host-ensure.test.ts`, `test/rpc-host-handoff.test.ts`, `test/suite/no-sync-in-session-path.test.ts`, `test/suite/rpc-inprocess-host*.test.ts`, `test/suite/rpc-session-context.test.ts`, `test/suite/rpc-retain-on-disconnect.test.ts`, `test/suite/rpc-loop-lag-watchdog.test.ts`, `test/suite/rpc-host-reaper.test.ts`, `test/suite/rpc-worker-capacity.test.ts`. Suites that spawn a host use `test/helpers/spawned-host-reaper.ts`; after any run `pgrep -f rpc-host-fixture.mjs | wc -l` must print 0.
- End-to-end scenarios: `.agents/skills/senpi-qa/scripts/scenarios/dollar-skill-invocation-qa.mjs` and `rpc-input-hardening-qa.mjs`.
- Live daemon QA (POSIX, sandbox agent dir, one JSON line per step, cleanup receipt last): `scripts/qa-rpc-socket/inprocess-daemon-qa.mjs` (two compiled generations end to end) and `scripts/qa-rpc-socket/generation-handoff.mjs` (the handoff alone).
- Behavior changes update `changes.md` here and `docs/rpc.md` in the same increment.
- Runtime changes require root `bun run check` and real CLI QA evidence.

---
Generated: 2026-08-17 | Commit `abae968e8` | Updated: 2026-09-18 (shared daemon, `senpi host`, I1-I4)
