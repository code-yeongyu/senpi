# Train-A panel-fix: make PR #142 (senpi-codemode) reliably green

Fixes the two verified blockers on the `feat/senpi-codemode` required check ("Check and test"),
plus the systemic subprocess-starvation root cause that made it flaky (4 of the 7 most recent
runs failed). All three changes were validated locally with Julia 1.12.6 present (so the
`hasJulia()`-gated jl-kernel test actually runs), which is the surface CI exercises.

## Blocker 1 — jl-kernel returns `{ok:false}` (codemode's own feature)

`test/jl-kernel.test.ts` sets `answer = 41` then evaluates `answer + 1`, asserting
`{ ok: true, valueRepr: "42" }`. On CI it returned `ok: false` (see `RED-ci-failures.txt`).

**Root cause (empirically confirmed):** `prelude.jl` opened with `using Base64`. On a cold
Julia depot (every fresh GitHub runner) the first `using Base64` triggers a **serial package
precompile** — measured here at **460–1268 ms of CPU/IO** (`base64-cold-precompile-timing.txt`).
Under an oversubscribed CI runner that spike balloons past the test's 8 s per-cell timeout. The
`SubprocessKernel` then fires its timeout, `restartProcess()` respawns a fresh Julia (losing the
`answer = 41` state), and the next cell (`answer + 1`) hits `UndefVarError` → `ok:false`. The two
prior fix attempts (`--compile=min`, Base-shadowing) reduced JIT cost but did **not** remove the
package-precompile spike, which is the only remaining cold-start precompile trigger (Sockets/Base
already ship in the sysimage).

**Fix:** `packages/senpi-codemode/src/kernels/jl/prelude.jl` — drop `using Base64`; hand-roll
`senpi_base64` against `Base` (qualified `Base.write`, per the runner's Main-shadowing policy).
Verified **byte-exact** against `Base64.base64encode` across empty / 1-2-3-byte remainders /
multibyte UTF-8 / control chars / 300-char / full 1..255 byte range (`GREEN-base64-byte-exact.txt`).
Kernel startup no longer precompiles anything → deterministic cold start. Full jl-kernel suite
green (`GREEN-jl-kernel.txt`).

## Blocker 2 — MCP keep-alive "condition timed out" (deterministic race)

`test/mcp/idle.test.ts` "keep-alive … recovers a killed fixture" flaked ~50%. **Root cause:** after
SIGKILL, the stdio transport's async `onclose` → `markDegraded` flips the connection off
`"connected"`, but that is NOT gated on the faked keep-alive interval. The test advances the faked
timer exactly once; if that single tick fires while still `"connected"`, `keepAlivePingOrRecover`
merely pings the dead server (no reconnect) and — with the interval faked and advanced once — never
retries → the recovery `waitFor` wedges.

**Fix:** wait for the state to leave `"connected"` before advancing the timer, so the single tick
deterministically takes the reconnect path. This is **byte-identical** to the same fix in the
cross-train "restore green main" PR #146 (`git hash-object` → `7055db8a7…`), so the two PRs
converge with zero conflict whichever lands first. This also **reverts** the branch's earlier
divergent timeout paper-over (120 s/25 s/60 s) back to main's values (60 s/10 s/20 s), removing the
inconsistent-tuning collision that was flagged between #142 and the shared MCP test files.
Local: 3/3 stable (`GREEN-keepalive-3x.txt`); full `test/mcp/` 28 files / 177 tests green.

## Systemic — CI-only vitest fork cap (the load root cause)

The coding-agent suite ran with the default forks pool (maxWorkers = CPU count = 4 on
`ubuntu-latest`). With multiple default-on builtins now spawning real child processes during the
parallel run (MCP fixtures, the terminal PTY builtin, and codemode's Julia/py/rb kernels), the
4-vCPU runner is oversubscribed and subprocess-lifecycle tests starve — the true driver behind the
intermittent idle/ping-on-call/eager-connect/kernel-startup timeouts. codemode's builtin adds the
most subprocess load, so #142's branch is the most susceptible.

**Fix:** `packages/coding-agent/vitest.config.ts` — `GITHUB_ACTIONS`-gated `{ pool: "forks",
maxWorkers: 2 }`. Halves peak concurrent subprocess-spawning test files on CI while keeping the
full local pool for developer speed. Vitest 4 API (top-level `maxWorkers`; `poolOptions` was
removed). `npm run check` (biome + tsgo + neo) passes, confirming the config is type-valid.

## Gates
- `npm run check` (biome --error-on-warnings, tsgo --noEmit, pinned-deps, ts-imports, shrinkwrap,
  install-lock, neo build+vet+test): PASS.
- No `packages/coding-agent/src/core/extensions/*` surface touched → no `changes.md` entry required.
