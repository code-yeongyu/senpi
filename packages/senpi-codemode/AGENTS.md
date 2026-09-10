# packages/senpi-codemode

`@code-yeongyu/senpi-codemode` is a source-only Senpi extension that registers
the persistent-kernel `eval` tool for JavaScript, Python, Ruby, and Julia. Score 17: extension/runtime integration boundary.
Deeper guides: `src/{bridge,tool,kernels}/AGENTS.md`, `test/AGENTS.md`, `test/eval/AGENTS.md`.

## STRUCTURE

```text
src/index.ts                     Extension factory: registers baseline eval, re-registers at session_start after runtime resolution, re-registers on model_select when active model changes
src/prompt/                      Model-aware eval prompt templates and batching dialect selection
src/interpreters/                Interpreter availability detection (detect.ts)
src/config/                      Settings schema, defaults, env overrides
src/extension/                   Session generations, kernel ownership, wake-source/status events, Bun skill discovery
src/tool/                        Eval schema, cell execution, status events, rendering
src/kernels/                     Persistent kernels: js (worker), py/rb/jl (subprocess), shared lifecycle
src/bridge/                      Loopback bearer-auth protocol and server
src/bridges/                     Host adapters for agent(), output(), structured schemas
src/output/                      OutputSink, truncation metadata, artifact-path handling
src/completion/                  Host completion bridge
src/timeouts/                    Bridge and idle-timeout ownership
src/skill/bun-1-4/               Bundled Bun skill and references; activated by the JS kernel's runtime
scripts/qa-*.ts                  Direct kernel, extension, and renderer QA drivers
test/                            Vitest contracts and the omp parity ledger
```

## INVARIANTS

- `eval` registers at extension load and re-registers at `session_start` after settings, interpreter availability, and task-tool names resolve.
- Eval prompt dialect follows the active model id; GPT gets composition/detached-cell guidance, Kimi uses positive imperative emphasis.
- Session generations fence old kernels and callbacks; a retired generation
  never emits into a newer session.
- Kernels persist state per language; per-cell callbacks rebind per execution.
- Evals require a `summary` in the user's conversational language; it is normalized and capped at 80 characters, carried by detached cells; `title` stays dropped.
- Interactive runs detach at the foreground window (default 60s); print/json and `on_timeout: "error"` use the uncapped timeout deadline.
- Every cell settles exactly once: success, error, timeout, abort, bridge failure, kernel crash.
- Timeout and abort cleanup retires child work before ownership is released.
- Bridge authentication and disconnect ownership are specified in `src/bridge/AGENTS.md`.
- `agent()` and `output()` use configured active tool names via `pi.executeTool`; never import an orchestration workspace package here.
- `local://` resolves under the extension-owned session artifact root; spill notices use plain absolute paths.
- Status events stay structured from kernel protocol through `EvalToolDetails`
  to render output; preserve agent-progress coalescing.
- Nested tool-call rendering is bounded and rendering-only: no session messages, no extension events, no toggle.
- Detached cells publish full `wake_source_state` snapshots on liveness transitions and session start; goal continuation consumes this cross-package contract.
- Optional interpreters are capability gaps, not installation failures; JavaScript remains available on supported Node versions.
- Keep Node 24+ support; Bun-specific shell capture, sidecar assets, and skill contribution are capability-gated, not required on Node.
- The Bun skill activates only when the JS kernel runs Bun >=1.4, not because Bun is on PATH. No `@oh-my-opencode` imports or `budget`.

## WHERE TO LOOK

| Task | Path |
| --- | --- |
| Register or narrow eval | `src/index.ts`, `src/tool/eval-tool.ts` |
| Prompt behavior | `src/prompt/eval-prompt.ts` |
| Cell execution, settlement, rendering | `src/tool/` (see `src/tool/AGENTS.md`) |
| Interpreter detection | `src/interpreters/detect.ts` |
| Session and kernel ownership | `src/extension/session-manager.ts`, `src/index.ts` |
| Bridge auth and protocol | `src/bridge/` (see `src/bridge/AGENTS.md`) |
| Agent/output task composition | `src/bridges/` |
| Kernel runtimes, subprocess lifecycle | `src/kernels/` (see `src/kernels/AGENTS.md`) |
| Output sink and artifacts | `src/output/`, `src/tool/cell-handler.ts` |
| Status, wake state, rendering | `src/extension/{eval-status,eval-status-ticker,wake-source-state}.ts`, `src/tool/{status-events,render}.ts` |
| Bun skill activation and assets | `src/extension/skill-contribution.ts`, `src/skill/bun-1-4/` |
| Tests and port coverage | `test/`, `test/PARITY.md` (see `test/AGENTS.md`) |
| Real-surface QA | `scripts/qa-*.ts` |

## QUALITY GATES

- Add or update focused Vitest contracts for runtime behavior; documentation-only edits do not need new tests.
- Run `bun run test` here and root `bun run check` for code changes; package `build` and `clean` are intentional no-ops.
- Run the relevant `scripts/qa-*.ts` driver for runtime/renderer changes; capture evidence without secrets.
- TypeScript stays erasable and strict: no `any`, assertions, non-null
  assertions, ignored diagnostics, or undocumented dynamic imports.
- Renderer imports stay out of `src/output/` — no renderer dependency cycle.
- Direct dependencies stay exact-pinned; lock refreshes follow root lockfile policy.
- Documentation must describe the current tool contract; update README settings
  and helper tables with every user-visible surface change.

---
Updated: 2026-09-10 | Commit `2d0fa41c5`
