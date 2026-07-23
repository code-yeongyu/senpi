# packages/senpi-codemode

`@code-yeongyu/senpi-codemode` is a source-only Senpi extension that registers
the persistent-kernel `eval` tool for JavaScript, Python, Ruby, and Julia, plus
the GPT-only `exec`/`wait` JavaScript Code Mode surface.

## STRUCTURE

```text
src/index.ts                     Extension factory: registers baseline eval, re-registers at session_start after runtime resolution, re-registers on model_select when active model changes
src/codemode/                    GPT exec/wait cell lifecycle, nested-tool bridge, and public schemas
src/prompt/                      Model-aware eval prompt templates and batching dialect selection
src/config/                      Settings schema, defaults, env overrides
src/extension/                   Session generations and kernel ownership
src/tool/                        Eval schema, cell execution, status events, rendering
src/kernels/js/                  Worker-backed persistent JavaScript kernel
src/kernels/py/                  Python process and transport
src/kernels/rb/, kernels/jl/     Optional subprocess kernels
src/kernels/shared/              Shared subprocess lifecycle and queues
src/bridge/                      Loopback bearer-auth protocol and server
src/bridges/                     Host adapters for agent(), output(), structured schemas
src/output/                      OutputSink, truncation metadata, artifact-path handling
src/completion/                  Host completion bridge
src/timeouts/                    Bridge and idle-timeout ownership
scripts/qa-*.ts                  Direct kernel, extension, and renderer QA drivers
test/                            Vitest contracts and the omp parity ledger
```

## INVARIANTS

- `eval` is registered at extension load and re-registered at `session_start`
  after settings, interpreter availability, and active task-tool names resolve.
- `exec`/`wait` are active only for GPT models. Their short-lived JavaScript
  workers compose active tools as `tools.<name>(args)` and are independent from
  eval's persistent language kernels.
- Eval prompt dialect is selected from the active model id; host/workstation context is explicit; renderer/status semantics are structured.
- Session generations fence old kernels and callbacks. A retired generation
  must not emit into a newer session.
- Kernels persist state per language, while per-cell callbacks are rebound for
  each execution.
- Every cell settles exactly once across success, error, timeout, abort, bridge
  failure, and kernel crash.
- Timeout and abort cleanup retires child work before ownership is released.
- The host bridge binds loopback only, requires a per-session bearer token,
  limits request bodies, and aborts work on disconnect.
- `agent()` and `output()` use configured active tool names through
  `pi.executeTool`. Do not import an orchestration workspace package here.
- `local://` resolves under the extension-owned session artifact root. Spill
  notices contain plain absolute paths, not a custom URI scheme.
- Status events stay structured from kernel protocol through `EvalToolDetails`
  and render output. Preserve agent-progress coalescing semantics.
- Optional interpreters are capability gaps, not installation failures;
  JavaScript remains available on supported Node versions.
- This package targets Node 24 or newer. Do not introduce Bun-only APIs,
  `@oh-my-opencode` imports, or a `budget` helper.

## WHERE TO LOOK

| Task | Path |
| --- | --- |
| Register or narrow eval | `src/index.ts`, `src/tool/eval-tool.ts` |
| GPT Code Mode lifecycle | `src/codemode/runtime.ts`, `src/codemode/tools.ts` |
| Prompt behavior | `src/prompt/eval-prompt.ts` |
| Call/result rendering | `src/tool/render.ts` |
| Cell settlement and output | `src/tool/cell-handler.ts`, `src/output/` |
| Session and kernel ownership | `src/extension/session-manager.ts`, `src/index.ts` |
| Bridge auth and protocol | `src/bridge/` |
| Agent/output task composition | `src/bridges/` |
| JavaScript lifecycle and imports | `src/kernels/js/` |
| Subprocess lifecycle | `src/kernels/shared/` and each language directory |
| Status and TUI/HTML rendering | `src/tool/status-events.ts`, `src/tool/render.ts` |
| Real-surface QA | `scripts/qa-*.ts` |
| Port coverage mapping | `test/PARITY.md` |

## QUALITY GATES

- Add or update a focused Vitest contract before changing runtime behavior; run
  it red, then green.
- Run `npm test` from this package and `npm run check` from the repository root
  before committing code or packaging changes.
- Run the relevant `scripts/qa-*.ts` driver when changing a kernel, bridge,
  extension lifecycle, output sink, or renderer. Capture evidence without
  tokens, headers, cookies, or raw environment dumps.
- Keep TypeScript erasable and strict: no `any`, assertions, non-null
  assertions, ignored diagnostics, or dynamic imports outside documented
  boundaries.
- Keep renderer imports out of `src/output/`; output collection is a runtime
  layer and must not create a renderer dependency cycle.
- Direct dependencies are exact-pinned. Refresh locks with
  `npm install --ignore-scripts`; use `PI_ALLOW_LOCKFILE_CHANGE=1` only when the
  lockfile policy permits the intentional change.
- Documentation must describe the current tool contract. Update README settings
  and helper tables with every user-visible surface change.
