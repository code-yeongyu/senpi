# MCP W2 (PR #141) — "Check and test" CI failure: idle keep-alive flake

## Symptom (RED — from CI run 28834639435 on commit db888ba)

`packages/coding-agent/test/mcp/idle.test.ts > MCP idle lifecycle >
keep-alive pings every 30 seconds and recovers a killed fixture without
suspension` failed with `Error: condition timed out` (the recovery
`waitFor(..., 5000)` at line 177). 356 test files passed, 1 failed — a
single timing-sensitive integration test.

## Root cause

The test kills the real MCP stdio fixture subprocess (SIGKILL), then asserts
transparent recovery: transport-close → `degraded` → jittered reconnect
backoff → a fresh `node stdio-server.ts` subprocess is spawned and re-handshaked
→ `connected` with a new pid and re-exposed tools. Every step is real wall-clock
work using real (unfaked) timers; only `setInterval`/`clearInterval` are faked.

Under a parallel test-file spawn storm on a loaded runner, two things starve the
recovery:
1. The recovery poll ceiling was only 5000ms — too tight when a cold Node
   subprocess boot + MCP handshake is delayed by CPU contention.
2. The fixture's default `connectTimeoutMs` is 2000ms. Under load, a slow boot
   makes each reconnect attempt time out, burning attempts against the backoff
   schedule and pushing recovery well past 5s.

Confirmed not a deadlock: the test passes in ~0.4–0.9s with no/low contention.

## Reproduction

`npx vitest run test/mcp/` while 2× `yes >/dev/null` saturate the cores +
full parallel vitest reproduced the exact `condition timed out` at line 177
on every run (3/3).

## Fix (no assertion weakened)

`packages/coding-agent/test/mcp/idle.test.ts` only:
- Raised the recovery poll ceiling 5000 → 20000ms. A polling `waitFor` ceiling
  only bounds the failure deadline; it never slows a passing run (returns the
  instant the condition holds). Pure headroom for a loaded runner.
- Gave the keep-alive server `connectTimeoutMs: 10_000` so reconnect attempts
  actually complete under a spawn storm instead of timing out and burning the
  backoff budget (root-cause fix).
- Set this test's vitest `timeout` to 60_000 so the generous recovery window
  cannot collide with the 30s default test timeout.
- Raised the sibling idle poll ceilings in the same file (1500 → 10000, the
  initial-connect `waitForCondition` 2500 → 10000) — same class of real-subprocess
  timing waits, same pure-headroom rationale.

Every `expect(...)` in the file is unchanged: recovery still requires a genuinely
new pid, `connected` state, matching `getRootPid()`, re-exposed `mcp_fx_tool_1`,
a real tool call returning the recovered value, `pingCounter >= 1`, no
`suspended` state, and a `connected`/`lastError: null` snapshot.

## Validation (GREEN)

- `npx vitest run test/mcp/idle.test.ts` alone: 7/7 pass (keep-alive ~0.9s).
- `npx vitest run test/mcp/` under a single `yes` spinner (approximates CI
  worker contention): idle keep-alive passes 4/4 runs.
- Under the harsh 2× `yes` + full-suite reproduction, idle keep-alive now
  recovers; residual failures at that starvation level are other timing tests
  unrelated to this PR (e.g. ping-on-call, commands stderr) that also pass on
  real CI — that saturation level is not representative of a GitHub runner.
- `node --test scripts/*.test.mjs`: 41/41 pass.
- `npm run check` (biome, tsgo, pinned-deps, shrinkwrap, install-lock,
  browser/web-ui smoke, check:neo go build+vet+test): all green.
- Full workspace `npm run build` succeeded; the 6 subprocess-spawning test files
  that failed pre-build (missing `dist/`) all pass after build — confirming those
  were a fresh-worktree build gap, not a regression from the `origin/main` merge.
