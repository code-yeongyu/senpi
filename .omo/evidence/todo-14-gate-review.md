# TODO14 Gate Re-review

recommendation: APPROVE

## originalIntent

TODO14 in `.omo/plans/senpi-mcp-plugin.md` asks for a disk-backed MCP metadata
cache under the senpi agent directory. The cache must let cached tools register
at startup without spawning MCP servers, lazy-connect on first cached tool call,
invalidate bad/stale/mismatched entries, persist complete server metadata, write
atomically, and be proven with focused tests plus real-surface QA.

## desiredOutcome

At `d19163bce5f6fbcbd8ba3a6e84a192f5bd9fde06`, the orchestrator should be able
to mark TODO14 complete when the diff, tests, QA evidence, and slop/no-excuse
review show:

- `<agentDir>/cache/mcp-cache.json` is used via `getAgentDir()` / `CONFIG_DIR_NAME`
  behavior, with no hardcoded `~/.senpi`.
- Cache entries store `configHash`, `fetchedAt`, `tools`, `resources`, `prompts`,
  and `instructions`, with a 7-day TTL.
- Writes are tmp-file-plus-rename atomic writes with process-unique temp names.
- Warm-cache startup registers tools without fixture spawn, then first call
  lazy-connects and returns the real fixture result.
- TTL expiry, corrupted JSON, config hash mismatch, eager warm-cache mismatch,
  and concurrent writers are behaviorally covered.
- No no-excuse TypeScript violations remain.
- Manual QA proves warm and poisoned-cache behavior, auth isolation, and cleanup,
  with bulky raw artifacts ignored and a committed sanitized summary.

## userOutcomeReview

The shipped artifact satisfies the user-visible TODO14 outcome. Lazy/default MCP
servers can start from a valid cache without spawning the fixture, registered
cached tools call through to the real MCP server on first execution, poisoned or
stale cache entries are rebuilt, and eager servers now connect and refresh the
cache even when a valid warm cache exists. The previous blockers are resolved.

TODO14 can be marked complete.

## blockers

None.

## directEvidence

- Branch/head/base verified:
  `code-yeongyu/senpi-mcp-plugin-w2` at
  `d19163bce5f6fbcbd8ba3a6e84a192f5bd9fde06`; merge-base with `origin/main` is
  `9b1c2b775c7305c05c2913bd43be001914e4feac`.
- `packages/coding-agent/src/core/extensions/builtin/mcp/catalog-cache.ts`
  defines `getMcpCatalogCachePath(agentDir = getAgentDir())` as
  `join(agentDir, "cache", "mcp-cache.json")`; `getAgentDir()` falls back to
  `join(homedir(), CONFIG_DIR_NAME, "agent")`.
- `catalog-cache.ts` stores `configHash`, `fetchedAt`, `tools`, `resources`,
  `prompts`, and `instructions`; `getValidCachedServer` rejects mismatched hashes
  and entries older than `7 * 24 * 60 * 60 * 1000`.
- `atomicWriteJson` creates the parent directory, writes
  `<path>.<pid>.<randomUUID>.tmp`, then renames it into place.
- `service.ts` calls `#connectAndRefresh` when `cachedCatalog === undefined` or
  `server.config.lifecycle === "eager"`, resolving the eager fresh-connect cache
  mismatch blocker from the previous gate.
- `catalog-cache.test.ts` covers warm-cache zero-spawn/lazy-call, TTL rebuild,
  corrupted JSON rebuild, hash mismatch/poison rejection, eager warm-cache
  mismatch refresh/rewrite, and concurrent writer parseability.
- `local-ignore/qa-evidence/20260707-mcp-w2-todo14-fix/warm-observables.json`
  shows `spawnBeforeCall: null`, `spawnAfterCall: 1`,
  `statusMentionsCached: true`, `statusMentionsConnected: true`, and
  `modelSawFixtureResult: true`.
- `local-ignore/qa-evidence/20260707-mcp-w2-todo14-fix/poison-observables.json`
  shows the poisoned cache was rewritten to the expected config hash and
  `fakeToolPresentAfter: false`.
- `local-ignore/qa-evidence/20260707-mcp-w2-todo14-fix/isolation-receipt.json`
  shows `authUnchanged: true`; `cleanup-receipt.json` records sandbox cleanup and
  fake model server stop.
- `.omo/evidence/todo-14-code-quality-slop-review.md` is committed and gives a
  sanitized reviewer-readable summary of fix scope, TDD red/green, no-excuse,
  root check, manual QA, overfit/scope/type-safety, and residual risk.

## verification

- Focused regression rerun:
  `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/catalog-cache.test.ts`
  passed: 1 test file, 6 tests.
- No-excuse rerun across all 11 changed TypeScript files under the MCP scope:
  `No violations in 11 file(s).`
- Root check rerun:
  `npm run check` exited 0. Biome reported `No fixes applied`; pinned deps,
  TS import checks, shrinkwrap/install-lock checks, `tsgo --noEmit`, browser/web
  UI checks, and `check:neo` all passed.
- `git diff --check` reported no whitespace errors.
- Pure LOC pass: all changed source/test files are below the 250 pure-LOC defect
  threshold. `service.ts` is in the warning band at 241 pure LOC, but no blocker
  applies for this review.

## slopAndOverfitReview

Direct remove-ai-slops/programming pass found no unresolved blocker:

- No excessive, deletion-only, tautological, or requested-removal-only tests.
- New eager mismatch regression is behavioral: it uses a valid warm cache with a
  stale tool list, asserts one live fixture spawn, rejects the stale cached tool,
  registers the fresh live tools, and verifies cache rewrite.
- Existing cache tests assert observable effects: spawn counter absence/presence,
  registered tool names, real fixture tool result, parseable rewritten JSON, and
  poisoned tool absence.
- No test special-cases implementation private state beyond the cache file that
  is the TODO14 artifact itself.
- No unnecessary production extraction was introduced by the fix commit; the
  earlier service type/snapshot extraction keeps `service.ts` under the 250-LOC
  defect threshold and is not behavior-changing.
- No no-excuse `as unknown`, `as any`, `@ts-ignore`, `@ts-expect-error`,
  non-null assertion, enum, or mutable export violation was reported.

## checkedArtifactPaths

- `.omo/plans/senpi-mcp-plugin.md`
- `.omo/evidence/task-14-gate-review.md`
- `.omo/evidence/todo-14-code-quality-slop-review.md`
- `.omo/evidence/task-14-senpi-mcp-plugin.log`
- `.omo/evidence/task-14-stop-hook-verification.log`
- `.omo/evidence/task-14-stop-hook-verification-2.log`
- `.omo/evidence/task-14-stop-hook-verification-3.log`
- `local-ignore/qa-evidence/20260706-mcp-w2/INDEX.md`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo14-fix/INDEX.md`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo14-fix/warm-observables.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo14-fix/poison-observables.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo14-fix/isolation-receipt.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo14-fix/cleanup-receipt.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo14-fix/warm-rpc-events.jsonl`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo14-fix/poison-rpc-events.jsonl`
- `packages/coding-agent/src/config.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/catalog-cache.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/catalog.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/session.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/status.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/instructions.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-snapshot.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-types.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/status.ts`
- `packages/coding-agent/test/mcp/catalog-cache.test.ts`

## exactEvidenceGaps

No blocking evidence gaps remain.

Notes:

- `.omo/evidence/task-14-gate-review.md` is the prior rejected gate report and is
  untracked in this worktree, so it was treated as historical evidence only.
- Bulky raw QA files under `local-ignore/` are intentionally ignored. They include
  full prompt/request material and redacted mock authorization, so the committed
  `.omo/evidence/todo-14-code-quality-slop-review.md` is the reviewer-readable
  secret-safe summary.
