# jl-kernel "Kernel is closed" CI failure — root cause and fix

## Symptom (CI, PR #142)
Run https://github.com/code-yeongyu/senpi/actions/runs/28864219645 (commit 4cde4aefb):
`FAIL test/jl-kernel.test.ts > JuliaKernel > persists state, displays last expression, and calls one host tool through the bridge` — `Error: Kernel is closed` at `src/kernels/shared/subprocess-kernel.ts:65` (the `run()` guard), thrown from `test/jl-kernel.test.ts:59` (the SECOND `run`). 1 failed / 76 passed.

## Not flaky — deterministic on Julia 1.12
Reproduced locally with Julia 1.12.6, installed via juliaup: the live test fails 100% of the time (pre-fix). The apparent "green→red across an evidence-only delta" (prior tip eba4b3509 SUCCESS) is explained by the GitHub-hosted runner image's Julia: the suite gates the live test on `hasJulia()` (`it.skipIf(!hasJulia())`). CI does not pin/setup Julia (no `julia` reference in `.github/workflows/`). When the runner image carried no/old Julia the live test was skipped (SUCCESS); once the runner image exposed a Julia that runs it, both latent runner.jl bugs below fired. The evidence-only commit did not change source/tests — the runner image did.

## Root causes (two latent bugs in `src/kernels/jl/runner.jl`)
1. **Base shadowing.** `prelude.jl` intentionally defines Main-level `write`/`read`/`print`/`display`/`log` helpers for user cell code, which shadow `Base.*` inside `Main`. Runner *infrastructure* called the unqualified, now-shadowed names:
   - `senpi_escape` → `write(out::IOBuffer, c::Char)` → `MethodError: no method matching write(::IOBuffer, ::Char)` (only `Main.write(::AbstractString, ::Any)` exists). This crashes Julia on the very FIRST `senpi_emit` (the `ready` message), so the process dies before running any cell. The host's `SubprocessKernel` exit handler then resolves the in-flight "set" run as a synthetic failure (test line 58 has no assertion, so it passes), sets `closed=true`, and the next `run()` (line 59) throws "Kernel is closed" — exactly the CI signature.
   - `senpi_call_tool` → `write(socket, request)` and `read(socket, String)` — same shadowing, would crash the tool-call path.
   Fix: qualify runner-infra calls as `Base.write` / `Base.read`. The prelude helpers still shadow for user cells (intended).
2. **Over-strict `::String` signatures.** `split(response, "\r\n\r\n"; limit=2)` returns `SubString{String}`, but `senpi_parse_string`/`senpi_parse_bool`/`senpi_parse_json_value`/`senpi_parse_error_message` were typed `line::String` → `MethodError` on the HTTP tool-call reply. Masked on CI because bug #1 crashed first. Fix: loosen to `AbstractString`.

## Verification (Julia 1.12.6 present — same shape as CI runner)
- RED (`red.txt`): pre-fix, `1 failed | 2 passed`; direct runner drive shows `MethodError write(::IOBuffer, ::Char)`, exit code 1.
- GREEN (`green.txt`): post-fix, `test/jl-kernel.test.ts` 3 passed; full `senpi-codemode` suite 15 files / 77 tests passed (previously 76/77).
- Stress: `test/jl-kernel.test.ts` run 8x consecutively → 8 pass / 0 fail (no residual flake).
- `runner-fix.diff`: the exact source change (Base-qualification + AbstractString).

Only `src/kernels/jl/runner.jl` changed (15 +/12 -). No `packages/coding-agent/src/core/extensions/*` touched, so the changes.md convention does not apply.
