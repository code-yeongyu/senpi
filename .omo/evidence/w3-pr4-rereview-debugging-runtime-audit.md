# W3 PR#4 Rereview Debugging Runtime Audit

Worktree: `/Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w3`
Branch/HEAD: `code-yeongyu/senpi-mcp-plugin-w3` @ `e1ab175f957815ab2cdcf357b9f8127a0f80f578`
Diff audited: `origin/main...HEAD`
Runtime: Node v26.0.0, npm 11.12.1, tsx 4.22.1, vitest 4.1.9

## Method

Required debugging references read before runtime checks:

- `/Users/yeongyu/.agents/skills/debugging/references/runtimes/node.md`
- `/Users/yeongyu/.agents/skills/debugging/references/methodology/00-setup.md`
- `/Users/yeongyu/.agents/skills/debugging/references/methodology/02-investigate.md`
- `/Users/yeongyu/.agents/skills/debugging/references/methodology/08-qa.md`
- `/Users/yeongyu/.agents/skills/debugging/references/methodology/09-cleanup.md`

Temporary debug journal was created, then removed before verdict.

## Hypotheses And Results

1. Refresh manager exists but production runtime never calls it.
   - Distinguishing checks:
     - Source wiring: `resolveServerAuth()` returns `refresh: new McpRefreshManager(provider)` in `packages/coding-agent/src/core/extensions/builtin/mcp/auth/context.ts`.
     - Startup/catalog path calls `entry.authPlan?.refresh?.ensureFresh()` before `connection.connect()` in `packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts`.
     - Direct tool registration passes `ensureFresh` into catalog tool entries in `packages/coding-agent/src/core/extensions/builtin/mcp/service-register.ts`.
     - Tool execution calls `ensureMcpToolCallConnection(entry.connection, entry.ensureFresh)` in `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts`.
     - Runtime test `oauth-headless.test.ts` has `refreshes near-expiry OAuth tokens through the real catalog and tool runtime path`.
   - Verdict: ruled out. The focused runtime test passed and asserted token refresh on catalog connect and once across two concurrent tool calls.

2. Auth guidance is lost on degraded/suspended renew path.
   - Distinguishing checks:
     - `health.ts` converts `needs_auth` from connect/renew/ensureFresh into `headlessAuthError()`.
     - Error text includes `/mcp auth-start <server>` and `/mcp auth-complete <server> <redirect-url>`.
     - Runtime test `oauth-headless.test.ts` has `reports the headless auth-start flow when degraded renew hits OAuth needs_auth`.
   - Verdict: ruled out. The focused runtime test passed and matched `/mcp auth-start fix`.

3. Config accepts invalid `callbackPort` or production runtime ignores the configured value.
   - Distinguishing checks:
     - Schema constrains `oauth.callbackPort` with `Type.Integer({ minimum: 0, maximum: 65_535 })` in `config-schema.ts`.
     - Runtime test `config.test.ts` rejects `callbackPort: 65_536`.
     - Runtime test `oauth-callback.test.ts` asserts `runAuth` uses a fixed callback port in `redirect_uri`, the port is open during auth, and the flow stores a token.
     - Runtime test `oauth-callback.test.ts` asserts a busy fixed port fails before opening a browser.
   - Verdict: ruled out. The focused runtime test passed all config and callback-port cases.

4. OAuth refresh errors silently preserve a connected-looking state or swallow transient/terminal failures.
   - Distinguishing checks:
     - `oauth-refresh.ts` clears credentials on `invalid_grant` and throws terminal `OAuthFlowError`.
     - `oauth-refresh.ts` preserves credentials on exhausted transient token errors and throws non-terminal retriable `OAuthFlowError`.
     - Runtime tests in `oauth-provider.test.ts` assert both branches.
   - Verdict: ruled out for the audited branch. Tests passed and the error branches are typed/actionable, not silent success.

5. Token-store concurrency is only unit-tested but real worker/process path still races or corrupts tokens.
   - Distinguishing checks:
     - `oauth-race.test.ts` spawns two separate Node worker processes via `fixtures/oauth-race-worker.ts`.
     - The lock-on case asserts exactly one token request, no family invalidation, and matching rotated refresh token fingerprints.
     - The lock-off control asserts the disaster case: two or more token requests, family invalidation, and `invalid_grant`.
   - Verdict: ruled out. The cross-process race test passed.

## Exact Runtime Invocations

### Focused MCP OAuth Runtime Tests

Surface: Node/TypeScript vitest runtime under `packages/coding-agent`.

Invocation:

```bash
cd /Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w3/packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/oauth-headless.test.ts test/mcp/oauth-callback.test.ts test/mcp/config.test.ts test/mcp/oauth-provider.test.ts test/mcp/oauth-race.test.ts
```

Observed output:

```text
Test Files  5 passed (5)
Tests  39 passed (39)
Duration  4.61s
```

### Agent/MCP Mock Loop

Surface: real senpi agent loop from source with sandbox MCP stdio fixture and mock model server.

Invocation:

```bash
cd /Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w3
node .agents/skills/senpi-qa/scripts/mock-loop.mjs --with-mcp-tool mcp_fx_tool_1 --tool-args '{"value":"runtime-audit"}'
```

Observed output:

```text
[PASS] CLI completed the multi-step loop — code=0
[PASS] two model turns served (loop iterated) — requests=2
[PASS] requested MCP fixture tool exists, executed, and fed result back to model — callLog=yes modelSawFixtureResult=true
[PASS] final assistant text returned
[PASS] real auth unchanged — /Users/yeongyu/.senpi/agent/auth.json
mock-loop.mjs --with-mcp-tool mcp_fx_tool_1 (openai-completions): 5/5 passed
```

### Source Wiring Check

Surface: production source and test references.

Invocation:

```bash
cd /Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w3
rg -n "ensureFresh|McpRefreshManager|callbackPort|headlessAuthError|runAuth uses the configured fixed callback port|degraded renew|real catalog and tool runtime path|cross-process refresh race|token refresh failed transiently|invalid_grant" packages/coding-agent/src/core/extensions/builtin/mcp packages/coding-agent/test/mcp
```

Observed values:

```text
packages/coding-agent/src/core/extensions/builtin/mcp/auth/context.ts:60:return { mode, provider, refresh: new McpRefreshManager(provider) };
packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts:34:await entry.authPlan?.refresh?.ensureFresh();
packages/coding-agent/src/core/extensions/builtin/mcp/service-register.ts:28:ensureFresh: () => entry.authPlan?.refresh?.ensureFresh().then(() => undefined) ?? Promise.resolve(),
packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts:106:await ensureMcpToolCallConnection(entry.connection, entry.ensureFresh);
packages/coding-agent/src/core/extensions/builtin/mcp/health.ts:176:function headlessAuthError(connection: ServerConnection, cause?: unknown): AuthError {
packages/coding-agent/src/core/extensions/builtin/mcp/config-schema.ts:18:callbackPort: Type.Optional(Type.Integer({ minimum: 0, maximum: 65_535 })),
packages/coding-agent/test/mcp/oauth-headless.test.ts:223:it("reports the headless auth-start flow when degraded renew hits OAuth needs_auth", async () => {
packages/coding-agent/test/mcp/oauth-headless.test.ts:251:it("refreshes near-expiry OAuth tokens through the real catalog and tool runtime path", async () => {
packages/coding-agent/test/mcp/oauth-callback.test.ts:200:it("runAuth uses the configured fixed callback port for a pre-registered client", async () => {
packages/coding-agent/test/mcp/oauth-race.test.ts:128:describe("cross-process refresh race", () => {
```

## manualQa

### surfaceEvidence

| scenario id | criterion reference | surface | exact invocation | verdict | artifactRefs |
|---|---|---|---|---|---|
| S1 | H1/H2/H3/H4/H5 focused runtime regression | `packages/coding-agent` vitest MCP auth/runtime tests | `npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/oauth-headless.test.ts test/mcp/oauth-callback.test.ts test/mcp/config.test.ts test/mcp/oauth-provider.test.ts test/mcp/oauth-race.test.ts` | PASS | A1 |
| S2 | End-to-end agent/MCP turn without paid tokens | `senpi-qa` mock loop with MCP stdio fixture | `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --with-mcp-tool mcp_fx_tool_1 --tool-args '{"value":"runtime-audit"}'` | PASS | A1 |
| S3 | Production call-site mapping | source/test grep | `rg -n "ensureFresh|McpRefreshManager|callbackPort|headlessAuthError|runAuth uses the configured fixed callback port|degraded renew|real catalog and tool runtime path|cross-process refresh race|token refresh failed transiently|invalid_grant" packages/coding-agent/src/core/extensions/builtin/mcp packages/coding-agent/test/mcp` | PASS | A1 |

### adversarialCases

| scenario id | criterion reference | adversarial class | expected behavior | verdict | artifactRefs |
|---|---|---|---|---|---|
| A-H1 | Refresh manager dead-code risk | near-expiry token on catalog/tool path | production path refreshes before catalog connect and tool call; concurrent tool calls coalesce to one refresh | PASS | A1 |
| A-H2 | degraded/suspended renew loses auth guidance | degraded connection renew hits OAuth needs_auth | thrown tool error contains `/mcp auth-start fix` guidance | PASS | A1 |
| A-H3 | invalid or ignored callback port | `callbackPort: 65_536`; fixed valid port; busy fixed port | invalid config rejected; valid configured port appears in `redirect_uri`; busy port fails before browser open | PASS | A1 |
| A-H4 | terminal/transient refresh failure silently succeeds | invalid refresh token and transient token endpoint failure | `invalid_grant` clears credentials and is terminal; transient failure preserves refresh token and is non-terminal/retriable | PASS | A1 |
| A-H5 | cross-process refresh race | two OS workers refresh same token family simultaneously | lock-on makes one token request and converges; lock-off control invalidates the family | PASS | A1 |

### artifactRefs

| id | kind | description | path |
|---|---|---|---|
| A1 | report | This audit report containing command invocations, observed outputs, source mappings, manual QA matrix, cleanup receipt, and verdict. | `/Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w3/.omo/evidence/w3-pr4-rereview-debugging-runtime-audit.md` |

## Cleanup Receipt

Invocation:

```bash
rm -f .debug-journal.md
exclude_path=$(git rev-parse --git-path info/exclude)
if [ -f "$exclude_path" ]; then perl -0pi -e 's/^\.debug-journal\.md\n//mg; s/\n\.debug-journal\.md\n/\n/mg' "$exclude_path"; fi
test -e .debug-journal.md && echo present || echo absent
if [ -f "$exclude_path" ] && grep -qx '.debug-journal.md' "$exclude_path"; then echo yes; else echo no; fi
tmux ls 2>/dev/null | rg -n 'debug|w3-pr4|runtime-audit' || true
lsof -iTCP:9229 -sTCP:LISTEN -nP 2>/dev/null || echo free
lsof -iTCP:9230 -sTCP:LISTEN -nP 2>/dev/null || echo free
git status --short | sed -n '1,120p'
```

Observed cleanup state:

```text
debug_journal=absent
exclude_has_journal=no
tmux_debug_sessions=
port_9229=free
port_9230=free
```

Git dirt note: product source/test paths under `packages/coding-agent/src/core/extensions/builtin/mcp` and `packages/coding-agent/test/mcp` had no working-tree dirt from this audit. The worktree already contained many untracked `.omo/evidence/*` files before this audit; this run added only this report path.

## Verdict

PASS. All required runtime failure hypotheses were checked against actual code and executable runtime surfaces. No blocker found.

<verdict>PASS</verdict>
