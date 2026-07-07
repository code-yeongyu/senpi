# TODO17 final gate review

recommendation: APPROVE

blockers: none

originalIntent: Complete TODO17 from `.omo/plans/senpi-mcp-plugin.md`: MCP auto-reconnect on unexpected transport close with full-jitter backoff `[0.5,1,2,4,8]s`, suspend after five reconnects within thirty seconds, let `/mcp reconnect <server>` reset the breaker and reconnect immediately, retry retriable failed-to-send calls exactly once after reconnect, never auto-retry an in-flight transport death, and use unref'd safe timers.

desiredOutcome: A user with MCP servers should see transient disconnects recover, crash loops stop in a suspended state instead of looping, manual reconnect recover the server, failed sends retry once without duplicate server execution, and in-flight transport death surface as a model-visible tool error. The implementation must also satisfy TDD, impacted tests, `npm run check` evidence, manual QA, cleanup receipts, LOC/no-excuse gates, slop review, and secret hygiene.

userOutcomeReview: Confirmed. The current `HEAD` is `b5961333e2912e535181f78ecd84f4c5cdd7e776` on `code-yeongyu/senpi-mcp-plugin-w2`. Source inspection confirms the reconnect/retry paths are implemented in `reconnect.ts`, `health.ts`, `expose/register.ts`, `commands.ts`, `service.ts`, and `wrap.ts`. Manual QA artifacts show suspended state with `reconnects=5`, `/mcp reconnect fx connected`, recovered fixture payload, failed-send `sendAttempts=2` with `callCounter=1`, and in-flight crash `ToolExecError` with `callCounter=1`. Fresh focused and impacted tests pass. Quality cleanup resolved prior blockers: every TODO17 touched TS file is <=250 pure LOC, the no-excuse checker passes, `git diff --check` passes over the full TODO17 range, and the slop/programming report exists and covers the required overfit/slop criteria.

checkedArtifactPaths:
- `.omo/plans/senpi-mcp-plugin.md`
- commits `9d3f6a1a4`, `539805884`, `b5961333e`
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
- `.omo/evidence/todo17-senpi-mcp-plugin-gate-review-after-retry-fix.md`
- `.omo/evidence/task-17-quality-cleanup-senpi-mcp-plugin.log`
- `.omo/evidence/task-17-quality-cleanup-no-excuse.log`
- `.omo/evidence/task-17-quality-cleanup-loc.log`
- `.omo/evidence/task-17-quality-cleanup-reconnect.log`
- `.omo/evidence/task-17-quality-cleanup-impacted.log`
- `.omo/evidence/task-17-quality-cleanup-diff-check.log`
- `.omo/evidence/task-17-quality-cleanup-check.log`
- `.omo/evidence/task-17-quality-cleanup-manual-qa-integrity.log`
- `.omo/evidence/todo-17-code-quality-slop-review.md`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17/INDEX.md`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17/cleanup-receipt.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17/scenario1-status-suspended.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17/scenario1-rpc-events.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17/scenario1-model-requests.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17/scenario2-rpc-events.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17/scenario2-model-requests.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17/scenario2-call-counter.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17-retry-fix/INDEX.md`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17-retry-fix/cleanup-receipt.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17-retry-fix/failed-send-retry/summary.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17-retry-fix/failed-send-retry/send-attempts.jsonl`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17-retry-fix/failed-send-retry/model-requests.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17-retry-fix/inflight-no-duplicate/summary.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17-retry-fix/inflight-no-duplicate/model-requests.json`
- `packages/coding-agent/src/core/extensions/builtin/mcp/reconnect.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/health.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/commands.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/idle.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/wrap.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/errors.ts`
- `packages/coding-agent/test/mcp/reconnect.test.ts`
- `packages/coding-agent/test/mcp/fixtures/reconnect.ts`

commandsRun:
- `cat /Users/yeongyu/.agents/skills/remove-ai-slops/SKILL.md`
- `cat /Users/yeongyu/.agents/skills/programming/SKILL.md`
- `cat /Users/yeongyu/.agents/skills/programming/references/typescript/README.md`
- `cat /Users/yeongyu/.agents/skills/programming/references/code-smells.md`
- `git rev-parse HEAD`
- `git status --short --branch`
- `git diff --name-only 9d3f6a1a4^..HEAD`
- `git diff 9d3f6a1a4^..HEAD -- packages/coding-agent/src/core/extensions/builtin/mcp`
- `git diff 9d3f6a1a4^..HEAD -- packages/coding-agent/test/mcp/reconnect.test.ts packages/coding-agent/test/mcp/fixtures/reconnect.ts`
- `nl -ba` reads of the production and test files listed above
- `git diff --check HEAD~2`
- `git diff --check 9d3f6a1a4^..HEAD`
- `NODE_PATH=/Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w2/node_modules npx tsx /Users/yeongyu/.agents/skills/programming/scripts/typescript/check-no-excuse-rules.ts <14 TODO17 TS files>`
- Per-file pure LOC `awk` over the 14 TODO17 touched TS files
- `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/reconnect.test.ts`
- `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/connection.test.ts test/mcp/ping-on-call.test.ts test/mcp/idle.test.ts test/mcp/commands.test.ts test/mcp/service-lifecycle.test.ts test/mcp/register-call.test.ts test/mcp/reconnect.test.ts`
- `git ls-files --error-unmatch <required committed evidence logs>`
- `git diff --exit-code`
- `git diff --cached --exit-code`
- `node -e` inspection of `package.json` check script and QA model request header fields
- `rg -n "setTimeout|setInterval|safeTimer|safeInterval|\\.unref\\(" packages/coding-agent/src/core/extensions/builtin/mcp -g '*.ts'`

verificationResults:
- TODO17 plan lines read: `.omo/plans/senpi-mcp-plugin.md` lines 250-256 define the accepted behavior.
- Functional code: `ServerConnection` marks unexpected transport close as degraded with a retriable close error; `configureMcpReconnect()` schedules safeTimer reconnects on degraded state; `MCP_RECONNECT_BACKOFF_MS` is `[500,1000,2000,4000,8000]`; delay is `baseDelayMs * random` clamped to `[0,1]` for full jitter; breaker opens at five attempts in a thirty-second window and marks `suspended`; `reconnectMcpNow()` clears attempts/backoff and runs immediately; `/mcp reconnect` calls `McpService.reconnectServer()` and refreshes session tools.
- Retry correctness: `withMcpRetriableFailedSendRetry()` wraps only the `client.callTool` send operation, renews once, and retries once. The retry-fix red log fails before production support; green/fresh tests and QA show exactly two send attempts, one injected pre-server failure, two fixture spawns, and one server execution.
- In-flight death: unit tests and manual QA show the crash-during-tool-call path surfaces `ToolExecError` to the model and leaves fixture `callCounter=1`.
- Timers: TODO17 reconnect timers use `safeTimer`, and `safeTimer`/`safeInterval` unref timers. A raw `setTimeout` remains in `startup-race.ts`, but it is pre-existing startup-race behavior, is unref'd, and is not the TODO17 reconnect timer path.
- Fresh focused test: `test/mcp/reconnect.test.ts` passed, 8 tests.
- Fresh impacted test: 7 MCP test files passed, 50 tests.
- Fresh no-excuse check: no violations in 14 files.
- Fresh LOC audit: max touched TS file is `packages/coding-agent/test/mcp/fixtures/sdk-server.ts` at 247 pure LOC; `reconnect.test.ts` is 225.
- Fresh whitespace checks: `git diff --check HEAD~2` and `git diff --check 9d3f6a1a4^..HEAD` produced no output and exited 0.
- `npm run check`: not rerun by this read-only gate because `package.json` shows `biome check --write`; committed `.omo/evidence/task-17-quality-cleanup-check.log` records exit 0 and full output. Fresh read-only-ish targeted tests and static checks above support the same scope.
- Dirty worktree: no tracked or staged diffs (`git diff --exit-code`, `git diff --cached --exit-code`). Existing untracked `.omo/evidence/*stop-hook*` and prior gate files are present but are unrelated evidence artifacts.

slopAndProgrammingDirectPass:
- Loaded and applied `remove-ai-slops`, `programming`, TypeScript, and code-smells references directly.
- Excessive/useless tests: PASS. The reconnect tests assert observable state, counters, payloads, retry attempts, and model-visible errors; they are not deletion-only, request-removal-only, or tautological.
- Implementation-mirroring/mock-only tests: PASS. The retry-fix unit test monkey-patches the SDK client to inject a failed send, but real source CLI QA also drives the built-in MCP tool path and records model request/payload/counter artifacts.
- Unnecessary production extraction: PASS. `service-exposure.ts` and `service-register.ts` split cohesive responsibilities out of `service.ts`; all files remain under 250 pure LOC and no public API drift was found.
- Forbidden TS escape hatches: PASS by no-excuse checker.
- Secret hygiene: PASS within the user-stated allowance. Retry-fix QA model requests redact authorization as `<mock-redacted>`. Original TODO17 QA model requests contain only `Bearer sk-mock-qa-7f3a` against localhost fake provider, which is a fake mock key, not a real provider secret. No private-key or real-token pattern was found in the inspected required artifacts.

adversarialProbes:
- stale_state: PASS. HEAD matches the requested commit; retry QA proves the renewed generation/server handled the retried call.
- dirty_worktree: PASS with note. Tracked and staged diffs are clean; untracked evidence files are unrelated and not used as proof of product behavior.
- misleading_success_output: PASS. Evidence includes payloads, counters, model requests, send-attempt logs, cleanup receipts, and fresh reruns, not only pass counts.
- flaky_tests/timing-sensitive: PASS. Jitter tests use fake timers/RNG for deterministic bounds; fresh focused and impacted suites passed. Some integration tests use bounded wait helpers, but no unresolved flake was observed.
- malformed_input: PASS. `/mcp reconnect` unknown/missing handling is covered in the commands suite, and impacted commands tests passed.
- hung/long commands: PASS. Manual QA cleanup receipts show sandbox removal and fixture pids dead; fresh tests completed within seconds; timers are unref'd on the reconnect path.
- repeated_interruptions: PASS. Crash-loop suspension, manual reconnect, failed-send retry, and in-flight crash/no-duplicate all have evidence.
- prompt_injection/secret leakage: PASS. Fixture/server text is treated as model-visible tool data; no command execution from server text was introduced; model requests use localhost fake provider with mock/redacted keys.
- cancel/resume: PASS/N/A. This TODO did not change abort semantics; impacted register-call tests passed and in-flight no-duplicate behavior is preserved.

exactEvidenceGaps:
- No unresolved gaps.
- Not inspected: no external CI service or PR UI, because the requested scope was the local worktree/branch artifacts.

finalStatus: APPROVE
