# W3 PR4 Gate Fix - Runtime Refresh Evidence

verdict: PASS
worktree: `/Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w3`
branch: `code-yeongyu/senpi-mcp-plugin-w3`
baseHeadAtStart: `508691db3cd7f184b6557316369ce3ca97f90d37`

## Fix Summary

Production MCP OAuth refresh is now wired through real runtime paths:

- `connectAndRefreshMcpCatalog(entry, config)` calls `entry.authPlan.refresh.ensureFresh()` before HTTP connect and catalog listing.
- Direct/cached MCP tool entries carry `ensureFresh`, and generated tool execution calls it before connection validation and `client.callTool`.
- Service reconnect calls the refresh manager before renewal/catalog refresh.
- Degraded/suspended renewal failures that require auth are converted into the same headless `/mcp auth-start` guidance used by initial connect.
- OAuth `callbackPort` config is constrained to integer TCP port range `0..65535`.

## RED

Surface: production-path MCP OAuth runtime regressions.

Invocation:

```text
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/oauth-headless.test.ts test/mcp/config.test.ts test/mcp/oauth-race.test.ts
```

Artifact:

```text
local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/red-focused-tests.log
```

Observed RED failures:

- invalid `callbackPort` was accepted by config loading;
- degraded renew auth failure surfaced `ConnectError: ... Unauthorized` instead of `/mcp auth-start` guidance;
- real catalog/tool runtime produced zero token refresh calls for near-expiry credentials;
- cross-process race workers using the real connection/catalog runtime produced zero refresh calls before wiring.

## GREEN

Surface: same focused regression set after implementation.

Invocation:

```text
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/oauth-headless.test.ts test/mcp/config.test.ts test/mcp/oauth-race.test.ts
```

Artifact:

```text
local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/green-focused-tests.log
```

Observed:

```text
Test Files  3 passed (3)
Tests  22 passed (22)
```

## Required Focused Suite

Invocation:

```text
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/config.test.ts test/mcp/oauth-provider.test.ts test/mcp/oauth-callback.test.ts test/mcp/oauth-headless.test.ts test/mcp/auth-modes.test.ts test/mcp/oauth-race.test.ts test/mcp/token-store.test.ts
```

Artifact:

```text
local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/required-focused-auth-suite-after-check.log
```

Observed:

```text
Test Files  7 passed (7)
Tests  56 passed (56)
```

## Repo Check

Invocation:

```text
npm run check
```

Artifact:

```text
local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/npm-run-check.log
```

Observed:

- `biome check --write --error-on-warnings .` completed and formatted touched files;
- shrinkwrap/install-lock checks passed;
- `tsgo --noEmit` passed;
- browser/web-ui checks passed;
- `check:neo` build/vet/test passed.

## Manual QA

Scenario: real senpi CLI mock loop with provider env vars stripped.

Invocation:

```text
env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u GOOGLE_API_KEY -u XAI_API_KEY -u GROQ_API_KEY -u TOGETHER_API_KEY -u MISTRAL_API_KEY -u DEEPSEEK_API_KEY -u OPENROUTER_API_KEY node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test
```

Artifact:

```text
local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/senpi-qa-mock-loop-self-test.log
```

Observed: `mock-loop.mjs --self-test: 5/5 passed`; localhost fake model only; real auth unchanged.

Scenario: real senpi CLI MCP fixture loop.

Invocation:

```text
env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u GOOGLE_API_KEY -u XAI_API_KEY -u GROQ_API_KEY -u TOGETHER_API_KEY -u MISTRAL_API_KEY -u DEEPSEEK_API_KEY -u OPENROUTER_API_KEY node .agents/skills/senpi-qa/scripts/mock-loop.mjs --with-mcp-tool mcp_fx_tool_1 --tool-args '{"value":"w3-refresh-runtime"}' --evidence w3-pr4-gate-fix-mcp
```

Artifacts:

```text
local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/senpi-qa-mock-loop-mcp-tool.log
local-ignore/qa-evidence/20260708-w3-pr4-gate-fix-mcp/
```

Observed: `5/5 passed`; MCP fixture tool existed, executed, and was fed back to the model; real auth unchanged.

## Hygiene And Cleanup

Artifacts:

```text
local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/secret-scan-named-after.log
local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/secret-scan-named-filenames-after.log
local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/final-raw-token-scan.log
local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/artifact-sizes.log
local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/cleanup-receipt.log
local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/cleanup-receipt-final.log
```

Observed:

- named failed evidence content scan: `verdict=PASS match_count=0`;
- named failed evidence filename scan: `verdict=PASS filename_match_count=0`;
- final raw credential value/header scan: `verdict=PASS match_count=0`;
- all primary artifacts are non-empty.
- no QA-owned processes were left running; the only tmux session observed was pre-existing and unrelated to this task.

## Residual Risk

- The older W3 local evidence bundles remain historical; this report and the addendum supersede their helper-only refresh claims.
- `transport.ts` remains at 249 pure LOC, so future MCP transport changes should split responsibilities before adding more behavior there.
