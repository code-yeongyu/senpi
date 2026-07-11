# packages/senpi-codemode

`@code-yeongyu/senpi-codemode` is a source-only Senpi extension that registers the `eval` tool and runs persistent JavaScript, Python, Ruby, and Julia kernels.

## STRUCTURE

```text
src/index.ts                    Extension factory and eval registration
src/extension/session-manager.ts Session generation and kernel ownership
src/tool/                       Eval schema, cell execution, rendering
src/kernels/js/                 Worker-backed persistent JavaScript kernel
src/kernels/py/                 Python process and transport
src/kernels/rb/, kernels/jl/    Optional subprocess kernels
src/kernels/shared/             Shared subprocess lifecycle/queues
src/bridge/                     Loopback bearer-auth host bridge
src/completion/                 Host completion/tool bridge
src/timeouts/                   Bridge and idle timeout ownership
```

## INVARIANTS

- The extension currently registers `eval`; do not rely on the stale README no-op claim.
- Session generations fence old kernels and callbacks. A retired generation must not emit into a newer session.
- Kernels persist state per language, while per-cell callbacks are rebound for each execution.
- Every cell settles exactly once across success, error, timeout, abort, bridge failure, and kernel crash.
- Timeout/abort cleanup retires child work and confirms process exit before ownership is released.
- The host bridge binds loopback only, requires a per-session bearer token, limits request bodies, and aborts work on disconnect.
- Optional interpreters are capability gaps, not install failures; JavaScript remains available on supported Node versions.

## WHERE TO LOOK

| Task | Path |
|---|---|
| Register/change eval | `src/index.ts`, `src/tool/eval-tool.ts` |
| Cell settlement | `src/tool/cell-handler.ts` |
| Session/kernel ownership | `src/extension/session-manager.ts` |
| Bridge auth/protocol | `src/bridge/` |
| JS lifecycle | `src/kernels/js/` |
| Subprocess lifecycle | `src/kernels/shared/` and language directory |
| Rendering | `src/tool/render.ts` |

## VALIDATION

- Run `npm test` from this package; tests use the package Vitest command.
- Run focused lifecycle tests for the changed kernel, timeout, bridge, or settlement path.
- Source changes require root `npm run check` and real CLI QA evidence because this extension reaches the agent runtime.
- The current `README.md` no-op/deferred-integration language is stale; do not copy it into implementation guidance. Repair it in a dedicated package-documentation change.
