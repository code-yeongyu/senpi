# TODO 11 code quality and slop review

timestamp_utc: 2026-07-06T12:33:00Z
scope: TODO 11 gate-blocker fix only
verdict: pass

## Files reviewed

- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/session.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/status.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/status.ts`
- `packages/coding-agent/test/mcp/exposure-policy.test.ts`

## Pure LOC

Measured with:

```bash
for f in <touched files>; do awk 'NF && $1 !~ /^[[:space:]]*\/\// { count++ } END { print count+0 }' "$f"; done
```

Results in `local-ignore/qa-evidence/20260706-mcp-w1-task11/pure-loc-after-fix.txt`:

- `service.ts`: 242 pure LOC, below 250.
- `expose/session.ts`: 31 pure LOC, below 250.
- `expose/status.ts`: 34 pure LOC, below 250.
- `status.ts`: 48 pure LOC, below 250.
- `exposure-policy.test.ts`: 103 pure LOC, below 250.

## remove-ai-slops perspective

- Excessive/useless/deletion-only tests: no. The test change is one focused regression in an existing TODO 11 test file; it fails before the production fix and passes after it.
- Tautological tests: no. The regression observes the external fake `ExtensionAPI` active tool state and `setActiveTools` calls, not private implementation details.
- Implementation-mirroring tests: no. The assertion is on user-visible active-tool pruning for stale MCP tools; it does not duplicate the policy loop.
- Unnecessary production extraction/normalization: no. The extraction is required to resolve the pure-LOC blocker and keeps cohesive behavior grouped as session registration and exposure status helpers.
- Scope drift: no. Static scan found no TODO 13, W2, BM25, `mcp_search`, OAuth, resources/prompts, or proxy implementation. The only scope scan matches are existing `pending-W4` assertions in the TODO 11 exposure tests.
- Deletion-only behavior: no. No functionality was removed; service still exposes the same public methods and delegates existing status/registration behavior.

## programming perspective

- Banned TypeScript patterns: scan found no `any`, `as any`, `as unknown`, `@ts-ignore`, `@ts-expect-error`, inline/dynamic imports, `enum`, `namespace`, or parameter-property patterns in touched files.
- Inline imports: none.
- Type escapes: none.
- Hardcoded paths: none in touched production/test files.
- Erasable TypeScript syntax: touched files use interfaces, imports, classes already present, and functions only; no non-erasable TS constructs added.
- API guessing: no external API changes; helpers reuse existing `collectToolCatalog`, `computeMcpExposurePolicy`, and `registerMcpCatalogTools` contracts.

## Evidence quality

- RED artifact: `local-ignore/qa-evidence/20260706-mcp-w1-task11/red-stale-active-cleanup.txt` proves the stale-active regression failed before the production fix.
- GREEN artifact: `local-ignore/qa-evidence/20260706-mcp-w1-task11/green-exposure-policy.txt` proves the focused exposure-policy test passes after the fix.
- Regression batch: `local-ignore/qa-evidence/20260706-mcp-w1-task11/mcp-regression-batch.txt` proves adjacent MCP register/call, command, and lifecycle tests pass.
- Root check: `local-ignore/qa-evidence/20260706-mcp-w1-task11/npm-run-check-fix.txt` proves full repo checks pass.
- Manual QA: `local-ignore/qa-evidence/20260706-mcp-w1-task11/manual-exposure-status-fix.txt` proves `/mcp status` include-filter and zero-match hint behavior on the real extension runtime path.
- QA isolation: `local-ignore/qa-evidence/20260706-mcp-w1-task11/senpi-qa-common-self-check-fix.txt` proves the QA harness sandbox and real auth guard work.
- Cleanup: `local-ignore/qa-evidence/20260706-mcp-w1-task11/cleanup-receipt-fix.txt` shows no leftover fixture processes and notes the pre-existing `ulw-dr` tmux session.

## Residual risks

- The fix intentionally does not implement TODO 13, W2, W4, docs, or PR work.
- The stale-active regression covers zero-match include filters; explicit `exposure: "search"` with no `directTools` remains covered indirectly by the same empty-active cleanup path because the registration helper is now invoked even when the active entry set is empty.
