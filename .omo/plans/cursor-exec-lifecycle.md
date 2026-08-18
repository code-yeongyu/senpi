# Cursor exec lifecycle parity

## Objective

Make Senpi's Cursor provider match the current real `cursor-agent`
exec-channel lifecycle so server-requested tools cannot leave a turn pending:
normal typed exec completions emit exactly one `streamClose`, and a pending
recognized exec emits write-completion-chained heartbeat control frames every
3,000 ms.

## Diagnosis

- Direct real-client capture:
  `local-ignore/qa-evidence/20260817-cursor-protocol/lab/frames-real.jsonl`
  shows `readResult{id:1}` followed by
  `execClientControlMessage.streamClose{id:1}`.
- The equivalent Senpi capture:
  `local-ignore/qa-evidence/20260817-cursor-protocol/lab/frames-senpi.jsonl`
  sends `readResult` and never closes the exec lifecycle.
- The extracted Cursor CLI bundle schedules
  `ExecClientControlMessage.heartbeat{id}` after 3,000 ms, rescheduling only
  after the prior write completes, and clears the timer when the exec exits.
- Senpi sends only the run-level 5-second `ClientHeartbeat`; it has no
  exec-scoped heartbeat.
- `packages/ai/src/api/cursor-agent.ts` emits `streamClose` only after
  `shellStream` completion and `ExecClientThrow`.
- The omission originated in commit `00ce615ce` and remains in current
  `oh-my-pi`; the extracted real binary, not upstream source, is the
  authoritative compatibility target.

## Tier and topology

Tier: **HEAVY** because this changes concurrent provider transport lifecycle
and external protocol compatibility, and the user requires rigorous review,
real-surface QA, PR delivery, and merge.

Topology:

- One implementation worktree and one PR. The source and test changes share the
  same protocol contract and should not be split into parallel PRs.
- Read-only exploration was parallelized across test-seam, protocol-contract,
  and history lanes.
- Implementation remains with the lead because the production and test edits
  overlap the same h2 lifecycle.
- A dedicated QA worker may own the permanent Senpi QA scenario after the core
  transport contract is green; its write scope is disjoint from
  `packages/ai/`.

## Success criteria

### C1. Normal typed exec results close exactly once

Scenario:

```sh
npx vitest run packages/ai/test/cursor-agent.test.ts \
  -t "closes the exec stream after a successful readResult"
```

PASS:

- The server receives one `readResult{id:7}`.
- The next terminal control for that exec is exactly one
  `streamClose{id:7}`.
- `id` is the numeric `ExecServerMessage.id`, not `execId` or a tool-call ID.

RED:

- Current source times out waiting for `streamClose`.

Evidence:

`local-ignore/qa-evidence/<date>-cursor-exec-lifecycle/red-green-stream-close.txt`

### C2. Typed rejection/error results also close

Scenario:

```sh
npx vitest run packages/ai/test/cursor-agent.test.ts \
  -t "closes the exec stream after a typed read rejection"
```

PASS:

- A missing read handler returns typed `readResult.rejected`.
- The same numeric exec ID receives exactly one following `streamClose`.

RED:

- Current source returns the typed result but never closes the exec.

Evidence:

`local-ignore/qa-evidence/<date>-cursor-exec-lifecycle/red-green-rejection-close.txt`

### C3. Pending recognized execs emit isolated 3-second heartbeats

Scenario:

```sh
npx vitest run packages/ai/test/cursor-agent.test.ts \
  -t "heartbeats a pending exec and stops after completion"
```

PASS:

- A controllable pending read handler emits no immediate heartbeat.
- At 3,000 ms, the server receives
  `execClientControlMessage.heartbeat{id:7}`.
- A second heartbeat is scheduled only after the first write completes.
- Releasing the handler emits its typed result and one `streamClose`.
- No exec heartbeat is emitted after terminal cleanup.
- The run-level 5-second `ClientHeartbeat` remains a separate message family.

RED:

- Current source emits zero exec-scoped heartbeat frames.

Evidence:

`local-ignore/qa-evidence/<date>-cursor-exec-lifecycle/red-green-exec-heartbeat.txt`

### C4. Real Senpi surface completes only after lifecycle closure

Scenario:

```sh
node .agents/skills/senpi-qa/scripts/scenarios/cursor-exec-lifecycle-qa.mjs \
  --evidence cursor-exec-lifecycle
```

The hermetic scenario must:

1. Boot the real source CLI/RPC surface with an isolated Cursor model and fake
   local h2 Connect server.
2. Send a normal read exec and withhold `turnEnded` until the client sends
   result then `streamClose`.
3. Send a long-running shell exec gated by an event/FIFO, observe an
   exec-scoped heartbeat before releasing the tool, then observe terminal
   result and `streamClose`.
4. Confirm the agent turn completes with `stopReason:"stop"`, non-empty text,
   zero real credentials touched, and all ports/processes/temp paths removed.

PASS:

- Both tool scenarios complete on the real CLI surface.
- Frame order and IDs match the real-client contract.
- Evidence contains the invocation, transcript, decoded frame timeline,
  auth-guard receipt, and cleanup receipt.

Evidence:

`local-ignore/qa-evidence/<date>-cursor-exec-lifecycle/`

### C5. Adjacent behavior and repository gates remain green

Commands:

```sh
npm test -w @earendil-works/pi-ai -- --run packages/ai/test/cursor-agent.test.ts
npm test -w @earendil-works/pi-ai
npm run check
npm test
node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test \
  --evidence cursor-exec-lifecycle-regression
node scripts/check-pr-changelog.mjs --base "$(git merge-base HEAD origin/main)"
```

PASS:

- Cursor focused tests pass once.
- AI package tests, root check, and full workspace tests pass, with any
  pre-existing flake isolated and documented.
- The mock loop passes through the real CLI.
- Changelog gate passes.
- LSP diagnostics are clean on changed TypeScript files.

Evidence:

`local-ignore/qa-evidence/<date>-cursor-exec-lifecycle/validation/`

### C6. PR is reviewed, merged, and cleaned up

PASS:

- Reviewer-readable English PR targets `main`.
- Required checks `Check and test` and `Changelog gate` are green.
- `review-work` passes all five lanes.
- Cubic reports no issues, or is explicitly skipped only for quota exhaustion.
- GitHub reports `MERGED` with a merge commit.
- The task worktree is removed and `git worktree prune` has run.

Evidence:

- PR URL and merged state.
- Review artifacts.
- Worktree cleanup receipt.

## Implementation

1. Create a task-owned branch/worktree from fresh `origin/main`.
2. Commit this plan as the initial green, reviewer-readable PR artifact and
   open a draft PR.
3. Register the aggregate goal and ULW-loop state after the PR exists, per the
   repository protocol.
4. Add the three focused RED tests in
   `packages/ai/test/cursor-agent.test.ts`; capture failures before production
   edits.
5. In `packages/ai/src/api/cursor-agent.ts`:
   - import `ExecClientHeartbeatSchema`;
   - add a 3,000 ms exec-heartbeat cadence constant;
   - arm a per-exec write-completion-chained heartbeat only after a recognized
     exec family is selected;
   - clear it before terminal cleanup;
   - wrap recognized dispatch in one lifecycle `try/finally`;
   - send exactly one `streamClose` after every normal typed-result sequence;
   - remove the existing shell-stream-only close to avoid duplicates;
   - keep unknown/unset fallback as throw then explicit close;
   - keep `ExecClientThrow` as a throw-only primitive so lifecycle ownership is
     unambiguous.
6. Add/update the permanent Senpi QA scenario and capture real-surface evidence.
7. Update `packages/ai/src/changes.md` with the real-client evidence, protocol
   semantics, and merge-conflict zone.
8. Add the required `packages/ai/CHANGELOG.md` entry after the PR number exists.
9. Commit verified increments atomically:
   - plan / PR initialization;
   - transport fix + focused tests;
   - permanent QA scenario;
   - changelog and fork-change documentation.
10. Run focused and broad validation, review-work, CI, Cubic, merge-commit, and
    worktree cleanup.

## Dependency matrix

| Task | Depends on | Blocks | Parallelizable with |
|---|---|---|---|
| Plan commit + draft PR | exploration | ULW goal registration | none |
| Focused RED tests | draft PR | production fix | QA scenario skeleton read-only work |
| Transport lifecycle fix | RED tests | GREEN tests, QA | none |
| Permanent QA scenario | stable lifecycle contract | manual QA | docs draft |
| Changes/changelog docs | PR number, stable semantics | changelog gate | QA scenario |
| Focused/broad validation | all tracked edits | review/merge | none |
| review-work + CI + Cubic | validation | merge | independent review lanes |
| Merge + cleanup | all gates | final delivery | none |

Critical path:

`plan → worktree → draft PR → goal/ULW → RED → fix → GREEN → real QA → broad validation → reviews/checks → merge → cleanup`

## Scope bounds

- In scope: Cursor exec control lifecycle, focused tests, permanent QA,
  required docs/changelog, PR/merge/cleanup.
- Out of scope: refactoring the pre-existing 4,143-line provider module,
  adding HTTP/1 fallback/GetServerConfig negotiation, compression parity,
  tracing headers, blob encryption, or changing tool semantics.
- No protobuf regeneration is needed; the heartbeat and stream-close schemas
  already exist.

## Stop condition

Stop immediately when GitHub reports the PR `MERGED`, every criterion above is
proven on the merged tree with captured evidence, and the task worktree is
absent.
