# QA Harness Library

## OVERVIEW

Shared process, transport and scenario machinery; score 12, with high export density and more than 20 import-backed references to the core harness symbols.

## WHERE TO LOOK

| Concern | Module | Local detail |
|---|---|---|
| Brand/session isolation | `common.mjs` | `scrubSandboxEnv` removes inherited brand-prefix and session steering variables |
| Provider-key isolation | `mock-loop-support.mjs` | `hermeticEnv` removes `PROVIDER_ENV_KEYS`; it is separate from sandbox creation |
| Generic buffered RPC | `rpc-client.mjs` | `RpcClient` retains event history and correlates responses by id |
| Turn-scoped RPC waits | `rpc-qa-client.mjs` | `RpcQaClient.waitForEvent` accepts an `afterIndex` cursor |
| Alternate-worktree RPC | `target-rpc-client.mjs` | `TargetRpcClient` accepts `targetRoot`; events are `{ at, message }` |
| Additional mock models / retry settings | `mock-loop-support.mjs` | `writeMockModelsJson` writes sandbox models and optional settings |
| Full-stack SDK setup | `claude-sdk-oauth-fullstack-harness.mjs`, `claude-sdk-oauth-hermetic-env.mjs` | Real session stack with SDK interception and loopback-only traffic |
| Continuity expectations | `claude-sdk-oauth-matrix.mjs`, `claude-sdk-oauth-matrix-phases.mjs`, `claude-sdk-oauth-matrix-assert.mjs` | Runner, phase definitions and lineage/query assertions |
| Cache-warm RPC plus terminal proof | `cache-warm-ready-scenario.mjs`, `cache-warm-ready-rpc.mjs` | Shared scenario orchestration and RPC evidence extraction |
| TUI resume mechanics | `tui-resume-args.mjs`, `tui-resume-pty.mjs`, `tui-resume-signal.mjs`, `tui-resume-teardown.mjs` | Argument, terminal, signal and teardown boundaries |
| Sanitized diagnostic details | `output-safety.mjs` | `safeDetail` for probe verdict/error output |

## CONVENTIONS

- `makeSandbox()` pins HOME and USERPROFILE to the temporary directory and disables `SENPI_OMO_LOCAL_UPDATE`; preserve these alongside agent/session directory pins.
- For ordinary mock traffic, pass `hermeticEnv(box.env)` to the child. SDK probes use their stronger `applyHermeticEnvironment` / `assertHermeticEnvironment` pair.
- `spawnCli()` tracks the child but does not create a sandbox; callers supply the isolated env and cwd. `runCli()` also closes stdin for one-shot modes.
- RPC commands use `{ type, id?, ... }`; responses use `{ type: "response", command, success, data? | error }`, not JSON-RPC `method`/`params`.
- `RpcClient.waitForEvent` searches all buffered events; use a per-turn cursor with `RpcQaClient` when an old completion could satisfy the predicate.
- `TargetRpcClient.waitFor` is future-only and predicates receive its timestamped wrapper, unlike the other clients' raw events.
- Continuity phase skips carry reasons in `MATRIX_PHASES`; the matrix reports them separately from executed phases.
- Close resident SDK sessions before disposing the agent and removing its sandbox; the subprocess can otherwise recreate files during teardown.

## VALIDATION

- Unit coverage is `common.test.mjs` plus `tui-resume-{args,pty,signal}.test.mjs`; these are helper tests, not the channel QA suite.
- `common.mjs --self-check` and `fake-model-server.mjs --self-test` have explicit executable branches; ordinary library imports do not imply a self-test entry point.
- Check a shared-helper change through its consuming driver as well as its focused unit coverage; the library is not a workspace package.

## ANTI-PATTERNS

- Do not treat `PI_OFFLINE=1` or brand/session scrubbing as provider-credential removal.
- Do not let `spawnCli` fall back to its host env/cwd defaults in an isolated QA run.
- Do not reuse a prior turn's `agent_end` as proof that a newly submitted prompt completed.
- Do not register duplicate mock model ids; `writeMockModelsJson` rejects them before writing the fixture.
- Do not replace the SDK query boundary with a fake session: continuity assertions depend on observing the real resident and flattened paths.
