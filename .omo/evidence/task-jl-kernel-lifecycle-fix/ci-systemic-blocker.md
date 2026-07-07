# CI status after the jl-kernel fix: green, then a cross-train subprocess-load flake

## What is fixed (train-a scope, DONE)
- `jl-kernel` "Kernel is closed" root cause (Julia 1.12 Base-shadowing + `SubString` typing) — fixed in `packages/senpi-codemode/src/kernels/jl/runner.jl`. Deterministic locally: 8/8 stress + full codemode suite 77/77 with Julia 1.12.6 present.
- PROOF IT WENT GREEN ON CI: commit `eb5986b63` (jl-kernel fix + the `mcp/idle` headroom bump, merged up to origin/main tip `466eee61d`) — **"Check and test" = SUCCESS** (run 28867967206).

## What is now blocking (NOT a train-a source defect)
The pre-merge convention required merging the newest `origin/main`, which had advanced to `8b62b3498` = train-b's **PR #144 persistent-terminal builtin** (`terminal`, default-on, spawns PTY subprocesses across the coding-agent test run). After that merge (`fd1c1fe57`), "Check and test" flakes across MULTIPLE subprocess-timing-sensitive tests on the same run:
- `test/mcp/idle.test.ts` — "condition timed out" (even with connectTimeoutMs 25s / waitFor 60s; it is starvation, not tight timeouts).
- `test/mcp/ping-on-call.test.ts` — `AssertionError: expected 3 to be 2` (an extra renewal/ping fired under load).
- `test/jl-kernel.test.ts` — a DIFFERENT, load-induced failure (synthetic `{ok:false,error,durationMs}` exit result, NOT the fixed Base-shadowing crash) i.e. Julia was starved/killed under load.

Runs 28868894186 (initial + rerun) both failed on ≥2 of these simultaneously.

## Why this is external / systemic
- `mcp/idle` and `mcp/ping-on-call` are train-c (MCP W1/W2) code, untouched by the jl-kernel fix. Both flake on `origin/main` itself (identical commit `466eee61d`, failing run 28853684404).
- The coding-agent vitest run uses the default forks pool (workers = CPU count, no cap). As multiple trains' default-on builtins accumulate in the loader (codemode, then terminal), each spawning real subprocesses during the parallel test run, the CI runner is oversubscribed and the fixture/kernel subprocesses starve.
- The trigger for the regression from green→flaky was purely the `terminal` merge (added subprocess load), not any source change in this branch.

## In-scope mitigation applied
- `packages/senpi-codemode/src/kernels/jl/kernel.ts`: launch Julia with `--compile=min --optimize=0` (interpreter, minimal JIT). Same cell results (verified 6/6 locally), but a much smaller memory/CPU spike so the kernel is far less likely to be OOM/CPU-starved on a loaded runner. This hardens the jl-kernel surface (HANDOVER fact #5) without touching other trains.

## Needs cross-train ownership (out of train-a scope)
Making "Check and test" reliably green under the current default-on-builtin load requires a shared decision, e.g. capping coding-agent vitest fork concurrency (`poolOptions.forks.maxForks`) or isolating the subprocess-lifecycle MCP tests, plus hardening `mcp/ping-on-call`'s attempt-count assertion. These touch train-c / shared CI infra and should not be papered over unilaterally from a train-a panel-fix.
