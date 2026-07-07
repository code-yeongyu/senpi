# TODO15 Final Independent Gate Review

recommendation: REJECT
AdversarialVerify verdict: needs-fix

## blockers

- dirty_worktree: `git status --short --branch` at review time showed staged file `A  .omo/evidence/task-15-stop-hook-verification-4.md`. The user explicitly exempted unrelated untracked stop-hook files only when they are "not staged/owned"; this file is staged and TODO15-named, so the current HEAD/worktree state does not meet the clean final gate condition.

## originalIntent

TODO15 in `.omo/plans/senpi-mcp-plugin.md` requires a 250ms MCP startup race for eager and keep-alive servers:

- begin background connect at session start
- if connected within 250ms, register live tools
- if slow, register cached/deferred tools immediately
- after eventual connect, refresh/hot-swap through the stable sorted `registerTool` path
- keep unchanged tool arrays byte-identical for prompt-cache stability
- never let a slow server delay session readiness beyond the 300ms acceptance target
- if a server wedges, keep cached tools visible and return a typed `ConnectError` on first call without hanging

## desiredOutcome

From the user's perspective, starting a session with a slow MCP server should stay usable immediately from cached metadata, then quietly refresh tools once the server connects. A wedged server should not hang the session or hide cached tools; the model should receive a typed connection failure.

## userOutcomeReview

Behavior review: satisfied by current code and evidence.

- `packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts` defines `MCP_STARTUP_RACE_MS = 250`, races the connect promise against that deadline, and schedules late refresh through `refreshMcpToolsAfterStartupRace`.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts` applies the race only for eager/keep-alive servers and registers cached catalogs through `registerDirectMcpTools`.
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts` sorts catalog entries and active tool names, then uses `registerToolsPreservingActiveSet`.
- `packages/coding-agent/src/core/extensions/builtin/mcp/active-set.ts` registers tools in sorted name order and restores the intended active tool set.
- `packages/coding-agent/test/mcp/startup-race.test.ts` covers slow eager, slow keep-alive, late hot-swap, byte-identical unchanged active tool arrays, and wedged ConnectError/no-hang.

Gate review: not satisfied because the worktree/index is dirty with a staged TODO15 stop-hook artifact.

## checkedArtifactPaths

- `.omo/plans/senpi-mcp-plugin.md`
- `.omo/evidence/task-15-senpi-mcp-plugin-red.log`
- `.omo/evidence/task-15-senpi-mcp-plugin-green.log`
- `.omo/evidence/task-15-senpi-mcp-plugin-tests-final.log`
- `.omo/evidence/task-15-senpi-mcp-plugin-impacted.log`
- `.omo/evidence/task-15-senpi-mcp-plugin-npm-check.log`
- `.omo/evidence/task-15-senpi-mcp-plugin-ts-audit.log`
- `.omo/evidence/task-15-senpi-mcp-plugin-manual-qa.log`
- `.omo/evidence/task-15-senpi-mcp-plugin.md`
- `.omo/evidence/task-15-senpi-mcp-plugin-gate-review.md`
- `.omo/evidence/todo-15-code-quality-slop-review.md`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo15/INDEX.md`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo15/command-transcript.txt`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo15/auth-isolation.txt`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo15/cleanup.txt`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo15/happy-rpc-transcript.json`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo15/failure-rpc-transcript.json`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo15/todo15-manual-qa-driver.mjs`

## implementationEvidence

- Current branch: `code-yeongyu/senpi-mcp-plugin-w2`
- Current HEAD: `1bbadf535cd0ce35a8641cb1bcd7e88ad77d03d8`
- Relevant commits inspected:
  - `e485e72da feat(coding-agent): add mcp startup race hot-swap`
  - `abb836a83 fix(coding-agent): keep mcp startup race below line budget`
  - `1bbadf535 docs(coding-agent): add todo15 final stop-hook evidence`
- Current focused rerun by this reviewer:
  - Command: `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/startup-race.test.ts`
  - Result: PASS, 1 file, 6 tests, duration 5.51s.
- RED evidence failed for the right TODO15 behavior:
  - slow eager attach took 2359ms, expected under 300ms
  - cached-first hot-swap was not observable
  - wedged cached call did not expose a `ConnectError` cause
- GREEN/final evidence:
  - `.omo/evidence/task-15-senpi-mcp-plugin-green.log`: 6 startup-race tests passed
  - `.omo/evidence/task-15-senpi-mcp-plugin-tests-final.log`: 6 startup-race tests passed at 2026-07-07T01:45:56+09:00
  - `.omo/evidence/task-15-senpi-mcp-plugin-impacted.log`: 5 impacted MCP test files, 33 tests passed
  - `.omo/evidence/task-15-senpi-mcp-plugin-npm-check.log`: `npm run check` passed at 2026-07-07T01:46:21+09:00

## manualQA

Manual QA bundle is real and source-driven.

- `todo15-manual-qa-driver.mjs` imports `.agents/skills/senpi-qa/scripts/lib/common.mjs` and launches source CLI with `spawnCli(["--mode", "rpc", "--no-session", "--no-context-files", "--approve", "--provider", "mock", "--model", "mock-model"], ...)`.
- Happy transcript sample:
  - `immediateElapsedMs`: 42
  - first provider request MCP tools: `["mcp_fx_tool_1"]`
  - hot-swap provider request MCP tools: `["mcp_fx_tool_1","mcp_fx_tool_2"]`
  - later request contains `fixture tool_2 value=late mode=alpha`
- Failure transcript sample:
  - `callElapsedMs`: 558
  - first provider request MCP tools: `["mcp_fx_tool_1"]`
  - `modelSawConnectError`: true
  - post-error RPC responsiveness recorded by successful `get_state`
- Auth isolation:
  - `auth-isolation.txt` records real auth path `/Users/yeongyu/.senpi/agent/auth.json`
  - `realAuthAfterUnchanged=true`
- Cleanup:
  - `cleanup.txt` records `cleanup=complete`, `tmuxSessions=none`, sandbox paths, fake model ports, and RPC child pids.

## slopAndProgrammingReview

Mandatory skills consulted:

- `remove-ai-slops`
- `programming`
- `programming/references/typescript/README.md`

Direct slop pass:

- No excessive or deletion-only tests found.
- No tests merely verify a requested removal.
- Startup-race tests are not tautological: they drive the fixture server, warm cache, late live tool execution, unchanged active-tool serialization, and wedged ConnectError behavior.
- Manual QA independently samples provider payload tools and model-visible errors rather than mirroring implementation internals.
- `startup-race.ts` is a focused responsibility split from `service.ts`, not speculative abstraction; it is needed to keep `service.ts` under the 250 pure LOC ceiling.
- No new TypeScript escape hatches found in the TODO15 audit: no `any`, `as any`, suppressions, inline imports, non-erasable TS syntax, parameter properties, `enum`, or `namespace`.
- `service.ts` pure LOC measured by this reviewer: 230.

Report coverage check:

- `.omo/evidence/todo-15-code-quality-slop-review.md` explicitly covers LOC, TypeScript hygiene, async/timer surfaces, needless abstraction, defensive code, hollow/tautological tests, excessive tests, prompt-cache stability, and secret safety.
- The report is supported by `.omo/evidence/task-15-senpi-mcp-plugin-ts-audit.log`.
- No unresolved slop blocker found in direct review.

## adversarialClasses

- stale_state: PASS. Branch and HEAD match the requested scope. Caveat: prior gate report's residual-worktree note is stale because `.omo/evidence/task-15-stop-hook-verification-4.md` is now staged.
- dirty_worktree: FAIL. Staged `.omo/evidence/task-15-stop-hook-verification-4.md` is present.
- hung_or_long_commands: PASS. Reviewer-rerun focused test completed in 5.51s. Manual QA wedge path returned a model-visible ConnectError in 558ms and `get_state` remained responsive.
- misleading_success_output: PASS for behavior artifacts, FAIL for final gate cleanliness. Prior reports say PASS, but direct `git status` contradicts the "untracked/unstaged only" claim.
- flaky_tests: PASS. Focused startup-race test passed in committed final artifact, staged stop-hook artifact, and this reviewer rerun.
- malformed_input: PASS for TODO15-relevant malformed/runtime failure class. Wedged server path preserves cached tools and returns typed `ConnectError`; cache poisoning/corrupt JSON is covered by adjacent TODO14 evidence and impacted tests.
- prompt_injection: NA. TODO15 changes connection timing, cached tool registration, and hot-swap behavior; it does not introduce prompt/content parsing or instruction injection surfaces.
- cancel_resume: NA. TODO15 does not change cancellation/resume semantics; it tests slow/wedged startup race behavior.
- repeated_interruptions: NA. TODO15 does not change interruption handling. The relevant asynchronous interruption class is covered by slow/wedged connect and bounded no-hang tests.

## exactEvidenceGaps

- Blocking gap: current index is not clean. `git diff --cached --name-only` outputs `.omo/evidence/task-15-stop-hook-verification-4.md`.
- Non-blocking note: unrelated TODO14/TODO16 stop-hook files are untracked and not staged; they match the user's stated exemption.
- No behavioral evidence gap found for TODO15 startup race, hot-swap, stable ordering, typed wedge failure, focused tests, impacted tests, root check, or manual QA.

## finalVerdict

needs-fix
