# W3 PR4 TODO23/TODO27/TODO28 Superseding Addendum

verdict: PASS

This addendum supersedes prior W3 helper-only refresh evidence for TODO23, TODO27, and TODO28.

## TODO23 Runtime Refresh Addendum

Previous blocker: the refresh manager existed but was not invoked by production MCP runtime paths.

Current proof:

- `connectAndRefreshMcpCatalog` invokes `authPlan.refresh.ensureFresh()` before real connect/list/catalog refresh.
- Generated direct MCP tools carry `ensureFresh` from `McpConnectionEntry` to `McpToolCatalogEntry`.
- Tool execution invokes `ensureFresh` before connection validation and real `client.callTool`.
- Terminal refresh errors now mark `needs_auth` and surface headless `/mcp auth-start <server>` guidance.

Runtime scenario:

- Test: `packages/coding-agent/test/mcp/oauth-headless.test.ts`
- Case: `refreshes near-expiry OAuth tokens through the real catalog and tool runtime path`
- Observable: first catalog path increments the fixture token endpoint exactly once; two concurrent real tool calls share one refresh and both return fixture tool text.
- Artifact: `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/green-focused-tests.log`

## TODO27 Runtime Race Addendum

Previous blocker: race proof workers called the refresh manager directly.

Current proof:

- Worker: `packages/coding-agent/test/mcp/fixtures/oauth-race-worker.ts`
- The worker now constructs a real `ServerConnection`, `McpConnectionEntry`, and drives `connectAndRefreshMcpCatalog`.
- Lock-on observable: exactly one token endpoint refresh for two OS processes, same refresh-token fingerprint convergence, family not invalidated.
- Lock-off control observable: two or more token endpoint refresh attempts, family invalidation, and failed post-race runtime attempts.

Artifacts:

```text
local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/green-focused-tests.log
local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/required-focused-auth-suite-after-check.log
```

## TODO28 QA Addendum

Previous blocker: TODO28 evidence overclaimed runtime refresh and stale evidence hygiene.

Current proof:

- Required focused auth suite passed after repo check: `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/required-focused-auth-suite-after-check.log`.
- `npm run check` passed: `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/npm-run-check.log`.
- Real senpi mock loop passed with provider env vars stripped: `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/senpi-qa-mock-loop-self-test.log`.
- Real senpi MCP fixture loop passed: `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/senpi-qa-mock-loop-mcp-tool.log` and `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix-mcp/`.
- Named stale evidence content scan passed: `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/secret-scan-named-after.log`.
- Named stale evidence filename scan passed: `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/secret-scan-named-filenames-after.log`.
- Final raw credential value/header scan passed: `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/final-raw-token-scan.log`.
- Final cleanup receipt: `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/cleanup-receipt-final.log`.

## Current Git Status Evidence

Before this addendum was written, tracked status and diff were captured at:

```text
local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/git-status-before-evidence.log
```

Final clean tracked status is recorded after commits in the DoneClaim.

## Residual Risk

- Historical W3 evidence files remain useful as old audit trail only. Reviewers should treat this addendum and `w3-pr4-gate-fix-refresh-runtime.md` as the current gate evidence for runtime refresh behavior.
- The final gate should rerun the focused auth suite and senpi-qa commands listed above rather than relying on older helper-only Step 4/7 claims.
