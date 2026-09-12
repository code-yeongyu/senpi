# Retry-exhausted queued steering delivery plan

## Goal

Fix Senpi so steering queued during a provider stream-start timeout retry is automatically admitted after the managed retry budget is exhausted, without requiring another user prompt and without changing generic terminal-error or user-abort queue parking.

## Tier

HEAVY: the change touches session-handling, retry ownership, asynchronous continuation scheduling, and queue ordering.

## Grounded findings

- Canonical incident: `01a00fa6-c1fd-7444-9672-3bc916ae7b1e`.
- `packages/agent/src/agent.ts` intentionally parks queues after generic error/abort.
- `packages/coding-agent/src/core/provider-timeout-retry.ts` sets `deferQueuedMessages: true`.
- `packages/coding-agent/src/core/agent-session.ts` owns retries but leaves retained queues ownerless after final retry exhaustion.
- Existing successful-recovery and user-abort coverage lives in `packages/coding-agent/test/suite/regressions/provider-idle-steering.test.ts`.

## Delegation topology

- Read-only session forensics: independent transcript classification.
- Read-only queue root audit: independent control-flow and invariant review.
- Read-only QA audit: independent real-CLI scenario design.
- Lead: mutable branch work, TDD, implementation, validation, commits, PR, merge, and cleanup.

## Ordered implementation

1. Create `fix/retry-exhausted-queued-steering` in a dedicated worktree.
2. Open a draft PR from a plan-only bootstrap commit.
3. Add a failing `provider-idle-steering.test.ts` case for timeout retry exhaustion plus queued steering and no second prompt.
4. Capture focused RED.
5. Add `mock-loop-stream-start-timeout-steering.mjs` using real watchdog timeouts and RPC steer injection.
6. Capture real CLI RED plus cleanup.
7. Implement the smallest retry-owner handoff in `AgentSession`; do not modify generic `Agent` parking.
8. Capture focused GREEN, user-abort edge GREEN, and generic terminal parking GREEN.
9. Update `packages/coding-agent/src/changes.md` and `packages/coding-agent/CHANGELOG.md`.
10. Run LSP diagnostics, focused tests, package build, root check, changelog gate, and final real CLI QA.
11. Commit verified increments, self-review, push, monitor CI, merge with a merge commit.
12. Remove and prune the task worktree.

## Exact success scenarios

### Unit RED/GREEN

```bash
cd packages/coding-agent
npm test -- test/suite/regressions/provider-idle-steering.test.ts
```

PASS when a new test records initial timeout, one timeout retry, and an automatic third provider request containing the queued steer with no second prompt.

### Abort and generic parking regression

```bash
cd packages/coding-agent
npm test -- test/suite/regressions/provider-idle-steering.test.ts
cd ../agent
npm test -- test/agent.test.ts
```

PASS when user-aborted retry steering remains queued and generic error/abort queue parking remains unchanged.

### Real CLI RED/GREEN

```bash
node .agents/skills/senpi-qa/scripts/mock-loop-stream-start-timeout-steering.mjs \
  --evidence-dir local-ignore/qa-evidence/20260817-retry-exhausted-queued-steering/green-cli
```

PASS when two real stream-start timeouts occur, RPC steer is acknowledged during the retry, the third automatic request carries the steer marker, the final marker is emitted once, the session settles idle, and cleanup proves no process, port, sandbox, or auth mutation remains.

## Stop condition

I'll stop right away when GitHub reports the fix PR `MERGED`, every RED→GREEN and real CLI scenario has captured evidence, and the task worktree is removed.
