# TODO17 gate review after retry fix

recommendation: REJECT

originalIntent: Complete TODO17 from `.omo/plans/senpi-mcp-plugin.md`: MCP auto-reconnect on unexpected close with full-jitter backoff, five reconnects within thirty seconds opening a suspended circuit breaker, `/mcp reconnect <server>` resetting the breaker and reconnecting immediately, exactly one retry for retriable failed-to-send calls after reconnect, no auto-retry for in-flight transport death, and safe/unref'd timers.

desiredOutcome: Users should see transient MCP disconnects recover, crash loops stop safely, manual reconnect restore a suspended server, failed sends retried once without duplicate server execution, and in-flight transport death surface a model-visible error. The checkbox should be markable only if the implementation, tests, root check evidence, manual QA bundles, cleanup receipts, and slop/programming review all support the outcome.

userOutcomeReview: Runtime evidence now supports the previously missing failed-send retry behavior: `health.ts` wires `withMcpRetriableFailedSendRetry()`, `expose/register.ts` wraps `client.callTool`, focused/impacted reconnect tests pass, and manual QA shows two SDK send attempts, one injected pre-server failure, two fixture spawns, and one server execution. The full TODO17 checkbox is still not complete because the changed test file violates the required TypeScript/no-excuse and LOC/slop gates, and there is still no TODO17 code-quality/slop review artifact explicitly covering the required remove-ai-slops/programming overfit criteria.

blockers:
- `packages/coding-agent/test/mcp/reconnect.test.ts` is 274 pure LOC after the retry fix. The plan's mandatory guardrail and the loaded `programming`/`remove-ai-slops` criteria treat files over 250 pure LOC as a defect requiring split/refactor or explicit SIZE_OK-style justification. No such justification or split exists.
- The no-excuse TypeScript checker fails on the changed reconnect test: `packages/coding-agent/test/mcp/reconnect.test.ts:275:9 [no-unknown-assertion]` for `getMcpService() as unknown as ...`, and `packages/coding-agent/test/mcp/reconnect.test.ts:303:5 [catch-without-narrowing]`. Tests are not exempt from these TypeScript rules.
- Required report coverage is absent. `find .omo/evidence ...` found no `todo-17-code-quality-slop-review.md`, `todo17-code-quality...`, or equivalent TODO17-specific report. The previous gate artifact `.omo/evidence/todo17-senpi-mcp-plugin-gate-review.md` already called this gap out, and the retry-fix evidence adds only a static audit, not explicit remove-ai-slops/programming coverage for excessive/useless tests, deletion-only tests, tautological tests, implementation-mirroring tests, unnecessary production extraction/parsing/normalization, and TS escape hatches.
- `git diff --check 9d3f6a1a4^..539805884` reports blank-line-at-EOF whitespace in committed evidence logs. This is not the main functional blocker, but it is another artifact-quality issue to clean before approval.

functionalFindings:
- PASS: `packages/coding-agent/src/core/extensions/builtin/mcp/reconnect.ts` schedules reconnect on degraded state with backoff constants `[500,1000,2000,4000,8000]`, full jitter via `baseDelayMs * random`, and `safeTimer()`; `safeTimer()` unrefs timers in `wrap.ts`.
- PASS: circuit breaker logic opens after five attempts in the thirty-second window and marks state `suspended`; tests and QA capture `reconnects=5` and suspended status.
- PASS: `/mcp reconnect <server>` now calls `service.reconnectServer()`, which calls `reconnectMcpNow()` and clears breaker attempt state before reconnecting.
- PASS: retry-fix implementation retries retriable failed-send errors exactly once around `client.callTool`; manual QA `failed-send-retry/summary.json` shows `sendAttempts=2`, `injectedFailures=1`, `spawnCounter=2`, `callCounter=1`.
- PASS: in-flight transport death is still not auto-retried; unit test and manual QA show `ToolExecError` and call counter `1`.
- NOTE: A raw `setTimeout` remains in `startup-race.ts`, but TODO17's own reconnect timers use `safeTimer` and are unref'd. This was not the deciding blocker.

checkedArtifactPaths:
- `.omo/plans/senpi-mcp-plugin.md`
- commit `9d3f6a1a49814c6918f710b2a21aeb493b6cd715`
- commit `5398058849e9c76a37d6c7f11970ba4106bcaf29`
- prior gate `.omo/evidence/todo17-senpi-mcp-plugin-gate-review.md`
- `.omo/evidence/task-17-senpi-mcp-plugin-baseline.log`
- `.omo/evidence/task-17-senpi-mcp-plugin-red.log`
- `.omo/evidence/task-17-senpi-mcp-plugin-green-reconnect.log`
- `.omo/evidence/task-17-senpi-mcp-plugin-green-impacted.log`
- `.omo/evidence/task-17-senpi-mcp-plugin-check.log`
- `.omo/evidence/task-17-senpi-mcp-plugin-static-audit.log`
- `.omo/evidence/task-17-senpi-mcp-plugin.log`
- `.omo/evidence/task-17-retry-fix-red.log`
- `.omo/evidence/task-17-retry-fix-green-reconnect.log`
- `.omo/evidence/task-17-retry-fix-green-impacted.log`
- `.omo/evidence/task-17-retry-fix-check.log`
- `.omo/evidence/task-17-retry-fix-static-audit.log`
- `.omo/evidence/task-17-retry-fix-senpi-mcp-plugin.log`
- `.omo/evidence/task-17-retry-fix-stop-hook-verification.md`
- `.omo/evidence/task-17-retry-fix-stop-hook-verification-2.md`
- `.omo/evidence/task-17-retry-fix-stop-hook-verification-3.md`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17/INDEX.md`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17/cleanup-receipt.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17/scenario1-status-suspended.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17/scenario1-rpc-events.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17/scenario2-rpc-events.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17/scenario2-call-counter.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17-retry-fix/INDEX.md`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17-retry-fix/qa-driver-output.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17-retry-fix/cleanup-receipt.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17-retry-fix/failed-send-retry/summary.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17-retry-fix/failed-send-retry/send-attempts.jsonl`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17-retry-fix/failed-send-retry/inject-first-send-failure.mjs`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17-retry-fix/inflight-no-duplicate/summary.json`
- `packages/coding-agent/src/core/extensions/builtin/mcp/reconnect.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/health.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/commands.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/wrap.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/errors.ts`
- `packages/coding-agent/test/mcp/reconnect.test.ts`

commandsRun:
- `git status --short --branch && git rev-parse HEAD && git log --oneline --decorate -5`
- `rg -n "17\\. Auto-reconnect|Acceptance criteria|retry correctness|safeTimer|circuit breaker" .omo/plans/senpi-mcp-plugin.md`
- `git show --stat --oneline --decorate --find-renames 9d3f6a1a4`
- `git show --stat --oneline --decorate --find-renames 539805884`
- `git show --patch 9d3f6a1a4 -- <TODO17 source files>`
- `git show --patch 539805884 -- <retry-fix source/test files>`
- `sed`/`nl` reads over source, test, evidence, and QA artifact paths listed above
- `rg -n "setTimeout|setInterval|safeTimer|safeInterval|\\.on\\(" packages/coding-agent/src/core/extensions/builtin/mcp -g '*.ts'`
- `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/reconnect.test.ts` (fresh rerun: 8 tests passed)
- `NODE_PATH="$PWD/node_modules" npx tsx /Users/yeongyu/.agents/skills/programming/scripts/typescript/check-no-excuse-rules.ts <13 changed TS files>` (failed with two reconnect.test.ts violations)
- Pure LOC awk over all changed TypeScript files (reconnect.test.ts = 274)
- `find .omo/evidence -maxdepth 1 -type f \( -iname '*review*.md' -o -iname '*slop*.md' -o -iname '*quality*.md' \) -print`
- `git diff --check 9d3f6a1a4^..539805884`

exactEvidenceGaps:
- No TODO17-specific code-quality/slop review artifact explicitly applying remove-ai-slops and programming perspectives after the retry-fix commit.
- No artifact resolves or justifies `reconnect.test.ts` exceeding the 250 pure LOC ceiling.
- No artifact records the no-excuse checker on TODO17 changed TypeScript files; direct checker run fails.

adversarialProbes:
- stale_state: PASS for functional retry. HEAD is `5398058849e9c76a37d6c7f11970ba4106bcaf29`; evidence files are committed at that commit. Reconnect code uses generation checks and manual QA spawnCounter=2 shows renewed connection used for retry.
- dirty_worktree: BLOCKING-RISK but not functional drift. No tracked diffs, but many unrelated untracked `.omo/evidence/*stop-hook*` and prior gate files exist. The required new gate report is this file.
- misleading_success_output: PASS for retry behavior. QA includes send-attempt JSONL, payload, spawn counter, server call counter, and model request artifacts, not just pass counts.
- flaky_tests/timing-sensitive: PARTIAL. Focused reconnect suite passed on fresh rerun; fake timers/RNG are used for jitter. `reconnect.test.ts` still uses polling and `delay(500)`, and it is now oversized.
- malformed_input: PASS within scope. `/mcp reconnect` unknown/missing target handling remains covered by commands tests; retry-fix did not alter command parsing.
- hung/long commands: PASS. Fresh focused test completed in 6.47s; cleanup receipts show fixture pids dead and temp script removed. `npm run check` evidence exists, but it was not rerun because the repo command uses `biome --write`.
- repeated_interruptions: PASS. Original and retry-fix QA cover crash-loop suspension, manual reconnect, failed-send retry, and in-flight crash with no duplicate execution.
- prompt_injection: PASS within scope. Fixture/server error text is model-visible data; no command execution from server text. Model requests use localhost fake provider.
- cancel/resume: N/A for reconnect command cancellation; tool abort semantics were not changed and impacted register-call tests passed in executor evidence.

slopAndProgrammingDirectPass:
- Loaded and applied `/Users/yeongyu/.agents/skills/remove-ai-slops/SKILL.md`, `/Users/yeongyu/.agents/skills/programming/SKILL.md`, and `/Users/yeongyu/.agents/skills/programming/references/typescript/README.md`.
- Excessive/useless tests: BLOCKER due `packages/coding-agent/test/mcp/reconnect.test.ts` at 274 pure LOC and helper/test growth that should be split.
- Deletion-only/requested-removal-only tests: PASS. Tests assert reconnect behavior, retry counts, fixture payloads, and call counters.
- Tautological tests: PASS for core behavior. Tests would fail if retry wrapper were removed; red evidence proves this.
- Implementation-mirroring/mock-only tests: PARTIAL. Unit retry test monkey-patches `client.callTool`, but manual QA patches SDK prototype in the real source CLI and records model-visible payload/counters, so the behavior is not mock-only.
- Unnecessary production extraction/normalization: PASS. `service-register.ts`/`service-exposure.ts` extraction keeps `service.ts` under the LOC ceiling and is not speculative.
- TypeScript escape hatches: BLOCKER from no-excuse checker (`as unknown as` and catch-without-narrowing in `reconnect.test.ts`).
- Timer safety: PASS for TODO17 reconnect timers; note pre-existing raw startup-race timeout is unref'd but not routed through `safeTimer`.
- Secret/log safety: PARTIAL. Retry-fix QA model requests redact authorization as `<mock-redacted>`. Original TODO17 QA contains `Bearer sk-mock-...`; this appears to be a fake local-provider key, not a real provider call, but should be sanitized for artifact hygiene.

finalStatus: REJECT
