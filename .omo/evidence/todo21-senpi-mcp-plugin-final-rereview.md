# TODO21 senpi MCP plugin final rereview

recommendation: APPROVE

## originalIntent

TODO21 is the W2 chaos e2e QA gate for PR#3. The user needed independent confirmation that the W2 resilience work can move forward only if the real source-built senpi harness, in a sandbox HOME, proves the ten chaos scenarios, records the required artifacts and INDEX verdicts, passes full root `npm test` plus `npm run check`, cleans up processes/ports/auth state, and clears the prior code-quality blockers under the `remove-ai-slops` and `programming` criteria.

## desiredOutcome

The orchestrator should be able to mark TODO21 complete if:
- `.omo/plans/senpi-mcp-plugin.md` TODO21 has all 10 evidence slots with PASS verdicts.
- The 30-minute keep-alive soak shows at least 10 induced failures, no senpi process death, and RSS delta under 20 MB.
- The prior reject blockers are fixed: TODO21 slop/code-quality report exists with explicit coverage, no non-null assertion remains in the MCP-prefixed allowlist regression, and `connection.ts` is <=250 pure LOC through a real split.
- Final full root `npm test` and `npm run check` pass on the final stabilization diff.
- Cleanup evidence shows no task-owned processes/listeners/tmux sessions/ports and real auth unchanged.

## userOutcomeReview

The shipped artifacts support the user-visible outcome. TODO21 can be marked complete.

The original all-ten chaos rerun in `local-ignore/qa-evidence/20260707-mcp-w2-todo21-final-rerun-20260707073541/INDEX.md` records PASS for steps 1-10. Its soak summary reports `durationMs=1800202`, `inducedFailures=11`, `pidContinuity=true`, `senpiExitCode=null`, and `deltaKb=-16`.

After the production quality split in `b47a98fe8`, `local-ignore/qa-evidence/20260707-mcp-w2-todo21-quality-fix/chaos-current-diff/INDEX.md` revalidated chaos steps 1-9 and the 30-minute soak on the changed runtime code. That run still had a step 10 full-suite failure, which is then closed by the final stabilization evidence under `local-ignore/qa-evidence/20260707-mcp-w2-todo21-full-test-green/`.

Commit `e73a9b091` is scoped to MCP test stabilization and TODO21 evidence summaries only: `catalog-cache.test.ts`, `service-lifecycle.ts`, `idle.test.ts`, `startup-race.test.ts`, and the two TODO21 evidence markdown files. No app-server or footer source/test files are modified in that commit.

## blockers

None.

## priorRejectBlockers

- Slop/code-quality report: fixed. `.omo/evidence/todo-21-code-quality-slop-review.md` explicitly covers `remove-ai-slops`, `programming`, overfit/tautological/implementation-mirroring/deletion-only tests, unnecessary extraction, scope drift, secret safety, dirty worktree scope, and oversized module handling.
- Non-null assertion: fixed. `packages/coding-agent/test/suite/regressions/mcp-prefixed-extension-tool-allowlist.test.ts:55-58` now narrows `model === undefined` and throws a setup error; direct search found no postfix non-null assertion.
- `connection.ts` size: fixed by real type-contract split into `connection-types.ts`; direct pure LOC measured `connection.ts` at 245 and `connection-types.ts` at 31. No `SIZE_OK` escape is present.

## directReview

Skills consulted before approval:
- `/Users/yeongyu/.agents/skills/remove-ai-slops/SKILL.md`
- `/Users/yeongyu/.agents/skills/programming/SKILL.md`
- `/Users/yeongyu/.agents/skills/programming/references/typescript/README.md`
- `/Users/yeongyu/.agents/skills/programming/references/code-smells.md`

Read-only commands I reran:
- `NODE_PATH="$PWD/node_modules" npx tsx /Users/yeongyu/.agents/skills/programming/scripts/typescript/check-no-excuse-rules.ts ...` -> `No violations in 10 file(s).`
- Pure LOC loop over touched TS files -> `connection.ts 245`, `connection-types.ts 31`, regression test 71, final e73 touched test files all <=250.
- `git show --name-status e73a9b091` -> only TODO21 evidence and MCP test files.
- Current cleanup probe -> no task-owned MCP fixture/model processes, no worktree daemon listener, no matching QA tmux sessions, ports `18999`, `52758`, `52885`, `52887` free.

## finalTestEvidence

- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-full-test-green/root-npm-test-final.txt`: root `npm test` exit 0. Workspace summaries include agent 16/16 files passed, ai 93 passed/25 skipped, coding-agent 357 passed/4 skipped, orchestrator fail 0, tui fail 0, final `EXIT_CODE=0`. The `npm error nonexistent-package` lines are expected negative-path test output inside the passing coding-agent suite, not command failure.
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-full-test-green/npm-run-check.txt`: `npm run check` exit 0.
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-full-test-green/focused-mcp-tests.txt`: 3 MCP files / 19 tests passed.
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-full-test-green/app-server-daemon-rerun.txt`: 1 daemon test file / 4 tests passed after stopping the task-owned stale listener.
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-full-test-green/no-excuse-gate-command.txt`: no violations.
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-full-test-green/senpi-qa-mock-loop-self-test.txt`: 5/5 PASS, localhost fake providers only, real auth unchanged.

The final test artifacts were written at 2026-07-07 09:32 KST, immediately before commit `e73a9b091` at 09:33 KST; they clearly verify the diff that became that commit.

## cleanupEvidence

- Final chaos cleanup: `local-ignore/qa-evidence/20260707-mcp-w2-todo21-final-rerun-20260707073541/cleanup-receipt.txt` reports `authUnchanged=true`, `processSweep=none`, ports free, sandbox cleanup invoked.
- Final full-suite cleanup: `local-ignore/qa-evidence/20260707-mcp-w2-todo21-full-test-green/cleanup-receipt.txt` reports no worktree daemon listener, no QA tmux sessions, all listed ports free, and senpi-qa auth unchanged. Its process section self-matches the shell command that generated the receipt because the command line contains the mock-loop evidence filename; my independent current process probe found no actual task-owned fixture/model process.

## adversarialClassResults

- `stale_state`: PASS. Steps 4, 5, 7, and 9 prove cache startup, idle revival, HTTP session reinit, and repeated keep-alive renewals.
- `dirty_worktree`: PASS. Pre/post/current git status shows only unrelated untracked stop-hook/evidence files plus this review output; no tracked dirty product/test files.
- `misleading_success_output`: PASS. The chaos evidence uses payload transcripts, status/proxy logs, spill chunk reads, RSS samples, and PID continuity, not counters alone.
- `flaky_tests/hung_or_long_commands`: PASS. Step 2 proves bounded timeout/responsiveness under SIGSTOP; step 9 records bounded 30-minute progress; final full root `npm test` and `npm run check` exit 0 after e73 stabilization.
- `cancel_resume`: N/A for TODO21. The chaos script records it as not executed because TODO21 has no abort/resume acceptance criterion.

## checkedArtifactPaths

- `.omo/plans/senpi-mcp-plugin.md`
- `.omo/start-work/senpi-mcp-plugin-notepad.md`
- `.omo/start-work/ledger.jsonl`
- `.omo/evidence/todo21-senpi-mcp-plugin-final-gate-review.md`
- `.omo/evidence/task-21-senpi-mcp-plugin-final-rerun.log`
- `.omo/evidence/todo-21-code-quality-slop-review.md`
- `.omo/evidence/todo-21-quality-fix-verification-summary.md`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-final-rerun-20260707073541/INDEX.md`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-final-rerun-20260707073541/09-soak-30min-keepalive/summary.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-final-rerun-20260707073541/09-soak-30min-keepalive/kill-schedule.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-final-rerun-20260707073541/09-soak-30min-keepalive/rss-intervals.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-final-rerun-20260707073541/10-npm-test-full-output.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-final-rerun-20260707073541/10-npm-run-check-full-output.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-final-rerun-20260707073541/cleanup-receipt.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-final-rerun-20260707073541/secret-scan.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-quality-fix/chaos-current-diff/INDEX.md`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-quality-fix/final-no-excuse-gate-command.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-quality-fix/final-pure-loc-scope.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-quality-fix/final-regression-test.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-quality-fix/final-impacted-mcp-tests.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-full-test-green/root-npm-test-final.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-full-test-green/npm-run-check.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-full-test-green/focused-mcp-tests.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-full-test-green/app-server-daemon-rerun.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-full-test-green/no-excuse-gate-command.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-full-test-green/pure-loc-touched-ts.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-full-test-green/senpi-qa-mock-loop-self-test.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo21-full-test-green/cleanup-receipt.txt`
- `packages/coding-agent/src/core/extensions/builtin/mcp/connection.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/connection-types.ts`
- `packages/coding-agent/test/suite/regressions/mcp-prefixed-extension-tool-allowlist.test.ts`
- Commits `b47a98fe8`, `e73a9b091`, and relevant prior W2 commits `711bfd045`, `00a14af5c`, `c9997dd15`, `a470f2c71`, `867be95a0`

## exactEvidenceGaps

No unresolved evidence gaps against TODO21 acceptance. I searched for a separate `@modelcontextprotocol/server-everything` version record and found no distinct match in the TODO21 chaos artifacts; I did not treat that as blocking because TODO21's acceptance criteria define the ten controlled chaos artifact slots, all of which require the in-repo fixture knobs and all of which are present with PASS verdicts in the final evidence set.

## conclusion

The diff, tests, manual QA artifacts, cleanup receipts, and direct slop/programming review support completion. The orchestrator may mark TODO21 complete.
