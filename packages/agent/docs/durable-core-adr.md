# ADR: the durable core (engineering item E2)

- **Status:** accepted for implementation (docs only; no code in this change)
- **Date:** 2026-10-29
- **Issue:** [#4723](https://github.com/code-yeongyu/senpi/issues/4723)
- **Related:** [#2607](https://github.com/code-yeongyu/senpi/issues/2607) (durable sessions and a tool-execution seam, fitted to senpi's harness), [#4360](https://github.com/code-yeongyu/senpi/issues/4360) / [#4361](https://github.com/code-yeongyu/senpi/pull/4361) (ToolHost, step 1)
- **Input:** [`tool-durability.md`](./tool-durability.md), [`harness.md`](./harness.md)

## Context

The agent loop is to become host-agnostic and durable. One engine runs everywhere; where its loop runs is a placement choice: a Cloudflare Durable Object (the default for hosted loops), a pure Bun process on a server or VM, or the user's own machine. Tools always run through one execution interface, in process on one machine and over a transport across machines.

Only the loop modules of `packages/agent` are free of the filesystem and child processes today. The harness environment is not: `src/harness/env/nodejs.ts:1-20` imports `node:child_process`, `node:fs` and `node:os`. The boundary is therefore a module boundary that a dependency check enforces, not the whole package.

Upstream ships a durable runtime that does much of this, `@earendil-works/pi-durable`. Engineering item E2 asks one question before any durable code lands:

> Adopt pi-durable's Harness/Storage/task model inside senpi, or grow senpi's own durable core to the same contract?

## Decision

**Grow senpi's own durable core, built to the same contract as pi-durable, inside `packages/agent`.** pi-durable is the reference design (its storage contract, wake ordering and conformance suites), not a dependency.

The loop core depends only on four contracts, and one conformance suite runs every host against them:

| Contract | Owns | Does not own |
|---|---|---|
| **DurableStore** | Atomic commit with in-memory adoption (a batch is visible to the session only once it is durable, and never partially); ID minting; scans; documents. | Serialization. A single admission line above the store serializes every mutation; the store does not arbitrate concurrent writers. |
| **WakeHost** | Wake ordering for hosts that can be evicted or put to sleep: the host pre-arms a recovery alarm before it admits any work, updates it from the loop's wake state (`active`, `at`) after each commit, and resumes on fire. | Timers inside the loop. |
| **ToolHost** | The execution contract, the same on the fused path and the remote path: the batch executor and the execution ledger. Fused is an in-process call into the same executor; remote is an engine RPC client. | Delivery. |
| **Transport** | Opaque delivery with per-lane order, resume after reconnect, and backpressure. | Loops, hands, command IDs, epochs, deduplication, consent and fencing; those are endpoint duties. |

**Hosts.** Two durable backends: Durable Object SQLite and Bun SQLite. The durable session store requires Bun; no Node durable backend and no Node timer host are built. A Node process that would open session state is steered to Bun or the compiled binary (which bundles Bun) with a clear message, and keeps working for commands that open no session; a developer escape hatch keeps the legacy JSONL store reachable from Node.

**JSONL.** Today's session JSONL files are not a storage backend, because JSONL has no atomic multi-record commit. A one-way importer brings them into the durable store, under Bun, keyed by session ID, by tail (entries appended later are imported once, in order, past the store's high-water mark), and the store writes the JSONL projection that today's readers (`/resume`, history search, the desktop) read unchanged.

## Spike evidence

Source read of upstream `earendil-works/pi` at `556860a386a03113eca146abd9cbb08e9391b7fb` (2026-10-28), `packages/durable`, against senpi `main` at `3d0df57eb3e4514579a03e2407153d33e0d7651d`.

| Question | pi-durable | senpi today | Effect on E2 |
|---|---|---|---|
| Version and runtime dependencies | `@earendil-works/pi-durable` 1.4.0; depends on `chord` 1.4.0, `pi-ai` 1.4.0, `pi-codemode` 1.4.0, `pi-telemetry` 1.4.0, `typebox` 1.3.27, `diff` 8.0.4, `@silvia-odwyer/photon` 0.3.3 (`packages/durable/package.json`) | `packages/agent` depends on `chord` 0.99.1, the fork's `pi-ai` and `pi-telemetry` (`2026.10.27-2`), `typebox` 1.3.34, `diff` 9.0.0; upstream sync is pinned at pi-mono `v1.0.0` (`.github/upstream.json`) | Adoption pulls a second, newer `pi-ai`/`chord`/`codemode` line next to the fork's own. Every upstream release becomes a coupled bump of the provider stack. |
| Session model | Its own `Harness`/`Session`/task model (`src/harness/harness.ts`, `src/session/session.ts`, `src/harness/scheduler.ts`); the README marks the API experimental and changing without notice | senpi already has a durable harness: entries, values, usage ledger, transactional writes (`src/harness/session/types.ts:455-471` `Storage`), lane/operation state machine (`src/harness/runtime/`), normative spec in `docs/harness.md` | Adoption means two session models during the migration, with every existing surface (RPC, TUI, desktop, extensions) re-pointed at a foreign harness. Growing our own extends the model the surfaces already use. |
| Storage contract | `commit(writes, adopt, context)`: the backend calls `adopt(seq)` once the batch is durable, before its next commit starts; backends: memory, IndexedDB, SQLite (Node, Durable Object), JSONL | `commit(writes, context): CommitResult`; backends: memory, JSONL, SQLite (Node) | The adopt-on-durable rule is the property we need; it is adopted into DurableStore as a contract rule, not as a dependency. |
| Ownership and locking | "One process owns a storage at a time; there is no cross-process locking" (README, Storage) | Two processes can open the same session today | senpi needs an admission line above the store plus a claim (owner epoch) for a movable loop; the contract keeps serialization out of the store, as pi-durable does, and adds the claim on our side. |
| Wake ordering | `onWake` reports `active`/`at`; the Durable Object example arms an alarm before any call that can start work (README, Durable Objects) | Process timers only | Adopted as the WakeHost pre-arm rule. |
| Conformance | `registerStorageConformance` and environment conformance (`src/testing/storage-conformance.ts`, `src/testing/env-conformance.ts`), plus Workers tests for storage and wake (`test-workers/`) | `createStorageConformance` / `createSessionRepoConformance` for session backends (`src/harness/session/testing/`) | Model for our single suite; our suite adds the cases the contract table needs (below). |

**Alternatives rejected.**
1. *Adopt pi-durable as the harness.* Rejected for the coupled dependency line, the second session model, and the experimental API; each would put today's behavior on every surface at risk during the migration.
2. *Vendor pi-durable's source and adapt it.* Rejected: it carries the same second session model, and a vendored copy drifts from both upstream and our harness.
3. *A Node durable backend alongside Bun.* Rejected permanently: the durable store runs on Bun only.

## Conformance suite

One suite, run on every host; host reports are compared, and a host is conformant only when its report equals the reference.

- **Registry** (`packages/agent/src/conformance/registry.ts`). Every case maps to exactly one implementation file, the change that introduced it, the adapters it needs (`store`, `wake`, `transport`, `executor`, `host`), and its expected outcome. Case IDs are unique. Changes that add cases register them with their mapping in the same change.
- **Suite hash.** A digest over the case IDs and the implementation hash of each case. It changes when a case is added, removed or renamed, or when any case implementation changes.
- **Manifest export.** The registry is exported (package subpath `./conformance`) as a manifest: suite hash plus, per case, `id`, `impl`, `impl_hash`, `intro`, `adapters`, `expected`.
- **Host report.** Each host run writes `host`, `suite_hash` and one result per case (`pass`, `fail` or `skip`).
- **Comparison.** Two hosts conform when both reports carry the manifest's suite hash and the same full passed set, every manifest case is present, and nothing is skipped. No exclusions. A missing report, a skip or an unknown case fails the comparison.
- **Required case groups** (introduced by later changes): store cuts at every write point, a cut between commit and alarm-arm, eviction during an alarm write, concurrent admissions, an old owner's delayed command arriving after a new owner's first, claim plus import across hosts; wake pre-arm, update, resume and retention; transport order, resume and backpressure; per-scope order and fairness when one hand or transport serves several sessions; transport fault profiles; and kill-point recovery around every durable write and ToolHost transition.

**Bootstrap.** The registry and the runner exist before any host adapter. Until the Bun host adapter and the Durable Object host harness exist, host cells of the early changes are recorded as deferred to the phase-level main-axis gate, never as passed.

## Invariants every later change keeps

- **Today's behavior does not change.** Existing extensions, the loop's tool-call invocation, and the TUI and desktop experience stay exactly as they are. The only exception is the Bun steer for Node processes that open session state, described under Hosts.
- **Recovery on one machine equals today.** On the fused path and on split-local (one machine), crash recovery is today's: an interrupted call gets today's placeholder result, the tool is not re-run, and a pending question resumes as it does now. New outcomes (`uncertain`, `hand_restarted`, aborted siblings) apply only to cross-machine and hosted executors.
- **Replay during preparation is today's replay** on every placement; extensions get no new preparation capability.
- **Many sessions on one hand or one ToolHost** keep per-session records, wakes, order and recovery independent.
- **Approvals** can still come from any RPC-authorized party, as today.
- **Hosted hooks** that run on both sides run on the connected user machine.
- **Dead code** made dead by a change is removed in that change.

## Open questions (not decided here)

- **Credential custody for hosted loops.** How a hosted loop obtains model credentials is an open product decision. This ADR does not choose an option, and no change in this track may build toward one before it is decided. Until then, user-owned loops keep today's local credentials.
- **Worker cap.** Raising the worker cap is a separate, measured engineering item.

## Consequences

- New code lives under `packages/agent/src/{durable,transport,execution,conformance}` and `packages/session-backends/sqlite-bun`; the loop core imports only the four contracts, and a boundary test enforces it.
- The existing session-backend conformance stays; the durable suite is additive and has one registry.
- Upstream durable changes are tracked by reading, not by version bumps; contract-level fixes are ported with tests.
