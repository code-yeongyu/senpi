# packages/senpi-codemode

`@code-yeongyu/senpi-codemode` is a source-only Senpi extension that registers
the persistent-kernel `eval` tool for JavaScript, Python, Ruby, and Julia.
Deeper guides: `src/tool/AGENTS.md`, `src/kernels/AGENTS.md`, `test/AGENTS.md`.

## STRUCTURE

```text
src/index.ts                     Extension factory: registers baseline eval, re-registers at session_start after runtime resolution, re-registers on model_select when active model changes
src/prompt/                      Model-aware eval prompt templates and batching dialect selection
src/interpreters/                Interpreter availability detection (detect.ts)
src/config/                      Settings schema, defaults, env overrides
src/extension/                   Session generations and kernel ownership
src/tool/                        Eval schema, cell execution, status events, rendering
src/kernels/                     Persistent kernels: js (worker), py/rb/jl (subprocess), shared lifecycle
src/bridge/                      Loopback bearer-auth protocol and server
src/bridges/                     Host adapters for agent(), output(), structured schemas
src/output/                      OutputSink, truncation metadata, artifact-path handling
src/completion/                  Host completion bridge
src/timeouts/                    Bridge and idle-timeout ownership
scripts/qa-*.ts                  Direct kernel, extension, and renderer QA drivers
test/                            Vitest contracts and the omp parity ledger
```

## INVARIANTS

- `eval` registers at extension load and re-registers at `session_start` after settings, interpreter availability, and task-tool names resolve.
- Eval prompt dialect comes from the active model id; GPT models receive the
  terse composition-forward dialect that documents detached-cell completion.
- Session generations fence old kernels and callbacks; a retired generation
  never emits into a newer session.
- Kernels persist state per language; per-cell callbacks rebind per execution.
- Evals require a `summary` in the user's conversational language; detached cells carry it and the old `title` field stays dropped.
- Every cell settles exactly once: success, error, timeout, abort, bridge failure, kernel crash.
- Timeout and abort cleanup retires child work before ownership is released.
- The bridge binds loopback only, requires a per-session bearer token, limits
  request bodies, and aborts work on disconnect.
- `agent()` and `output()` use configured active tool names via `pi.executeTool`; never import an orchestration workspace package here.
- `local://` resolves under the extension-owned session artifact root; spill notices use plain absolute paths.
- Status events stay structured from kernel protocol through `EvalToolDetails`
  to render output; preserve agent-progress coalescing.
- Nested tool-call rendering is bounded and rendering-only: no session messages, no extension events, no toggle.
- Optional interpreters are capability gaps, not installation failures; JavaScript remains available on supported Node versions.
- Target Node 24+. No Bun-only APIs, `@oh-my-opencode` imports, or `budget`.

## WHERE TO LOOK

| Task | Path |
| --- | --- |
| Register or narrow eval | `src/index.ts`, `src/tool/eval-tool.ts` |
| Prompt behavior | `src/prompt/eval-prompt.ts` |
| Cell execution, settlement, rendering | `src/tool/` (see `src/tool/AGENTS.md`) |
| Interpreter detection | `src/interpreters/detect.ts` |
| Session and kernel ownership | `src/extension/session-manager.ts`, `src/index.ts` |
| Bridge auth and protocol | `src/bridge/` |
| Agent/output task composition | `src/bridges/` |
| Kernel runtimes, subprocess lifecycle | `src/kernels/` (see `src/kernels/AGENTS.md`) |
| Output sink and artifacts | `src/output/`, `src/tool/cell-handler.ts` |
| Status and TUI/HTML rendering | `src/tool/status-events.ts`, `src/tool/render.ts` |
| Tests and port coverage | `test/`, `test/PARITY.md` (see `test/AGENTS.md`) |
| Real-surface QA | `scripts/qa-*.ts` |

## QUALITY GATES

- Add or update a focused Vitest contract before changing runtime behavior; run
  it red, then green.
- Run `npm test` from this package and `npm run check` from the repository root
  before committing.
- Run the relevant `scripts/qa-*.ts` driver for kernel, bridge, extension,
  output, or renderer changes; capture evidence without secrets.
- TypeScript stays erasable and strict: no `any`, assertions, non-null
  assertions, ignored diagnostics, or undocumented dynamic imports.
- Renderer imports stay out of `src/output/` — no renderer dependency cycle.
- Direct dependencies stay exact-pinned; lock refreshes follow root lockfile policy.
- Documentation must describe the current tool contract; update README settings
  and helper tables with every user-visible surface change.

---
Generated: 2026-08-24 | Commit `baf15a54d`
