# packages/coding-agent/test

Vitest coverage for the Senpi CLI, sessions, extensions, modes, transports, and regressions. New default tests must be deterministic and must not spend tokens.

## STRUCTURE

```text
suite/             Preferred AgentSession/AgentSessionRuntime harness tests (own AGENTS.md)
suite/regressions/ Issue-specific regressions (own AGENTS.md)
mcp/               MCP transports, fixtures, security, lifecycle (own AGENTS.md)
permission/        Permission-system behavior (own AGENTS.md)
compaction/        Compaction mechanics and policy (own AGENTS.md)
session-manager/   Persistence, branching, context construction
dynamic-prompt/    Dynamic system-prompt + workstation fact coverage
tool-pair-guard/   Provider payload tool-pair sanitization tests
client/            RPC/app-server client coverage
server/            App-server/server surface coverage
extensions/        Extension loading and API behavior
cursor-cli-oauth/  Cursor CLI OAuth provider-lane coverage (own AGENTS.md)
tool-search/       Shared tool-catalog / `tool_search` exposure coverage
grok/              Grok provider coverage
ttsr/              Stream-rule (ttsr) extension coverage
support/           Shared test support modules
helpers/           Shared subprocess/QA/fixture helpers
benchmarks/        Perf-oriented probes (not part of the default correctness gate)
examples/          Coverage for the shipped `examples/` extensions
manual-qa/         Explicit manual QA scripts (not part of default suite)
qa/app-server/     Real app-server surface drivers (own AGENTS.md)
integration/       Explicitly gated real-provider tests
fixtures/, goldens/ Shared deterministic inputs and snapshots
model-runtime*.test.ts / models-store.test.ts / remote-catalog-provider.test.ts / runtime-credentials.test.ts
                   Model/catalog/auth runtime coverage
claude-sdk-oauth-*.test.ts
                   Flat cluster (51 files) at test/ root covering the Claude SDK
                   OAuth provider extension
```

The flat `test/*.test.ts` root cluster (~350 files) is legacy/feature-focused placement.
New lifecycle and extension coverage belongs in `suite/`, not at this root.
Legacy root helpers: `test-harness.ts` (superseded), `utilities.ts`, `model-runtime-test-utils.ts`,
`test-network-env.ts`, `test-theme-colors.ts`. `setup.ts` is the quarantine entry (see below).

## TEST RULES

- `test/setup.ts` quarantines `SENPI_CODING_AGENT_DIR` into a unique temp directory on every run; preserve that isolation in all new tests. See the QUARANTINE CONTRACT below for the load-bearing reason the guard always wins.
- Model catalog refresh tests must stay mocked/offline; only `integration/` and `qa/` surfaces may use real credentials or incur network cost.
- Prefer `suite/harness.ts` and the faux provider for new lifecycle and extension coverage.
- Do not use real provider APIs, API keys, network calls, or paid tokens in default tests.
- Some legacy tests outside `integration/` still activate from ambient Anthropic credentials. Run the suite hermetically and do not copy that activation pattern into new tests.
- Use `suite/regressions/<issue>-<slug>.test.ts` for issue regressions.
- Do not extend the legacy `test-harness.ts` unless the preferred harness lacks a required capability.
- Keep fixtures deterministic, local, and secret-free. Spawned process tests must clean up children, sockets, and temporary directories.
- Tests involving PTY, MCP, app-server, or other subprocess-heavy surfaces must remain reliable with `CI=1`, where Vitest uses one fork.

## QUARANTINE CONTRACT (load-bearing)

`test/setup.ts` resolves the agent directory through `test/support/quarantine.ts`'s `resolveQuarantineAgentDir`, then calls `scrubAmbientAgentDirEnv` to delete the brand marker (`SENPI_BRAND`) and **every** `*_CODING_AGENT_DIR` lane before pinning the quarantined `SENPI_CODING_AGENT_DIR`. The quarantine **always wins** over any inherited agent-dir env, opting out only with an explicit `SENPI_TEST_USE_REAL_AGENT_DIR=1` paired with the target dir. This is not a courtesy — it is a safety boundary.

- The omo launcher (`omo-ai/bin/lib/launcher.js` → `senpiEnvironment`) sets `OMO_CODING_AGENT_DIR`, `SENPI_CODING_AGENT_DIR`, and `SENPI_BRAND` for **every** spawned child session, and tool children inherit all three. Any `vitest` run launched from inside an omo agent session inherits values pointing at the user's REAL `~/.omo/agent`.
- Guarding only the `SENPI_` lane is not enough: with the omo brand active, `brandEnvNames` resolves `OMO_CODING_AGENT_DIR` first, so `getAgentDir()` bypassed the quarantine and `settings-tips.test.ts` wiped the live `~/.omo/agent/settings.json` again on 2026-08-25 (reproduced pre-fix against a decoy dir; post-fix the decoy stays intact). The scrub of all lanes plus the brand marker is what closes this; never narrow it back to a single-lane guard, and never reintroduce an `if (!process.env.SENPI_CODING_AGENT_DIR)` short-circuit here.
- Before this guard always won, an inherited env made the whole suite run against the real config and tests deleted `~/.omo/agent/settings.json` (proven live 2026-08-18: favorite-guard ENOENT crashes matched suite-run windows exactly).
- To target a specific real directory in a test, pass the agent dir explicitly to `SettingsManager.create` / `SessionManager.create` rather than relying on the ambient env. Use `SENPI_TEST_USE_REAL_AGENT_DIR=1` only for the rare whole-suite opt-in.
- Tests that spawn the CLI as a subprocess must set `SENPI_CODING_AGENT_DIR` to a temp dir in the child env explicitly (see `test/helpers/rpc-hermetic.ts`); never let the child inherit an unguarded ambient value.

## LIVE AND MANUAL SURFACES

- `integration/` is opt-in only with `PI_RUN_INTEGRATION=1`; it may use real credentials and incur cost.
- `qa/app-server/` contains focused real-surface drivers. The separate `bun run qa:app-server` command runs the packaged handshake, multiclient, approval, and real-client probes.
- Runtime changes covered here still require the repository's `senpi-qa` evidence gate when the root guide requires it.

## VALIDATION

- Run every added or changed test file directly until green.
- Run the narrow owning directory or package suite when shared harnesses, fixtures, or lifecycle behavior change.
- Package runner is Vitest: `bun run --cwd packages/coding-agent test --run <path>`.
- Root `bun run check` is static validation and does not replace tests.

---
Generated: 2026-08-24 | Commit: `baf15a54d`
