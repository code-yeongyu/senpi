# W3 PR#4 Rereview Code-Quality Fix

DoneClaim: fixed terminal OAuth refresh failures for startup/catalog refresh, `McpService.attachSession`, and manual reconnect so invalid/rotated refresh credentials now produce `needs_auth` state plus `/mcp auth-start <server>` guidance instead of bypassing the auth state.

## Scope

- Worktree: `/Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w3`
- Branch: `code-yeongyu/senpi-mcp-plugin-w3`
- Base HEAD before work: `e1ab175f957815ab2cdcf357b9f8127a0f80f578`
- Final commit hash: recorded in the final response after commit creation; this report is included in that commit.

## Changed Files

- `packages/coding-agent/src/core/extensions/builtin/mcp/health.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/reconnect.ts`
- `packages/coding-agent/test/mcp/oauth-headless.test.ts`
- `packages/coding-agent/test/mcp/fixtures/oauth-race-worker.ts`
- `.omo/evidence/w3-pr4-rereview-code-quality-fix.md`

## Fix

- Shared the existing terminal OAuth-to-headless guidance conversion as `markMcpConnectionNeedsAuth`.
- `connectAndRefreshMcpCatalog` now marks terminal refresh failures as `needs_auth` and throws guidance.
- Startup callers (`attachSession` and startup race) suppress that expected `needs_auth` rejection so session startup remains alive and snapshots/status can show guidance.
- Reconnect pre-renew refresh now throws the same guidance for manual reconnect while preserving the `needs_auth` state, and reconnect fallback no longer overwrites it as generic `degraded`.
- Race worker test fixture unwraps OAuth kind through `cause` so the cross-process invalidation proof still observes `invalid_grant` beneath the guidance error.

## RED Evidence

Scenario: invalid/rotated refresh credentials through `connectAndRefreshMcpCatalog`, `McpService.attachSession`, and manual reconnect.

Invocation:
`cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/oauth-headless.test.ts`

Observable:
- `connectAndRefreshMcpCatalog` threw raw `OAuthFlowError: invalid_grant`.
- `attachSession` rejected from startup refresh.
- `reconnectServer("fix")` rejected without `/mcp auth-start fix`.

Artifact:
`local-ignore/qa-evidence/20260708-w3-pr4-rereview-code-quality-fix/red-oauth-headless.log`

## GREEN Evidence

Scenario: touched regression file after the fix.

Invocation:
`cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/oauth-headless.test.ts`

Observable:
`Test Files 1 passed (1)`, `Tests 13 passed (13)`.

Artifact:
`local-ignore/qa-evidence/20260708-w3-pr4-rereview-code-quality-fix/green-oauth-headless-v2.log`

Scenario: focused W3 auth/config suite requested by the task, rerun after `npm run check`.

Invocation:
`cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/oauth-headless.test.ts test/mcp/config.test.ts test/mcp/oauth-race.test.ts test/mcp/oauth-callback.test.ts test/mcp/oauth-provider.test.ts test/mcp/auth-modes.test.ts test/mcp/token-store.test.ts`

Observable:
`Test Files 7 passed (7)`, `Tests 59 passed (59)`.

Artifact:
`local-ignore/qa-evidence/20260708-w3-pr4-rereview-code-quality-fix/focused-w3-auth-suite-after-check.log`

Scenario: full repository check.

Invocation:
`npm run check`

Observable:
check exited 0; `biome check`, pinned deps, import checks, shrinkwrap/install-lock checks, `tsgo --noEmit`, browser smoke, web UI check, and `check:neo` all passed. Biome formatted one touched file before the final focused-suite rerun.

Artifact:
`local-ignore/qa-evidence/20260708-w3-pr4-rereview-code-quality-fix/npm-run-check.log`

## Manual QA

Scenario: data-shaped real MCP service surface for startup and reconnect with poisoned refresh credentials.

Invocation:
`npx tsx /tmp/w3-pr4-manual-qa.ts`

Observable:
- Startup result: `lifecycleState: "needs_auth"`, `guidanceVisible: true`, `registeredTools: []`, `storeCleared: true`.
- Reconnect result: `lifecycleState: "needs_auth"`, `guidanceVisible: true`, `snapshotGuidanceVisible: true`, `storeCleared: true`.
- Reconnect message included `/mcp auth-start fix`.

Artifact:
`local-ignore/qa-evidence/20260708-w3-pr4-rereview-code-quality-fix/manual-mcp-auth-guidance.log`

Scenario: senpi QA real CLI mock-loop, isolated from real auth.

Invocation:
`node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test --evidence w3-pr4-rereview-code-quality-fix-mock-loop`

Observable:
`mock-loop.mjs --self-test: 5/5 passed`; real auth unchanged at `/Users/yeongyu/.senpi/agent/auth.json`.

Artifact:
`local-ignore/qa-evidence/20260708-w3-pr4-rereview-code-quality-fix/senpi-qa-mock-loop.log`

## Adversarial Classes Covered

- Revoked/rotated refresh token before catalog refresh.
- Revoked/rotated refresh token during `McpService.attachSession`.
- Revoked/rotated refresh token during manual reconnect.
- Cross-process refresh race still detects `invalid_grant` under the guidance wrapper.
- Existing no-token headless auth and successful runtime refresh coverage stayed green.

## Secret Scan

Invocation:
`rg -n -i 'sk-[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9._~+/-]{20,}|SENTINEL_(AT|RT)_[A-Za-z0-9]+|token[=:][A-Za-z0-9._~+/-]{12,}' local-ignore/qa-evidence/20260708-w3-pr4-rereview-code-quality-fix .omo/evidence/w3-pr4-rereview-code-quality-fix.md`

Result: `match_count=0`.

Artifact:
`local-ignore/qa-evidence/20260708-w3-pr4-rereview-code-quality-fix/secret-scan.log`

## Cleanup Receipt

- Temporary manual QA script `/tmp/w3-pr4-manual-qa.ts`: removed.
- Debug journal `.debug-journal.md`: removed from the W3 worktree and from the original default workspace after the patch-tool path correction.
- QA processes/tmux: no task-created tmux sessions remained; one pre-existing `ulw-dr` tmux session from July 6 was left untouched.
- Ports 9229/9230: no listeners.
- `git diff --check -- packages/coding-agent/src/core/extensions/builtin/mcp packages/coding-agent/test/mcp .omo/evidence/w3-pr4-rereview-code-quality-fix.md`: passed with no output.
- Git status: expected modified fix/test files and this new report only, plus unrelated pre-existing untracked rereview reports.

## Remaining Risk

- The guidance wrapper intentionally preserves the original OAuth failure as `cause`; callers that only inspect top-level error class now see `AuthError` guidance. The updated race fixture proves the original terminal kind remains available through the cause chain.
