# TODO16 gate review

recommendation: REJECT

## originalIntent

Gate-review TODO16 "Ping-on-call revalidation + in-place renewal" before the
orchestrator marks it complete.

## desiredOutcome

Before each MCP tool call, stale server health is revalidated with SDK ping
using a 2s timeout. Ping failure or timeout renews the connection in place,
then the original call runs. Renewal is bounded to one attempt; second failure
returns a typed model-visible tool error. Successful health is cached for 30s
per server, lazy/eager servers do not gain background polling, and TODO14
cache-deferred registration remains compatible.

## userOutcomeReview

The shipped implementation appears to satisfy the runtime outcome:

- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts:91`
  routes MCP tool execution through `ensureMcpToolCallConnection` before
  `callTool`.
- `packages/coding-agent/src/core/extensions/builtin/mcp/health.ts:3` and
  `:49` define a 30s stale window and call SDK `ping({ timeout: 2000 })`.
- `packages/coding-agent/src/core/extensions/builtin/mcp/health.ts:47` renews
  on ping failure and does not loop.
- `packages/coding-agent/src/core/extensions/builtin/mcp/connection.ts:111`
  renews in place by disposing owned connections and reconnecting the same
  `ServerConnection`.
- TODO14 cache-deferred entries still call through the same registered tool path:
  `packages/coding-agent/src/core/extensions/builtin/mcp/catalog.ts:39`,
  `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts:222`, and
  `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts:91`.

Tests and manual QA are behavior-oriented rather than implementation-mirroring:
they kill a fixture process, assert the next call returns the original payload
from a new pid, count ping calls, bound renewal attempts, and drive the real
source CLI in RPC mode.

## blockers

1. Required code-review/slop report coverage is absent for TODO16.
   The available TODO16 evidence set has raw test/check/manual QA logs and
   stop-hook verification, but no TODO16 code-quality/slop review report that
   explicitly records remove-ai-slops and programming perspective coverage.
   This gate requires that report coverage in addition to this direct pass.

## exactEvidenceGaps

- No artifact matching TODO16 code-quality/slop review was found under `.omo/`.
  Search command:
  `find .omo -type f \( -iname '*16*slop*' -o -iname '*16*review*' -o -iname '*16*quality*' -o -iname '*todo16*' -o -iname '*todo-16*' -o -iname '*task-16*' \) -print | sort`
  returned only task logs, the task evidence md, and stop-hook verification
  files.
- `git ls-files .omo/evidence | rg 'task-16|stop-hook|gate-review'` shows only
  `.omo/evidence/task-16-senpi-mcp-plugin.md` is committed for TODO16.
- The missing report must explicitly cover overfit/slop criteria:
  excessive/useless tests, deletion-only tests, requested-removal-only tests,
  tautological tests, implementation-mirroring tests, unnecessary production
  extraction/parsing/normalization, scope drift, no-excuse/type-safety, and
  residual risk.

## checkedArtifactPaths

- `.omo/plans/senpi-mcp-plugin.md`
- `.omo/evidence/task-16-senpi-mcp-plugin.md`
- `.omo/evidence/task-16-senpi-mcp-plugin-red.log`
- `.omo/evidence/task-16-senpi-mcp-plugin-green-focused.log`
- `.omo/evidence/task-16-senpi-mcp-plugin-green-impacted-after-check.log`
- `.omo/evidence/task-16-senpi-mcp-plugin-npm-check.log`
- `.omo/evidence/task-16-stop-hook-verification.md`
- `.omo/evidence/task-16-stop-hook-verification-2.md`
- `.omo/evidence/task-16-stop-hook-verification-3.md`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo16/manual-qa.log`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo16/happy-summary.json`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo16/failure-summary.json`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo16/auth-isolation.json`
- `local-ignore/qa-evidence/20260706-mcp-w2-todo16/cleanup-receipt.json`
- `packages/coding-agent/src/core/extensions/builtin/mcp/connection.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/health.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts`
- `packages/coding-agent/test/mcp/ping-on-call.test.ts`
- `packages/coding-agent/test/mcp/fixtures/options.ts`
- `packages/coding-agent/test/mcp/fixtures/sdk-server.ts`
- `packages/coding-agent/test/mcp/fixtures/stdio-server.ts`

## directSlopAndProgrammingPass

Skills consulted:

- `/Users/yeongyu/.agents/skills/remove-ai-slops/SKILL.md`
- `/Users/yeongyu/.agents/skills/programming/SKILL.md`
- `/Users/yeongyu/.agents/skills/programming/references/typescript/README.md`

Direct pass result:

- No unresolved production-code slop found.
- No excessive, deletion-only, requested-removal-only, tautological, or
  implementation-mirroring tests found.
- The new test file asserts observable process, RPC/tool, ping-count, and error
  behavior rather than duplicating private implementation logic.
- No new background polling code was found in the TODO16 production diff.
- TypeScript no-excuse audit passed on the seven touched files:
  `No violations in 7 file(s).`
- File-size check found no >250 pure LOC files in the TODO16 touched set. Two
  files are in the warning band, not a blocker:
  `connection.ts` 243 pure LOC, `sdk-server.ts` 230 pure LOC.
- Non-blocking cleanup candidate: the generated test wrapper string in
  `ping-on-call.test.ts` contains an empty `catch {}` and dynamic import. It is
  fixture-only temp-script glue and did not affect the gate outcome, but the
  missing TODO16 slop report should mention or clean it up.

## repro

Focused test rerun:

```text
cd packages/coding-agent &&
npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/ping-on-call.test.ts

Test Files  1 passed (1)
Tests       4 passed (4)
```

TypeScript no-excuse audit rerun:

```text
bun run /Users/yeongyu/.agents/skills/programming/scripts/typescript/check-no-excuse-rules.ts <7 touched files>

No violations in 7 file(s).
```

Evidence sanity:

- `npm run check` evidence exists in `.omo/evidence/task-16-senpi-mcp-plugin-npm-check.log`
  and shows the full root check pipeline passing.
- Manual QA summary shows `7/7 passed`, renewed pid `24974 -> 24983`,
  bounded failure `attempts=2`, RPC alive, and real auth unchanged.
- Committed TODO16 evidence is only `.omo/evidence/task-16-senpi-mcp-plugin.md`
  and does not contain raw secrets in the checked patterns.

## minimalFixScope

Evidence-only fix unless reviewers choose to clean the fixture wrapper string:

1. Add or amend a committed TODO16 code-quality/slop review artifact under
   `.omo/evidence/` that explicitly documents the remove-ai-slops and
   programming perspectives listed above, with the same artifact paths and
   test/check/manual QA evidence.
2. Optionally replace the fixture wrapper empty `catch {}` with a narrowed
   ENOENT handler inside the generated script string.
3. Rerun the focused test, no-excuse audit, and gate review.
