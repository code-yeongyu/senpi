# TODO27 code-quality and slop review

Scope reviewed:

- `packages/coding-agent/test/mcp/oauth-race.test.ts`
- `packages/coding-agent/test/mcp/fixtures/oauth-race-worker.ts`
- Existing fixture surface: `packages/coding-agent/test/mcp/fixtures/oauth-idp.ts`, `packages/coding-agent/test/mcp/fixtures/oauth-idp-core.ts`, `packages/coding-agent/test/mcp/fixtures/spawn-idp.ts`
- Existing auth lock surface: `packages/coding-agent/src/core/extensions/builtin/mcp/auth/oauth-refresh.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/auth/token-store.ts`

## Findings

- `any` / inline imports / non-erasable TS: PASS. No `any`, no inline or dynamic imports, no enum/namespace/parameter-property syntax added.
- Async error handling: PASS. Worker catches refresh errors and reports `oauthKind`; fixture cleanup remains bounded by process exit. No catch-swallow was added outside teardown-style cleanup.
- Secret logging: PASS. Worker stdout now emits `refreshHash` only. Local race artifacts contain request metadata and 16-character sha256 fingerprints, not raw sentinel refresh/access tokens.
- SDK usage: PASS. The race still drives `McpOAuthProvider`, `McpRefreshManager`, `McpTokenStore`, and the MCP TypeScript SDK OAuth functions rather than bypassing the real auth path.
- Dead config / fixture fields: PASS. `TODO27_RACE_ARTIFACT_DIR` is opt-in evidence output for the race test; all artifact fields are asserted or copied from observed worker/log/store state.
- Module LOC >250: JUSTIFIED EXISTING. `oauth-idp-core.ts` is 261 lines and was not expanded. It already centralizes OAuth fixture state/handlers for RFC metadata, DCR/CIMD, code+PKCE, client credentials, refresh rotation, and family invalidation; splitting it was not required for TODO27.
- Naming / convention drift: PASS. New names follow existing MCP/OAuth test style: `WorkerResult`, `tokenFingerprint`, `raceArtifacts`, `storeCleared`.
- Hollow / overfit tests: PASS. Assertions bind to binary observables: IdP token-hit deltas, family invalidation flag, worker process results, stored refresh-token fingerprint convergence, and store-cleared control state.
- TODO28 scope creep: PASS. No plan checkbox/ledger updates, no broad W3 e2e flow, no TUI/headless auth script beyond the required senpi-qa isolation receipts.

## Adversarial coverage

- malformed_input: existing fixture tests still cover no-S256 refusal and invalid refresh-token behavior through impacted auth tests.
- stale_state: lock-on proves one refresh request and shared store convergence; lock-off proves refresh-token reuse triggers family invalidation and clears the shared store.
- dirty_worktree: unrelated untracked `.omo/evidence/subagent-stop-*` files were not edited or staged.
- hung_or_long_commands: worker processes use a 20s `execFile` timeout; tests use 30s test timeouts; cleanup receipt records no live IdP pids and no temp agent dirs.
- flaky_tests: focused race and impacted auth test suites passed after final edits.
- misleading_success_output: local JSON artifacts carry request logs and worker/store observables; `.omo/evidence/task-27-senpi-mcp-plugin.log` carries command transcripts.
- prompt_injection: N/A; fixture data is protocol traffic and is not fed to prompts.
- cancel_resume/repeated_interruptions: N/A; this implementation was completed in one uninterrupted local turn.

## Residual risks

- The lock-off race can choose which worker sees `invalid_grant`; the test intentionally asserts the invariant (`some invalid_grant`, family invalidated, store cleared) rather than worker tag order.
- The cleanup receipt checks fixture pids and temp dirs after Vitest teardown. It does not prove arbitrary external processes are absent, only the fixture processes spawned by this run.
