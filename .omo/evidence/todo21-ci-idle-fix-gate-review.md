# TODO21 CI idle fix gate review

recommendation: APPROVE

## originalIntent

Verify the already-created PR #141 CI idle-test fix in the task-owned worktree without editing product or test code. The CI failure was:

- `packages/coding-agent/test/mcp/idle.test.ts > MCP idle lifecycle > keep-alive pings every 30 seconds and recovers a killed fixture without suspension`
- failure: `condition timed out` at `test/mcp/idle.test.ts:177`, inside `waitFor` at line `204` in the CI log.

## desiredOutcome

The keep-alive recovery test should remain behaviorally strict while being stable on slower Linux CI process replacement:

- after advancing the 30-second keep-alive timer, the test waits for a replacement PID rather than a stale or missing pid file;
- the replacement connection is actually `connected`;
- `connection.getRootPid()` matches the replacement pid;
- `mcp_fx_tool_1` is registered before executing it;
- the test still asserts ping count, recovered tool output, no suspension, and connected snapshot state;
- evidence is sufficient to commit the single-file test stabilization.

## userOutcomeReview

The current diff satisfies the user-visible CI outcome. It does not remove or weaken the recovery behavior; it narrows the readiness condition by requiring a new finite pid, connected state, root-pid alignment, and tool registration before the final tool call. The longer wait changes CI tolerance, not the behavior being asserted.

This reviewer role is read-only, so I did not stage or commit. If this approval is consumed by an executor, the only tracked files that should be staged are:

- `packages/coding-agent/test/mcp/idle.test.ts`
- this report, if the executor wants the tracked review artifact included: `.omo/evidence/todo21-ci-idle-fix-gate-review.md`

## blockers

None.

## changedFiles

- `packages/coding-agent/test/mcp/idle.test.ts`

## diffReview

- The original direct predicate `readNumberFile(pidFile) !== firstPid && pi.toolDefinitions.has("mcp_fx_tool_1")` could throw while the pid file was transiently absent and could pass while the connection had not finished aligning to the replacement process.
- The new wait predicate uses `readOptionalNumberFile(pidFile)` and requires `currentPid !== null`, `currentPid !== firstPid`, `connection?.state === "connected"`, `connection.getRootPid() === currentPid`, and registered tool presence.
- The helper is test-local, has no production surface, and normalizes only transient pid-file read/parse states to `null` so the bounded wait can continue. The final assertions still fail if replacement never completes.

## removeAiSlopsAndProgrammingReview

Skills loaded and applied:

- `/Users/yeongyu/.agents/skills/remove-ai-slops/SKILL.md`
- `/Users/yeongyu/.agents/skills/programming/SKILL.md`
- `/Users/yeongyu/.agents/skills/programming/references/typescript/README.md`
- `.agents/skills/senpi-qa/SKILL.md`

Direct slop/overfit pass:

- Excessive/useless tests: PASS. No new test case was added; the existing regression still maps to the CI-failing keep-alive recovery behavior.
- Deletion-only/removal-only tests: PASS. No test deletion or removal-only assertion.
- Tautological tests: PASS. The test observes fixture process recovery, ping counter, model-facing tool output, state transitions, and service snapshot, not implementation-only truthiness.
- Implementation-mirroring tests: PASS. The predicate waits for externally observable readiness from the service/test fixture boundary; the final assertions exercise the real registered fixture tool.
- Unnecessary production extraction/parsing/normalization: PASS. No production code changed. The only normalization is a test-local optional pid-file read needed for transient file absence during process replacement.
- Needless abstraction: PASS. `readOptionalNumberFile` is a small test-local semantic companion to existing `readNumberFile`; it keeps the wait predicate readable and has no exported surface.
- TypeScript hygiene: PASS. Direct no-excuse checker reports `No violations in 1 file(s).`
- File size: PASS. `idle.test.ts` is 190 pure LOC, below the 250 LOC ceiling.
- Scope drift: PASS. Current tracked diff is limited to `packages/coding-agent/test/mcp/idle.test.ts`.

## verificationCommands

- `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/idle.test.ts --testNamePattern "keep-alive pings"` -> PASS, 1 test passed, exit 0. Artifact: `local-ignore/qa-evidence/20260707-mcp-w2-ci-idle-fix/gate-focused-keepalive.txt`.
- `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/idle.test.ts test/mcp/catalog-cache.test.ts test/mcp/startup-race.test.ts test/mcp/ping-on-call.test.ts test/mcp/service-lifecycle.test.ts` -> PASS, 5 files / 31 tests passed, exit 0. Artifact: `local-ignore/qa-evidence/20260707-mcp-w2-ci-idle-fix/gate-impacted-mcp.txt`.
- `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test` -> PASS, 5/5, only localhost fake providers, real auth unchanged, exit 0. Artifact: `local-ignore/qa-evidence/20260707-mcp-w2-ci-idle-fix/gate-mock-loop-self-test.txt`.
- `NODE_PATH="$PWD/node_modules" npx tsx /Users/yeongyu/.agents/skills/programming/scripts/typescript/check-no-excuse-rules.ts packages/coding-agent/test/mcp/idle.test.ts` -> PASS, no violations, exit 0. Artifact: `local-ignore/qa-evidence/20260707-mcp-w2-ci-idle-fix/gate-no-excuse-idle-test.txt`.

Inherited evidence checked:

- `local-ignore/qa-evidence/20260707-mcp-w2-ci-idle-fix/ci-job-85511919171-red.txt`: confirms the PR #141 CI red failure at `idle.test.ts` keep-alive recovery with `condition timed out`.
- `local-ignore/qa-evidence/20260707-mcp-w2-ci-idle-fix/focused-before-loop-20.txt`: pre-fix local 20x characterization did not reproduce locally.
- `local-ignore/qa-evidence/20260707-mcp-w2-ci-idle-fix/focused-after.txt`: prior focused pass.
- `local-ignore/qa-evidence/20260707-mcp-w2-ci-idle-fix/idle-file-after.txt`: full `idle.test.ts` pass, 7 tests.
- `local-ignore/qa-evidence/20260707-mcp-w2-ci-idle-fix/impacted-mcp-after.txt`: impacted MCP pass, 5 files / 31 tests.
- `local-ignore/qa-evidence/20260707-mcp-w2-ci-idle-fix/npm-run-check.txt`: root `npm run check` pass.
- `local-ignore/qa-evidence/20260707-mcp-w2-ci-idle-fix/npm-test.txt`: later root `npm test` artifact contains passing workspace summaries; earlier retry artifacts show the idle failure this diff is intended to address.

## cleanupAndAuthNotes

- `senpi-qa` mock-loop self-test reported real auth unchanged at `/Users/yeongyu/.senpi/agent/auth.json`.
- The verification reruns wrote only ignored artifacts under `local-ignore/qa-evidence/20260707-mcp-w2-ci-idle-fix/`.
- No product or test code was edited by this reviewer.
- No staging or commit was performed from this read-only review role.

## checkedArtifactPaths

- `packages/coding-agent/test/mcp/idle.test.ts`
- `local-ignore/qa-evidence/20260707-mcp-w2-ci-idle-fix/ci-job-85511919171-red.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-ci-idle-fix/focused-before-loop-20.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-ci-idle-fix/focused-after.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-ci-idle-fix/idle-file-after.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-ci-idle-fix/impacted-mcp-after.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-ci-idle-fix/npm-run-check.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-ci-idle-fix/npm-test.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-ci-idle-fix/gate-focused-keepalive.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-ci-idle-fix/gate-impacted-mcp.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-ci-idle-fix/gate-mock-loop-self-test.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-ci-idle-fix/gate-no-excuse-idle-test.txt`
- `.omo/evidence/todo-21-code-quality-slop-review.md`
- `.omo/evidence/todo21-senpi-mcp-plugin-final-rereview.md`
- `/Users/yeongyu/.agents/skills/remove-ai-slops/SKILL.md`
- `/Users/yeongyu/.agents/skills/programming/SKILL.md`
- `/Users/yeongyu/.agents/skills/programming/references/typescript/README.md`
- `.agents/skills/senpi-qa/SKILL.md`

## exactEvidenceGaps

No unresolved evidence gaps for the current CI idle-test fix. Codegraph could not be used because this task worktree has no `.codegraph/` index; direct file, diff, test, and artifact inspection were used instead.

## residualRisk

Low. The original failure was observed only on Linux CI and did not reproduce in a 20x local characterization, so local verification cannot prove the exact runner timing. The diff specifically targets that timing class by waiting for replacement connection readiness and registered tool availability, and the focused/impacted suites pass on the current worktree.
