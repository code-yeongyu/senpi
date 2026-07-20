# packages/coding-agent/test

Vitest coverage for the Senpi CLI, sessions, extensions, modes, transports, and regressions. New default tests must be deterministic and must not spend tokens.

## STRUCTURE

```text
suite/             Preferred AgentSession/AgentSessionRuntime harness tests
suite/regressions/ Issue-specific regressions
mcp/               MCP transports, fixtures, security, lifecycle
permission/        Permission-system behavior
compaction/        Compaction mechanics and policy
session-manager/   Persistence, branching, context construction
dynamic-prompt/    Dynamic system-prompt + workstation fact coverage
tool-pair-guard/   Provider payload tool-pair sanitization tests
helpers/           Shared subprocess/QA/fixture helpers
manual-qa/         Explicit manual QA scripts (not part of default suite)
qa/app-server/     Real app-server surface drivers
integration/       Explicitly gated real-provider tests
fixtures/, goldens/ Shared deterministic inputs and snapshots
model-runtime*.test.ts / models-store.test.ts / remote-catalog-provider.test.ts / runtime-credentials.test.ts
                   Model/catalog/auth runtime coverage
```

## TEST RULES

- `test/setup.ts` quarantines `SENPI_CODING_AGENT_DIR` into a unique temp directory by default; preserve that isolation in all new tests.
- Model catalog refresh tests must stay mocked/offline; only `integration/` and `qa/` surfaces may use real credentials or incur network cost.
- Prefer `suite/harness.ts` and the faux provider for new lifecycle and extension coverage.
- Do not use real provider APIs, API keys, network calls, or paid tokens in default tests.
- Some legacy tests outside `integration/` still activate from ambient Anthropic credentials. Run the suite hermetically and do not copy that activation pattern into new tests.
- Use `suite/regressions/<issue>-<slug>.test.ts` for issue regressions.
- Do not extend the legacy `test-harness.ts` unless the preferred harness lacks a required capability.
- Keep fixtures deterministic, local, and secret-free. Spawned process tests must clean up children, sockets, and temporary directories.
- Tests involving PTY, MCP, app-server, or other subprocess-heavy surfaces must remain reliable with `CI=1`, where Vitest uses one fork.

## LIVE AND MANUAL SURFACES

- `integration/` is opt-in only with `PI_RUN_INTEGRATION=1`; it may use real credentials and incur cost.
- `qa/app-server/` contains focused real-surface drivers. The separate `npm run qa:app-server` command runs the packaged handshake, multiclient, approval, and real-client probes.
- Runtime changes covered here still require the repository's `senpi-qa` evidence gate when the root guide requires it.

## VALIDATION

- Run every added or changed test file directly until green.
- Run the narrow owning directory or package suite when shared harnesses, fixtures, or lifecycle behavior change.
- Root `npm run check` is static validation and does not replace tests.
