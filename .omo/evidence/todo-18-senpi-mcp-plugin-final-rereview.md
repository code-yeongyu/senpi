# TODO18 Senpi MCP Plugin Final Rereview

recommendation: APPROVE

AdversarialVerify: confirmed

## originalIntent

TODO18 intended to complete MCP idle shutdown and keep-alive lifecycle behavior:

- default `idleTimeoutMin` remains 10 minutes;
- connected zero-in-flight MCP servers shut down after the configured idle window while preserving cache;
- post-idle direct MCP tool calls reconnect transparently and return the real MCP result;
- tool calls and renewal/ensure-connect critical sections prevent idle shutdown while work is in flight;
- `lifecycle: "keep-alive"` uses an unref'd 30s safe interval and recovers after a single killed server;
- the single-kill keep-alive path does not emit the pre-TODO17 `suspended`/breaker state;
- eager servers still connect on session start and can idle afterward.

The prior rereview blocker was not product code. It was that `.omo/evidence/todo-18-code-quality-slop-review.md` lacked explicit `remove-ai-slops` / `programming` perspective coverage and per-criterion overfit/slop checks.

## desiredOutcome

The user should be able to mark TODO18 complete only if the product diff, focused and impacted tests, `npm run check`, TypeScript/LOC audit, manual QA bundle, and updated slop evidence all independently support completion.

## userOutcomeReview

Confirmed. Commit `0071790b0a340b58069a04e561899f0ff1856c17` updates only `.omo/evidence/todo-18-code-quality-slop-review.md` and closes the prior evidence blocker by explicitly adding:

- `remove-ai-slops` perspective coverage;
- `programming` / TypeScript perspective coverage;
- per-criterion slop/overfit checks for excessive/useless tests, deletion-only tests, tautological tests, implementation-mirroring/mock-only tests, unnecessary production extraction/abstraction, unnecessary parsing/normalization, TS escape hatches, timer safety, and secret/log safety.

The underlying TODO18 product behavior remains supported:

- `packages/coding-agent/src/core/extensions/builtin/mcp/config.ts` normalizes `idleTimeoutMin` to 10 by default.
- `packages/coding-agent/src/core/extensions/builtin/mcp/idle.ts` owns lifecycle timers in a `WeakMap`, uses `safeTimer` / `safeInterval`, increments `inFlight` around lifecycle-protected calls, pauses idle timers during work, and renews keep-alive connections after ping failure.
- `packages/coding-agent/src/core/extensions/builtin/mcp/wrap.ts` unrefs both timer helpers.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts` configures lifecycle for each connection and disposes timers/listeners before connection disposal.
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts` wraps `ensureMcpToolCallConnection`, cached reconnect, and `client.callTool` in `runMcpConnectionLifecycleCall`.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-snapshot.ts` prevents generated post-idle connections from being mislabeled as stale `cached`.

TODO18 can be marked complete.

## blockers

None.

Accepted worktree state note: before writing this final rereview report, `git status --short --branch` showed no staged changes and only unrelated untracked TODO14/TODO16 stop-hook evidence plus the prior untracked TODO18 gate report. This final report is now a new untracked evidence artifact and may need committing later.

## checkedArtifactPaths

- `.omo/evidence/todo-18-code-quality-slop-review.md`
- `.omo/evidence/todo-18-senpi-mcp-plugin-gate-review.md`
- `.omo/evidence/stop-hook-todo-18-slop-evidence-verification.md`
- `.omo/evidence/task-18-senpi-mcp-plugin-red.log`
- `.omo/evidence/task-18-senpi-mcp-plugin-final.log`
- `.omo/evidence/task-18-senpi-mcp-plugin-impacted-final.log`
- `.omo/evidence/task-18-senpi-mcp-plugin-check-final.log`
- `.omo/evidence/task-18-senpi-mcp-plugin-ts-audit-final.log`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo18/INDEX.md`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo18/auth-isolation.md`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo18/cleanup-receipt.md`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo18/checks.jsonl`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo18/happy-fake-model-requests.json`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo18/failure-fake-model-requests.json`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo18/failure-mcp-logs.txt`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo18/command-transcript.log`
- `packages/coding-agent/src/core/extensions/builtin/mcp/config.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/connection.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/health.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/idle.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/wrap.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-snapshot.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts`
- `packages/coding-agent/test/mcp/idle.test.ts`
- `/Users/yeongyu/.agents/skills/remove-ai-slops/SKILL.md`
- `/Users/yeongyu/.agents/skills/programming/SKILL.md`
- `/Users/yeongyu/.agents/skills/programming/references/typescript/README.md`
- `/Users/yeongyu/.agents/skills/programming/references/code-smells.md`

## functionalEvidence

- Focused TODO18 tests: `.omo/evidence/task-18-senpi-mcp-plugin-final.log` shows 1 file passed, 7/7 tests passed, `EXIT_CODE=0`.
- Impacted MCP tests: `.omo/evidence/task-18-senpi-mcp-plugin-impacted-final.log` shows 5 files passed, 33/33 tests passed, `EXIT_CODE=0`.
- Root check: `.omo/evidence/task-18-senpi-mcp-plugin-check-final.log` shows `npm run check` passed with `EXIT_CODE=0`.
- TypeScript audit / LOC: `.omo/evidence/task-18-senpi-mcp-plugin-ts-audit-final.log` shows `NO_FORBIDDEN_MATCHES`, `EXIT_CODE=0`, and every changed TS file under 250 pure LOC.
- Manual QA: `local-ignore/qa-evidence/20260706-mcp-w2-todo18/INDEX.md` reports `Result: PASS`, `Checks: 14/14`.
- Auth isolation: `auth-isolation.md` shows the real `/Users/yeongyu/.senpi/agent/auth.json` SHA-256 unchanged before/after.
- Cleanup: `cleanup-receipt.md` reports happy and failure sandboxes removed, cleanup complete.
- Fake-model request artifacts prove the real MCP tool result reached the model after idle reconnect and after keep-alive recovery.

## directSlopAndProgrammingPass

Loaded and applied `remove-ai-slops`, `programming`, the TypeScript reference, and the code-smells reference before approval.

- Excessive/useless tests: PASS. The seven focused tests map to TODO18 acceptance classes and assert external process/state/tool-result behavior.
- Deletion-only tests: PASS. No test merely asserts code removal; tests assert runtime state, process death/new PID, real fixture tool output, and absence of pre-TODO17 `suspended`.
- Tests that merely verify requested removal: PASS. No requested-removal-only tests found.
- Tautological tests: PASS. The tests drive real stdio fixture processes and actual tool execution rather than constants or internal booleans.
- Implementation-mirroring tests: PASS. Debug timer snapshots are limited to unref evidence; the behavioral pass is observable through snapshots, PIDs, process death, reconnect, ping count, and tool results.
- Unnecessary production extraction/abstraction: PASS. `idle.ts` is a cohesive lifecycle owner used by setup, disposal, keep-alive, and tool execution, not a speculative public abstraction.
- Unnecessary parsing/normalization: PASS. TODO18 does not add a parser or normalization layer; existing `isRecord(params)` remains the boundary for tool-call params.
- TypeScript slop: PASS. Independent `rg` over the changed TS files found no `any`, suppressions, dynamic imports, non-erasable syntax, `as any`, `as unknown`, empty catches, or `console.log`.
- Size discipline: PASS. Independent pure LOC check reported `register.ts` 177, `service-snapshot.ts` 26, `service.ts` 236, `idle.ts` 138, `idle.test.ts` 168.
- Whitespace/diff hygiene: PASS. `git diff --check ec6c376c5^ ec6c376c5 -- ...changed files...` produced no output.

## adversarialClasses

- stale_state: PASS. `0071790b0` is HEAD on `code-yeongyu/senpi-mcp-plugin-w2`; it changes only the slop evidence report. The committed slop report has no post-commit diff.
- dirty_worktree: PASS. No staged files. Untracked TODO14/TODO16 stop-hook files and the prior TODO18 gate report are unrelated and not required for confirmation. This report is intentionally newly written and untracked.
- missing_artifact: PASS. All referenced final TODO18 evidence artifacts exist and were read.
- misleading_success_output: PASS. Saved test/check claims were cross-checked against logs, manual QA artifacts, source code, and direct local static audits.
- stale_manual_QA: PASS with note. `checks.jsonl` contains earlier appended entries plus the final complete run; final `INDEX.md`, auth isolation, cleanup receipt, command transcript, and fake-model request artifacts corroborate the complete 14/14 PASS run.
- product_code_blocker: PASS. Direct code review found no unresolved blocker in timer setup, disposal, in-flight protection, keep-alive recovery, cache-preserving reconnect, or snapshot classification.
- secret_leakage: PASS. Manual QA evidence redacts mock auth, uses isolated agent/session dirs, and proves real auth unchanged.
- flaky_tests: PASS based on saved final focused 7/7, impacted 33/33, and code review. Timing-sensitive tests are bounded and exercise the timing behavior under test.

## exactEvidenceGaps

None. The prior gap in `.omo/evidence/todo-18-code-quality-slop-review.md` is closed by commit `0071790b0a340b58069a04e561899f0ff1856c17`.

## finalVerdict

AdversarialVerify: { verdict: "confirmed" }

TODO18 can be marked complete.
