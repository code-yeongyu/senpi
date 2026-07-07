# TODO14 Gate Review

recommendation: REJECT

## originalIntent

TODO 14 in `.omo/plans/senpi-mcp-plugin.md` asks for a disk-backed MCP metadata cache that registers cached tools without spawning MCP servers at startup, stores per-server metadata under the senpi agent directory, lazily connects on first cached tool execution, invalidates stale/bad cache entries, writes atomically, and is proven by focused tests plus manual QA.

## desiredOutcome

At commit `7dfb76a4ae8526acf5746bf4e2e45c08d03c8279`, a reviewer should be able to mark TODO14 complete because:

- `<agentDir>/cache/mcp-cache.json` is used, not hardcoded `~/.senpi`.
- Cache entries store `configHash`, `fetchedAt`, `tools`, `resources`, `prompts`, and `instructions` with a 7-day TTL.
- Writes use per-process tmp+rename atomic replacement.
- Warm cache startup registers tools with zero fixture spawn; first tool call connects and succeeds.
- Hash mismatch, TTL expiry, corrupt JSON, and concurrent writes are covered.
- Eager fresh-connect mismatch is implemented or explicitly deferred where the plan permits.
- Tests are behavioral, not tautological or implementation-mirroring.
- Manual QA proves warm cache, poisoned 999-tool cache, auth isolation, and cleanup.
- Evidence has no raw secrets and has reviewer-visible coverage.

## userOutcomeReview

The shipped code gives the user a working lazy warm-cache path for default/lazy MCP servers, and the focused test passes on the rebased commit. The user cannot safely mark TODO14 complete yet because two acceptance areas are not satisfied: eager lifecycle cache freshness is not implemented or tested, and the branch lacks the required TODO14 code-quality/slop review artifact. A direct programming pass also found a no-excuse TypeScript violation in production code.

## blockers

1. Eager fresh-connect/mismatch handling is missing.
   Evidence: TODO14 says "Must NOT: ... no cache for servers with `lifecycle:\"eager\"` fresh-connect result mismatch (post-connect diff -> refresh + rewrite cache)." Current `McpService.#syncFromConfig` reads any valid cache via `getValidCachedServer` and skips `#connectAndRefresh` whenever `cachedCatalog !== undefined` (`packages/coding-agent/src/core/extensions/builtin/mcp/service.ts:173`, `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts:188`). No branch checks `server.config.lifecycle`, and `rg` found no TODO14 test for `lifecycle: "eager"`.

2. Direct programming/no-excuse pass fails.
   Evidence command:
   `NODE_PATH=/Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w2/node_modules npx tsx /Users/yeongyu/.agents/skills/programming/scripts/typescript/check-no-excuse-rules.ts <changed TODO14 ts files>`
   Result: `packages/coding-agent/src/core/extensions/builtin/mcp/catalog-cache.ts:37:18: [no-unknown-assertion] as unknown`. This violates the loaded `programming`/TypeScript criteria.

3. Required TODO14 code-review/slop report coverage is absent.
   Evidence: `find .omo/evidence ...` found `todo-11-code-quality-slop-review.md`, `todo-12-code-quality-slop-review.md`, and `todo-13-code-quality-slop-review.md`, but no TODO14 equivalent. `rg "remove-ai-slops|AI SLOP|overfit|programming"` found no TODO14 review report. The gate criteria require a report that explicitly covers remove-ai-slops overfit/slop and programming checks; absence is a rejection condition.

4. Existing manual QA evidence is not post-rebase reviewer-visible enough.
   Evidence: `.omo/evidence/task-14-stop-hook-verification*.log` records old commit `2965d60ad`, while current HEAD is `7dfb76a4`. `git show -s --format=%T` differs between those commits, and `git diff 2965d60ad..HEAD -- packages/coding-agent/src/core/extensions/builtin/mcp` shows rebase-introduced changes in adjacent MCP files (`commands.ts`, `connection.ts`). I reran the focused test on `7dfb76a4`, but not the manual QA driver. The raw QA artifacts under `local-ignore/` are ignored and the `.log` evidence is ignored by `*.log`.

## checked artifact paths

- `.omo/plans/senpi-mcp-plugin.md`
- `/Users/yeongyu/local-workspaces/research/senpi-mcp-plugin-research/02-senpi-mcp-plugin-spec.md`
- `/Users/yeongyu/local-workspaces/research/senpi-mcp-plugin-research/01-comparison.md`
- `packages/coding-agent/src/core/extensions/builtin/mcp/catalog-cache.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/catalog.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-snapshot.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-types.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/session.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/status.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/instructions.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/status.ts`
- `packages/coding-agent/test/mcp/catalog-cache.test.ts`
- `.omo/evidence/task-14-senpi-mcp-plugin.log`
- `.omo/evidence/task-14-stop-hook-verification.log`
- `.omo/evidence/task-14-stop-hook-verification-2.log`
- `.omo/evidence/task-14-stop-hook-verification-3.log`
- `local-ignore/qa-evidence/20260706-mcp-w2/INDEX.md`
- `local-ignore/qa-evidence/20260706-mcp-w2/warm-observables.json`
- `local-ignore/qa-evidence/20260706-mcp-w2/poison-observables.json`
- `local-ignore/qa-evidence/20260706-mcp-w2/isolation-receipt.json`
- `local-ignore/qa-evidence/20260706-mcp-w2/cleanup-receipt.json`
- `local-ignore/qa-evidence/20260706-mcp-w2/warm-rpc-events.jsonl`
- `local-ignore/qa-evidence/20260706-mcp-w2/warm-rpc-responses.jsonl`
- `local-ignore/qa-evidence/20260706-mcp-w2/poison-rpc-events.jsonl`
- `local-ignore/qa-evidence/20260706-mcp-w2/poison-rpc-responses.jsonl`
- `local-ignore/qa-evidence/20260706-mcp-w2/warm-model-requests.json`

## verification

- `git diff origin/main...HEAD` and `git show --stat HEAD`: TODO14 diff is one commit, 11 files, 548 insertions and 92 deletions.
- Focused test on current rebased HEAD:
  `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/catalog-cache.test.ts`
  Result: 5 tests passed.
- Pure LOC check: all changed TODO14 source/test files are under 250 pure LOC; `service.ts` is 239, `expose/register.ts` is 172, test is 150.
- Evidence hygiene scan: no raw auth token was found in the checked artifacts; `warm-model-requests.json` has `"authorization": "<mock-redacted>"`. It does contain full system prompt/AGENTS/skills content, so it should remain ignored or be sanitized before committing.

## evidenceGaps

- No TODO14-specific code-quality/slop review report with remove-ai-slops and programming coverage.
- No post-rebase manual QA evidence tied to current commit `7dfb76a4`.
- No provided notepad path.
- No explicit manual QA matrix beyond the brief `INDEX.md`; the raw observables support warm/poison/auth/cleanup, but the matrix does not map every TODO14 acceptance item, especially eager lifecycle freshness.

## followUpEvidenceCommitDecision

Bulky raw QA under `local-ignore/qa-evidence/20260706-mcp-w2/` can remain ignored for W2 PR preparation if the PR body cites paths and summarizes sanitized outcomes. However, a follow-up evidence commit is required before approval for a reviewer-readable TODO14 `.md` report covering code-quality/slop/programming checks and post-rebase verification. The existing `.log` files are ignored and pre-rebase, so they cannot be the only durable evidence.

## exactFixScope

- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`: when `server.config.lifecycle === "eager"` and cache exists, perform the planned eager fresh connect and refresh/rewrite on mismatch instead of indefinitely trusting the cached catalog. If intentionally deferred, amend the plan/design authority explicitly; current TODO14 text does not permit the deferral.
- `packages/coding-agent/test/mcp/catalog-cache.test.ts`: add a behavioral regression for eager cached startup where the cache differs from the fresh server catalog and verify the cache refresh/rewrite path.
- `packages/coding-agent/src/core/extensions/builtin/mcp/catalog-cache.ts`: remove the `as unknown` no-excuse violation at line 37, e.g. by assigning `JSON.parse` to an `unknown` variable without an assertion or by parsing through the project/schema boundary.
- `.omo/evidence/todo-14-code-quality-slop-review.md` or equivalent: add committed reviewer-readable evidence that explicitly covers remove-ai-slops overfit/slop criteria, programming/no-excuse results, tests, manual QA, and residual risk after the fix.
