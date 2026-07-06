# TODO18 Senpi MCP Plugin Gate Review

recommendation: REJECT / needs-fix

## originalIntent

TODO18 asked for MCP idle shutdown, in-flight protection, and keep-alive lifecycle behavior:

- Default `idleTimeoutMin` is 10 minutes.
- A configured idle window transitions a connected zero-in-flight server to `idle` while preserving cache.
- The next post-idle tool call reconnects transparently and returns the real MCP result.
- In-flight tool calls, renewal, and ensure-connect sections prevent idle shutdown.
- `lifecycle: "keep-alive"` uses an unref'd 30s safe interval and pings.
- A single killed keep-alive server recovers without emitting `suspended` before TODO17.
- `lifecycle: "eager"` connects on session start and can still idle.

## desiredOutcome

The user should be able to mark TODO18 complete only if the current commit, tests, QA evidence, worktree state, and code-quality/slop review all independently support completion.

## userOutcomeReview

Functional outcome: supported by code inspection and evidence.

- `packages/coding-agent/src/core/extensions/builtin/mcp/config.ts:206` normalizes server config and sets `idleTimeoutMin: server.idleTimeoutMin ?? 10` at line 213.
- `packages/coding-agent/src/core/extensions/builtin/mcp/idle.ts:6` defines `MCP_KEEP_ALIVE_INTERVAL_MS = 30_000`.
- `packages/coding-agent/src/core/extensions/builtin/mcp/idle.ts:56` increments the lifecycle in-flight counter around lifecycle-protected work, clears the idle timer, and refreshes timers in `finally`.
- `packages/coding-agent/src/core/extensions/builtin/mcp/idle.ts:79` starts keep-alive mode without an idle timer, and starts idle timers only when the connection is `connected` and `inFlight === 0`.
- `packages/coding-agent/src/core/extensions/builtin/mcp/idle.ts:93` uses `safeTimer` for idle shutdown and calls `connection.bumpGeneration()` to dispose transport while leaving the service entry/cache available.
- `packages/coding-agent/src/core/extensions/builtin/mcp/idle.ts:110` uses `safeInterval` for keep-alive, and `packages/coding-agent/src/core/extensions/builtin/mcp/wrap.ts:36` / `:50` show `safeTimer` and `safeInterval` both call `unref()`.
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts:92` wraps `ensureMcpToolCallConnection`, cached `ensureConnected`, and `client.callTool` in `runMcpConnectionLifecycleCall`.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts:192` configures lifecycle for each connection, and `:262` disposes lifecycle timers/listeners before connection disposal.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-snapshot.ts:17` reports post-idle generated connections as `idle` rather than stale `cached`.

User-visible behavior is covered by `packages/coding-agent/test/mcp/idle.test.ts`:

- Default 10min timeout: lines 39-45.
- Zero-in-flight idle shutdown and process death: lines 48-64.
- Eager connects then idles: lines 67-82.
- Long-running call blocks idle: lines 85-107.
- Renewal protected by lifecycle in-flight section: lines 110-125.
- Post-idle transparent reconnect returns fixture result and new PID: lines 128-143.
- Keep-alive ping, single-kill recovery, real tool result, and no `suspended`: lines 146-181.

## blockers

1. Required code-quality/slop report coverage is incomplete.

   Evidence: `.omo/evidence/todo-18-code-quality-slop-review.md` has useful sections for LOC, TypeScript hygiene, lifecycle/timer review, test quality, cache/secret safety, and artifact pointers. It does not explicitly show the required `remove-ai-slops` and `programming` skill-perspective check or enumerate the final-gate overfit/slop criteria: excessive/useless tests, deletion-only tests, tests that merely verify a requested removal, tautological tests, implementation-mirroring tests, and unnecessary production extraction/parsing/normalization.

   Exact artifact lines:

   - `.omo/evidence/todo-18-code-quality-slop-review.md:17`-`29`: LOC only.
   - `.omo/evidence/todo-18-code-quality-slop-review.md:31`-`44`: forbidden TypeScript pattern grep only.
   - `.omo/evidence/todo-18-code-quality-slop-review.md:46`-`54`: lifecycle/timer review only.
   - `.omo/evidence/todo-18-code-quality-slop-review.md:56`-`72`: says tests are observable and "No hollow tests were added", but does not explicitly cover the required overfit/slop categories.

   Minimal fix: update `.omo/evidence/todo-18-code-quality-slop-review.md` or add a replacement TODO18 code-quality/slop artifact that explicitly states `remove-ai-slops` and `programming` were consulted/applied, then enumerates each required overfit/slop criterion with concrete evidence from the diff/tests. No product-code change appears necessary based on this gate review.

## checkedArtifactPaths

- `.omo/plans/senpi-mcp-plugin.md`
- `.omo/evidence/task-18-senpi-mcp-plugin-red.log`
- `.omo/evidence/task-18-senpi-mcp-plugin-green.log`
- `.omo/evidence/task-18-senpi-mcp-plugin-final.log`
- `.omo/evidence/task-18-senpi-mcp-plugin-impacted-final.log`
- `.omo/evidence/task-18-senpi-mcp-plugin-check-final.log`
- `.omo/evidence/task-18-senpi-mcp-plugin-ts-audit-final.log`
- `.omo/evidence/todo-18-code-quality-slop-review.md`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo18/INDEX.md`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo18/auth-isolation.md`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo18/cleanup-receipt.md`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo18/command-rerun-transcript.txt`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo18/happy-rpc-transcript.jsonl`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo18/failure-rpc-transcript.jsonl`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo18/happy-fake-model-requests.json`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo18/failure-fake-model-requests.json`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo18/failure-mcp-logs.txt`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo18/todo18-mcp-rpc-driver.mjs`
- `packages/coding-agent/src/core/extensions/builtin/mcp/config.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/idle.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/wrap.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/connection.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/health.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/catalog.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-snapshot.ts`
- `packages/coding-agent/test/mcp/idle.test.ts`

## commandEvidence

- `git status --short --branch`
  - Result: branch `code-yeongyu/senpi-mcp-plugin-w2`.
  - Only untracked files are TODO14/TODO16 stop-hook evidence files:
    `.omo/evidence/task-16-stop-hook-verification*.md` and `.omo/evidence/todo-14-stop-hook-verification*.md`.
  - No tracked/staged TODO18 WIP observed before report writing.

- `git show --stat --name-only --oneline --decorate --no-renames ec6c376c5`
  - Result: current commit is `ec6c376c5 feat(coding-agent): mcp idle shutdown and keep-alive lifecycle`.
  - Changed files: `idle.ts`, `service.ts`, `service-snapshot.ts`, `expose/register.ts`, `test/mcp/idle.test.ts`, and `.omo/evidence/todo-18-code-quality-slop-review.md`.

- `cat .omo/evidence/task-18-senpi-mcp-plugin-red.log`
  - Result: RED evidence failed 4/5 tests before implementation; failures were idle timeout/reconnect/keep-alive conditions timing out.

- `cat .omo/evidence/task-18-senpi-mcp-plugin-final.log`
  - Result: final focused idle test passed 7/7, exit code 0.

- `cat .omo/evidence/task-18-senpi-mcp-plugin-impacted-final.log`
  - Result: impacted MCP tests passed 33/33, exit code 0.

- `cat .omo/evidence/task-18-senpi-mcp-plugin-check-final.log`
  - Result: `npm run check` passed, exit code 0.

- `cat .omo/evidence/task-18-senpi-mcp-plugin-ts-audit-final.log`
  - Result: forbidden TypeScript patterns had no matches; changed TS files were below 250 pure LOC.

- Independent rerun: `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/idle.test.ts`
  - Result: 1 file passed, 7 tests passed, exit code 0, duration 4.45s.

- Direct slop/TS pass:
  - Pure LOC measured: `register.ts` 177, `service-snapshot.ts` 26, `service.ts` 236, `idle.ts` 138, `idle.test.ts` 168.
  - `rg` for `any`, suppression comments, dynamic imports, `enum`, `namespace`, CommonJS import/export forms, `as any`, `as unknown`, empty catch, and `console.log` returned no matches in changed TS files.
  - `git diff --check ec6c376c5^ ec6c376c5 -- ...changed files...` returned clean.

## manualQAReview

Manual QA evidence is real source CLI RPC surface in an isolated sandbox:

- `todo18-mcp-rpc-driver.mjs` imports the `senpi-qa` harness and calls `spawnCli(["--mode", "rpc", "--no-session", "--no-context-files", ...])`.
- `.agents/skills/senpi-qa/scripts/lib/common.mjs:120` builds the CLI command from `node_modules/tsx/dist/cli.mjs`, root `tsconfig.json`, and `packages/coding-agent/src/cli.ts`, so it drives the source working tree.
- `makeSandbox` sets isolated `SENPI_CODING_AGENT_DIR` and `SENPI_CODING_AGENT_SESSION_DIR`.
- `hermeticEnv` removes provider API key env vars.
- `auth-isolation.md` shows real `/Users/yeongyu/.senpi/agent/auth.json` hash unchanged before/after.
- `cleanup-receipt.md` shows happy and failure sandboxes removed.
- `INDEX.md` reports 14/14 PASS.
- `happy-fake-model-requests.json` contains `fixture tool_1 value=happy-after-idle mode=alpha`.
- `failure-fake-model-requests.json` contains `fixture tool_1 value=failure-recovered mode=alpha`.
- `rg -n "suspended|breaker|degraded|transport closed|failed|renew|connect" failure-rpc-transcript.jsonl failure-mcp-logs.txt` returned no matches.

Evidence hygiene note: `checks.jsonl` contains entries from an earlier partial run as well as the final complete run because the driver appends to existing files. This is not the blocking issue because `command-rerun-transcript.txt` and `INDEX.md` identify the final complete 14/14 run, but a future evidence refresh should use a fresh directory or truncate JSONL artifacts first.

## adversarialClasses

- stale_state: PROBED. Worktree has no TODO18 WIP; manual QA JSONL has stale earlier entries, but final `INDEX.md` and `command-rerun-transcript.txt` corroborate the complete rerun. Not the blocking issue.
- dirty_worktree: PASS before report writing. Only unrelated untracked TODO14/TODO16 stop-hook files were present.
- hung_or_long_commands: PASS. Independent focused rerun completed in 4.45s; saved `npm run check` completed with exit code 0; cleanup receipt present.
- misleading_success_output: BLOCKED by the code-quality/slop report gap. Functional success output was cross-checked against source, tests, and fake-model requests, but the review artifact overclaims slop completeness without explicit required criteria.
- flaky_tests: PASS. Saved final focused test and independent rerun both passed 7/7. Impacted saved tests passed 33/33.
- malformed_input: PROBED. TODO18 does not introduce a new parser; changed tool execution preserves the existing `isRecord(params)` boundary and TS audit found no `any`/dynamic import/type-suppression escape hatches.
- prompt_injection: N/A. The change does not alter prompt construction, model instruction handling, or untrusted text interpretation; manual QA uses deterministic fake model requests.
- cancel_resume: N/A. The change does not alter cancellation/resume workflows; existing `signal` forwarding to `callTool` remains unchanged.
- repeated_interruptions: N/A. The change is connection lifecycle/timer management, not interrupted turn resumption; timer cleanup/dispose paths were inspected.

## directSlopPass

Direct `remove-ai-slops` / `programming` pass over the diff, tests, and production code:

- No excessive or useless tests found: each new test maps to a TODO18 acceptance criterion and asserts external process/state/tool-result behavior.
- No deletion-only tests found.
- No tests merely verifying requested removal found; tests assert idle shutdown, cache-preserving reconnect, in-flight blocking, keep-alive ping/recovery, and no pre-TODO17 `suspended` state.
- No tautological tests found; tests drive real stdio fixtures, kill real processes, and assert PIDs/tool results.
- No implementation-mirroring tests requiring private timer internals for the core behavior found. Debug snapshot use is limited to observable unref/in-flight evidence.
- No unnecessary production extraction/parsing/normalization found. The new `idle.ts` module is a cohesive lifecycle owner used by service setup, dispose, and tool execution; no speculative parser or normalization layer was added.
- No unresolved TypeScript maintenance slop found in the code itself: no `any`, `as any`, `as unknown`, dynamic imports, TS suppressions, enums, namespaces, empty catches, or `console.log`; all changed TS files are below 250 pure LOC.

## exactEvidenceGaps

- `.omo/evidence/todo-18-code-quality-slop-review.md` lacks explicit required skill-perspective and overfit/slop criterion coverage. This prevents confirming TODO18 complete even though the implementation and QA evidence otherwise support the requested behavior.

## finalVerdict

AdversarialVerify: { verdict: "needs-fix" }

TODO18 cannot be marked complete until the code-quality/slop report gap is fixed.
