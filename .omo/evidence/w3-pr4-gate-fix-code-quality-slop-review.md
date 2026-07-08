# W3 PR4 Gate Fix - Code Quality And Slop Review

verdict: PASS

## Scope

Changed product/test surfaces:

- `packages/coding-agent/src/core/extensions/builtin/mcp/catalog.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/config-schema.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/session.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/health.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-exposure.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-register.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts`
- `packages/coding-agent/test/mcp/config.test.ts`
- `packages/coding-agent/test/mcp/fixtures/oauth-race-worker.ts`
- `packages/coding-agent/test/mcp/oauth-headless.test.ts`
- `packages/coding-agent/test/mcp/oauth-race.test.ts`

## Helper-Vs-Runtime Overclaim Fixed

Previous W3 evidence proved direct refresh-helper behavior and SDK fallback behavior, but not the shipped runtime path.

This fix changes both implementation and evidence shape:

- `connectAndRefreshMcpCatalog` now invokes the connection entry's refresh manager before real MCP HTTP connect/list surfaces.
- Generated MCP tool execution now invokes `ensureFresh` through the catalog entry before `ensureMcpToolCallConnection` and the real `client.callTool` path.
- The TODO27 worker no longer calls `McpRefreshManager.refresh()` directly; it creates a real `ServerConnection`, a real `McpConnectionEntry`, and drives `connectAndRefreshMcpCatalog`.
- The new runtime test asserts binary observables: IdP token endpoint hit deltas, token-family invalidation state, cached catalog contents, real tool result text, and concurrent real tool-call success.

## TDD Shape

RED artifact:

```text
local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/red-focused-tests.log
```

GREEN artifacts:

```text
local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/green-focused-tests.log
local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/required-focused-auth-suite-after-check.log
```

The RED failures were not import/type failures; they were behavior failures at the real config, renew, catalog, and connection-runtime surfaces.

## Slop Checks

- No deletion-only tests.
- No tests that merely assert a helper was called.
- No tautological mock-only refresh coverage.
- No weakening of the lock-off control; it still proves the no-lock disaster class by observing two token endpoint refresh attempts, family invalidation, and failed post-race runtime attempts.
- No product parsing/normalization was added beyond constraining `callbackPort` at the TypeBox boundary.
- No new broad abstraction; the refresh callback is threaded through existing catalog/direct-tool entry types.
- No real provider/API calls; senpi-qa used local fake model/MCP fixtures.
- No raw credential values are embedded in the new committed evidence report.

## Programming Checks

- `npm run check`: PASS, artifact `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/npm-run-check.log`.
- Required auth-focused Vitest suite: PASS, artifact `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/required-focused-auth-suite-after-check.log`.
- Pure LOC warning: `transport.ts` remains 249 pure LOC; touched runtime files stay below the project ceiling.
- No `any`, inline imports, non-erasable TypeScript syntax, or TypeScript suppression was introduced by the fix.

## Evidence Hygiene

The named stale artifacts from the QA review were sanitized and rescanned:

```text
local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/secret-scan-named-after.log
local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/secret-scan-named-filenames-after.log
local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/final-raw-token-scan.log
```

All scans report zero matches.
