# test/qa/app-server

Real-surface app-server QA drivers. 47 files + `differential/`. Score 14 — distinct domain: these are **standalone executable scenarios**, not Vitest suites, and they are excluded from the default correctness gate.

## STRUCTURE

```text
task<N>-<behavior>.ts      standalone scenario programs, exit via process.exit
task8-thread-search-support.test.ts   the one Vitest wrapper in this tree
differential/*.mjs         Node ESM scenarios driven by scripts/qa-app-server/differential/
differential/expected-gaps.json, capability-manifest.json   pinned expectations
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Stdio client + server spawn | `task8-thread-search-support.ts` — `StdioClient`, `spawnServer`, `initialize`, `writeSession`, `WireRecord` |
| Fuzzy QA client / port handling | `task23-fuzzy-client.ts` — `FuzzyQaClient`, `findQaPort`, `startSourceServer`, `waitForReady`, `assertPortReusable` |
| Diff/notify client | `task24-diff-client.ts` (`Task24Client`), `task24-diff-model.ts`, `task24-diff-notify.ts` |
| Compaction QA | `task11-compact.ts`, `task11-compact-support.ts`, `task11-zero-subscriber.ts` |
| Differential scenario helpers | `differential/scenario.mjs` — `runAgainstEndpoints`, `startThread`, `startTurn`, `waitForNotification`, `requestResult`, `assertErrorCode`, `ScenarioError` |
| Wire projections | `differential/projection.mjs` — `projectLifecycle`, `projectTurnLifecycle`, `projectSearch`, `projectApprovals`, `projectCompaction`, `resequence` |
| Largest scenarios | `task9-unarchive.ts` (430 LOC), `task12b-remote-control.ts` (415) |

## CONVENTIONS

- Scenario files are named `task<N>-<behavior>.ts` with colocated `*-support.ts` / `*-client.ts` modules; they are run directly, not discovered by Vitest.
- Child app-servers launch through the repo-local `node_modules/tsx/dist/cli.mjs` with explicit env overrides: `PI_OFFLINE`, `PI_TELEMETRY`, `SENPI_CODING_AGENT_DIR`, `SENPI_CODING_AGENT_SESSION_DIR`, `SENPI_TASK8_EXPERIMENTAL`.
- Wire traffic is asserted as JSON-RPC/NDJSON over stdio, Unix socket, and WebSocket. Helpers expose typed wire records and client classes rather than generic fixtures.
- Temp state is always `mkdtemp` under `tmpdir()`; persisted session/model fixtures are written into it.
- Localhost port allocation and readiness are encapsulated (`findQaPort`, `canBind`, `waitForReady`, `assertPortReusable`) — do not hardcode ports in a new task.

## ANTI-PATTERNS

- `differential/projection.mjs`: the projection **never reorders frames or collapses duplicate notifications**. Any normalization that changes wire ordering or dedupes notifications is a defect, not a cleanup.
- `blocked` is readable via `thread/goal/get` and agent-settable only via `update_goal`; `thread/goal/set` deliberately rejects `blocked`, `usageLimited`, and `budgetLimited`. They are not interchangeable statuses.
- Two-tier broadcast (task8): a forbidden broadcast must error **and** must not deliver the notification to the other client.
- Process-group cleanup is an invariant in `StdioClient.close` and the source-server helpers — killing only the direct child, or resolving before the group is gone, leaks servers into later tasks.

## COMMANDS

```bash
npx tsx packages/coding-agent/test/qa/app-server/task<N>-<behavior>.ts
npm --prefix packages/coding-agent test -- --run test/qa/app-server/task8-thread-search-support.test.ts
npm run qa:app-server        # packaged handshake / multiclient / approval / real-client probes
```

Differential scenarios run through the repository's differential harness (`scripts/qa-app-server/differential/driver.mjs`), never as individual node invocations.
