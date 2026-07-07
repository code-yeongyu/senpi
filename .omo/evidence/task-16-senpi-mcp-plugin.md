# TODO16 Ping-on-call revalidation + in-place renewal

## Changed surface

- `packages/coding-agent/src/core/extensions/builtin/mcp/connection.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/health.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts`
- `packages/coding-agent/test/mcp/ping-on-call.test.ts`
- `packages/coding-agent/test/mcp/fixtures/options.ts`
- `packages/coding-agent/test/mcp/fixtures/sdk-server.ts`
- `packages/coding-agent/test/mcp/fixtures/stdio-server.ts`

## RED

Command:

```bash
cd /Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w2/packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/ping-on-call.test.ts
```

Result before production changes: failed as expected.

- `skips ping for calls inside the 30 second success window`: missing `ping-count.txt`
- `coalesces concurrent stale-call pings without sharing per-call arguments`: missing `ping-count.txt`

Raw capture: `.omo/evidence/task-16-senpi-mcp-plugin-red.log`

## GREEN tests

Focused:

```bash
cd /Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w2/packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/ping-on-call.test.ts
```

Result: 1 file passed, 4 tests passed.

Raw capture: `.omo/evidence/task-16-senpi-mcp-plugin-green-focused.log`

Impacted MCP regression set after `npm run check` formatting:

```bash
cd /Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w2/packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/ping-on-call.test.ts test/mcp/register-call.test.ts test/mcp/catalog-cache.test.ts
```

Result: 3 files passed, 17 tests passed.

Raw capture: `.omo/evidence/task-16-senpi-mcp-plugin-green-impacted-after-check.log`

## Repository check

```bash
cd /Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w2
npm run check
```

Result: passed. Biome formatted changed files; package checks, tsgo, browser smoke, web-ui check, and neo build/vet/test passed.

Raw capture: `.omo/evidence/task-16-senpi-mcp-plugin-npm-check.log`

## Manual QA

Command:

```bash
cd /Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w2
node /tmp/todo16-mcp-manual-qa.mjs
```

Result: 7/7 checks passed through the real source CLI in RPC mode with a localhost fake model and isolated sandbox auth/config.

Evidence directory: `local-ignore/qa-evidence/20260706-mcp-w2-todo16/`

Key artifacts:

- `manual-qa.log`: command output and pass/fail checks.
- `happy-summary.json`: killed fixture renewed in place, pid changed `24974 -> 24983`, second fixture payload reached the model-visible session entries.
- `happy-rpc-events.jsonl`: real RPC session event transcript.
- `happy-model-requests.json`: fake model requests; auth headers sanitized.
- `failure-summary.json`: invalid-command renewal attempted exactly once (`attempts=2`) and returned model-visible `ToolExecError` while RPC stayed alive.
- `failure-rpc-events.jsonl`: real RPC failure-path transcript.
- `failure-model-requests.json`: fake model requests; auth headers sanitized.
- `auth-isolation.json`: real `~/.senpi/agent/auth.json` hash unchanged.
- `cleanup-receipt.json` and `cleanup-receipt.txt`: fixture pids dead, temp sandboxes removed, `/tmp/todo16-mcp-manual-qa.mjs` removed, no fixture process leftovers.

## Residual risks

- TODO19 `maybeStdioErr` is not implemented, so the bounded failure message is typed but not enriched with recovered stderr.
- Keep-alive/background polling remains intentionally absent for TODO18.
