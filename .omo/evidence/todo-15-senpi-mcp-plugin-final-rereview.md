# TODO15 Final Independent Rereview

recommendation: APPROVE
AdversarialVerify verdict: confirmed

## blockers

None.

## originalIntent

TODO15 in `.omo/plans/senpi-mcp-plugin.md` requires a 250ms MCP startup race for eager and keep-alive servers:

- begin background connect at session start
- if connected within 250ms, register live tools
- if slow, register cached/deferred tools immediately
- after eventual connect, refresh/hot-swap through the stable sorted `registerTool` path
- keep unchanged tool arrays byte-identical for prompt-cache stability
- keep slow startup under the 300ms acceptance target when cache exists
- if a server wedges, keep cached tools visible and return a typed `ConnectError` without hanging

## desiredOutcome

From the user's perspective, senpi should start a session immediately even when an eager MCP server is slow, expose cached MCP tools right away, quietly hot-swap refreshed live tools later, and degrade wedged servers with a model-visible typed connection error rather than a hung session.

## userOutcomeReview

Confirmed. Current code and evidence satisfy the intended user-visible outcome.

- `packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts` defines `MCP_STARTUP_RACE_MS = 250`, races the connect promise against that deadline, and schedules late refresh through `refreshMcpToolsAfterStartupRace`.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts` applies the startup race only to eager/keep-alive servers, registers cached catalogs through the normal direct-tool path, and generation-gates late refreshes.
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts` sorts catalog entries and active tool names before registration.
- `packages/coding-agent/src/core/extensions/builtin/mcp/active-set.ts` registers tools by sorted name and restores the intended active tool set in the same path used by late refresh.
- `packages/coding-agent/test/mcp/startup-race.test.ts` covers fast eager live startup, slow eager cached startup under 300ms, slow keep-alive cached startup, late hot-swap, byte-identical unchanged arrays, and wedged `ConnectError`/no-hang behavior.

## checkedArtifactPaths

- `.omo/plans/senpi-mcp-plugin.md`
- `.omo/start-work/senpi-mcp-plugin-notepad.md`
- `.omo/evidence/task-15-senpi-mcp-plugin.md`
- `.omo/evidence/task-15-senpi-mcp-plugin-red.log`
- `.omo/evidence/task-15-senpi-mcp-plugin-green.log`
- `.omo/evidence/task-15-senpi-mcp-plugin-tests-final.log`
- `.omo/evidence/task-15-senpi-mcp-plugin-impacted.log`
- `.omo/evidence/task-15-senpi-mcp-plugin-npm-check.log`
- `.omo/evidence/task-15-senpi-mcp-plugin-ts-audit.log`
- `.omo/evidence/task-15-senpi-mcp-plugin-manual-qa.log`
- `.omo/evidence/task-15-senpi-mcp-plugin-gate-review.md`
- `.omo/evidence/task-15-stop-hook-verification-4.md`
- `.omo/evidence/todo-15-code-quality-slop-review.md`
- `.omo/evidence/todo-15-senpi-mcp-plugin-final-gate-review.md`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo15/INDEX.md`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo15/command-transcript.txt`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo15/auth-isolation.txt`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo15/cleanup.txt`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo15/happy-rpc-transcript.json`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo15/failure-rpc-transcript.json`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo15/todo15-manual-qa-driver.mjs`
- `packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/connection.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/active-set.ts`
- `packages/coding-agent/test/mcp/startup-race.test.ts`

## implementationEvidence

- Worktree: `/Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w2`
- Branch: `code-yeongyu/senpi-mcp-plugin-w2`
- HEAD: `8a87b4de493acf964e934bdecba448e7376cb5f2`
- Relevant commits inspected:
  - `e485e72da feat(coding-agent): add mcp startup race hot-swap`
  - `abb836a83 fix(coding-agent): keep mcp startup race below line budget`
  - `1bbadf535 docs(coding-agent): add todo15 final stop-hook evidence`
  - `8a87b4de4 docs(coding-agent): add todo15 final gate evidence`
- Current reviewer rerun:
  - Command: `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/startup-race.test.ts`
  - Result: PASS, 1 file / 6 tests, duration 5.38s.
- Committed verification artifacts:
  - Focused final test: PASS, 6 tests.
  - Impacted tests: PASS, 5 files / 33 tests.
  - `npm run check`: PASS, including Biome, pinned deps, TS import checks, shrinkwrap/install-lock checks, TypeScript, browser/web UI checks, and `check:neo`.
  - Pure LOC: `service.ts` 230, `startup-race.ts` 80, `connection.ts` 249, `expose/register.ts` 174, `startup-race.test.ts` 171.
  - TypeScript audit: no `any`, `as any`, suppressions, inline imports, non-erasable TS syntax, parameter properties, `enum`, `namespace`, or non-null assertion matches in the audited TODO15 files.

## manualQA

Manual QA bundle is present and source-driven.

- Driver imports `.agents/skills/senpi-qa/scripts/lib/common.mjs` and launches source CLI with `--mode rpc --no-session --no-context-files --approve --provider mock --model mock-model`.
- Happy transcript:
  - `immediateElapsedMs`: 42
  - first provider request MCP tools: `["mcp_fx_tool_1"]`
  - hot-swap request MCP tools: `["mcp_fx_tool_1","mcp_fx_tool_2"]`
  - tool result `"fixture tool_2 value=late mode=alpha"` appears in provider/request evidence.
- Failure transcript:
  - `callElapsedMs`: 558
  - first provider request MCP tools: `["mcp_fx_tool_1"]`
  - `modelSawConnectError`: true
  - post-error `get_state` responsiveness was asserted by the driver.
- Auth isolation: `auth-isolation.txt` records `realAuthAfterUnchanged=true` for `/Users/yeongyu/.senpi/agent/auth.json`; only hash/unchanged status is stored.
- Cleanup: `cleanup.txt` records `cleanup=complete`, no tmux sessions, and no leftover TODO15/fixture/RPC process was found by this reviewer.

## slopAndProgrammingReview

Mandatory skills consulted:

- `remove-ai-slops`
- `programming`
- `programming/references/typescript/README.md`

Direct slop pass:

- No excessive or deletion-only tests found.
- No test merely verifies a requested removal.
- Startup-race tests are not tautological or implementation-mirroring only: they drive local MCP stdio fixture behavior, warm cache registration, late live tool execution, byte-identical active-tool serialization, and wedged `ConnectError` behavior.
- Manual QA asserts observable provider payloads and model-visible errors through the real CLI/RPC surface.
- The `startup-race.ts` extraction is necessary to keep `service.ts` below the 250 pure LOC ceiling and has a focused startup/connect-refresh responsibility; it is not speculative abstraction.
- Error handling is at the MCP connection/cache-refresh boundary and preserves degraded/no-hang behavior; no catch-and-swallow slop found in TODO15 production code.
- No forbidden TypeScript escape hatches or non-erasable constructs found in the audited TODO15 files.

Report coverage check:

- `.omo/evidence/todo-15-code-quality-slop-review.md` explicitly covers LOC, TypeScript hygiene, async/timer surfaces, needless abstraction, defensive code, hollow/tautological tests, excessive tests, prompt-cache stability, and secret safety.
- The report is supported by `.omo/evidence/task-15-senpi-mcp-plugin-ts-audit.log` and by this reviewer run.
- No unresolved slop blocker found.

## adversarialClasses

- stale_state: PASS. Current branch and HEAD match the requested scope. Commit `8a87b4de4` now contains `.omo/evidence/task-15-stop-hook-verification-4.md` and the prior final gate report.
- dirty_worktree: PASS for the requested condition. `git status --short --branch` shows no tracked or staged changes; only unrelated untracked TODO14/TODO16 stop-hook evidence is present. This report itself is the only new write from the rereview.
- hung_or_long_commands: PASS. Focused startup-race test completed in 5.38s. Manual QA wedge path returned a model-visible `ConnectError` in 558ms. Process probe found no leftover TODO15/fixture/RPC process.
- misleading_success_output: PASS. Prior prose PASS claims are backed by direct code inspection, committed test logs, reviewer rerun, manual QA transcript fields, auth isolation, and cleanup receipts.
- flaky_tests: PASS. Focused test passed in committed final artifact, stop-hook artifact, and this reviewer rerun.
- malformed_input: PASS for TODO15-relevant runtime failure. Wedged server keeps cached tools visible and returns a typed `ConnectError`; adjacent impacted cache tests cover corrupt/poisoned cache handling.
- prompt_injection: NA. TODO15 changes MCP connection timing, cached tool registration, and hot-swap behavior; it does not introduce prompt/content parsing or instruction injection surfaces.
- cancel_resume: NA. TODO15 does not change cancellation/resume semantics; the relevant async timing risk is covered by slow/wedged connect and bounded no-hang tests.
- repeated_interruptions: NA. TODO15 does not alter interruption handling.

## exactEvidenceGaps

None found for TODO15 startup race behavior, late hot-swap, stable sorted/byte-identical unchanged tools, wedged typed `ConnectError`/no-hang behavior, focused tests, impacted tests, root check, pure LOC, TypeScript audit, slop review, manual QA bundle, auth isolation, cleanup, or current worktree cleanliness.

## finalVerdict

confirmed
