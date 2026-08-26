# scripts/qa-app-server

Real-surface QA harness for app-server. `npm run qa:app-server` runs `run-all.mjs`, which executes handshake, multiclient, approval-roundtrip, real-client, and real-client-sweep probes against the locally built CLI. `differential/` is the source-oracle parity harness referenced by `src/modes/app-server/AGENTS.md`. 27 standalone `.mjs` files, ~3.5k LOC. Score 15 — own driver/oracle/compare stack, no other directory owns this surface.

## STRUCTURE

```text
run-all.mjs               orchestrator — the npm script entry
handshake.mjs, multiclient.mjs, approval-roundtrip.mjs,
real-client.mjs, real-client-sweep.mjs   packaged probes
lib/                      shared spawn/env/rpc/cleanup helpers
                          (run-node.mjs, env.mjs, fake-model.mjs, rpc.mjs,
                          cleanup.mjs + two vitest-runnable *.test.mjs)
differential/             source-vs-oracle parity harness: driver.mjs (RawWebSocketDriver),
                          run.mjs, build-oracle.mjs, compare.mjs, normalize.mjs, diff.mjs,
                          cell.mjs, readiness.mjs, transcript-validation.mjs, allowlist.json
```

## CONVENTIONS

- All probes spawn the repo-local CLI with explicit env overrides from `lib/env.mjs`: temp `SENPI_CODING_AGENT_DIR`, `PI_OFFLINE=1`, ports drawn from the fixed `qaPortRange` (18990-18999). Never hardcode other ports.
- Temp state via `mkdtempSync`; `lib/cleanup.mjs` tracks and reaps spawned process groups (`cleanupAllAndWait`) — probe exit must not leak children.
- Differential scenarios run through `differential/driver.mjs` / `run.mjs`, never as individual node invocations; scenario bodies live in `test/qa/app-server/differential/`.
- `build-oracle.mjs` cargo-builds `codex-app-server` from a local codex-rs checkout (`ORACLE_MANIFEST` pins the path); without that checkout only the senpi side runs.
- `allowlist.json` (`rules: []`) gates accepted parity gaps; the allowlist may never hide audience, frame-order, or array-order differences.
- `lib/*.test.mjs` run under the package Vitest config (node:test-style asserts inside `test()`), skipped on win32 where process-group semantics differ.

## ANTI-PATTERNS

- Running a differential scenario file directly instead of through the driver.
- Adding an allowlist rule to absorb a real ordering/audience divergence — that is a wire defect.
- Spawning with fully inherited env — the explicit overrides in `lib/env.mjs` are load-bearing for hermetic QA.
