# TODO17 Gate Review

recommendation: REJECT

originalIntent: Implement TODO17 for the senpi MCP plugin plan: automatic reconnect on unexpected close with full-jitter backoff, a five-attempts-in-thirty-seconds circuit breaker that suspends the server, manual `/mcp reconnect <server>` reset, and retry correctness that retries only establishment/retriable failed-to-send cases once while never duplicating in-flight tool calls.

desiredOutcome: Users see MCP servers recover from transient disconnects without restart, stop crash loops safely, can manually reconnect suspended servers, and do not get duplicate tool execution. The evidence must prove this through TDD, focused/impacted checks, `npm run check`, and real senpi QA artifacts with cleanup.

userOutcomeReview: The delivered commit proves useful portions of the outcome: reconnect scheduling, suspension after five reconnects, manual reconnect, queued post-crash call success, and no duplicate in-flight execution. It does not satisfy the full TODO17 contract because the production call path does not use the retriable classifier for exactly one post-reconnect retry of a failed-to-send tool call, and no test or manual QA artifact covers that required class.

blockers:
- Missing required retry semantics. `.omo/plans/senpi-mcp-plugin.md:251` requires exactly one post-reconnect retry for retriable-classifier failed-to-send calls. `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts:97` to `:120` only wraps execution in `withMcpSessionExpiryRetry`; `packages/coding-agent/src/core/extensions/builtin/mcp/health.ts:39` to `:58` retries session-expired errors only. `packages/coding-agent/src/core/extensions/builtin/mcp/errors.ts:74` defines `isRetriableMcpError`, but `rg -n "isRetriableMcpError"` shows production use only at the definition, with remaining matches in tests. A retriable `transport closed`/502/503/-32001 failed-to-send tool call will be wrapped as `ToolExecError` rather than renewed and retried once.
- Evidence gap: `packages/coding-agent/test/mcp/reconnect.test.ts:127` to `:171` covers in-flight no-duplicate and queued call after a killed transport, but not a failed-to-send `callTool` error classified by `isRetriableMcpError`. Manual QA under `local-ignore/qa-evidence/20260707-mcp-w2-todo17/` likewise covers suspended->manual reconnect and in-flight crash exactly-once, not this classifier retry path.
- Required gate-review input gap: no separate code-review report artifact was provided or found that explicitly applies the `remove-ai-slops`/`programming` perspective and overfit/slop criteria. Direct review found no blocking slop in production, but report coverage is absent.

checked artifact paths:
- `.omo/plans/senpi-mcp-plugin.md`
- commit `9d3f6a1a49814c6918f710b2a21aeb493b6cd715`
- `.omo/evidence/task-17-senpi-mcp-plugin-baseline.log`
- `.omo/evidence/task-17-senpi-mcp-plugin-red.log`
- `.omo/evidence/task-17-senpi-mcp-plugin-green-reconnect.log`
- `.omo/evidence/task-17-senpi-mcp-plugin-green-impacted.log`
- `.omo/evidence/task-17-senpi-mcp-plugin-check.log`
- `.omo/evidence/task-17-senpi-mcp-plugin-static-audit.log`
- `.omo/evidence/task-17-senpi-mcp-plugin.log`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17/INDEX.md`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17/scenario1-status-suspended.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17/scenario1-rpc-events.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17/scenario2-rpc-events.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17/scenario2-call-counter.txt`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo17/cleanup-receipt.txt`
- `packages/coding-agent/src/core/extensions/builtin/mcp/reconnect.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/health.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/errors.ts`
- `packages/coding-agent/test/mcp/reconnect.test.ts`

exact evidence gaps:
- No red proof, green test, or QA scenario for exactly one retry after a retriable failed-to-send tool call.
- No production path connects `isRetriableMcpError` to `callMcpTool`.
- No external code review report artifact with explicit remove-ai-slops/programming coverage.

commands run:
- `git status --short --branch && git rev-parse HEAD && git rev-parse --show-toplevel`
- `rg -n "TODO ?17|17|auto-reconnect|reconnect|circuit|jitter|retry" .omo/plans/senpi-mcp-plugin.md`
- `git show --stat --name-status --oneline 9d3f6a1a4`
- `sed -n '1,260p'` over relevant evidence and source files listed above
- `rg -n "isRetriableMcpError|withMcpSessionExpiryRetry|ensureMcpToolCallConnection|callMcpTool|markDegraded\\(|markSuspended\\(|timerGeneration|generation !==|safeTimer|setTimeout|setInterval|unref\\(" packages/coding-agent/src/core/extensions/builtin/mcp packages/coding-agent/test/mcp/reconnect.test.ts packages/coding-agent/test/mcp/wrap.test.ts`
- `npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/reconnect.test.ts` from `packages/coding-agent` (passed: 1 file, 6 tests)
- `jq` probes over manual QA JSON artifacts for suspended/breaker/reconnect payload/ToolExecError/responsiveness markers

adversarial probes:
- stale_state: Partially covered by generation checks in `reconnect.ts:97` to `:114`; no direct stale-generation regression test found.
- dirty_worktree: No staged or unstaged tracked diffs. Untracked `.omo/evidence/*stop-hook*` markdown files exist and are unrelated to production/test behavior.
- misleading_success_output: Manual QA contains real payload marker `fixture tool_1 value=restored mode=alpha` and `RECOVERED-PAYLOAD-OK`, not counters only. It still omits retriable failed-to-send retry.
- flaky_tests/timing-sensitive behavior: Focused reconnect test passed on rerun. Tests still use `waitFor` polling and one fixed `delay(500)` in `reconnect.test.ts:97` to `:100`, so some timing risk remains.
- malformed input: `/mcp reconnect` unknown/missing target path remains covered through command unknown-server assertions.
- cancel/resume: No reconnect command cancellation path applies; tool abort semantics are passed through to SDK call and were not changed here.
- hung/long commands: Timers use `safeTimer`/`safeInterval` with `unref`; manual cleanup receipt says no lingering fixture processes.
- remove-ai-slops/programming direct pass: Production extraction into `service-register.ts`/`service-exposure.ts` is reasonable to keep `service.ts` under the 250 pure LOC ceiling; no broad catch swallow, `any`, parameter properties, enum declarations, or inline dynamic imports found in changed production files. Test helper extraction is single-consumer but moves a large UI fixture, not a blocking functional issue. The missing retry path is a functional blocker, not style.
