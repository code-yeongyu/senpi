# src/kernels

Persistent kernels for four runtimes plus shared subprocess lifecycle. Earned
by score 9 — distinct multi-runtime domain (38 source files, TS hosts plus
embedded runner/prelude assets; workspace reference centrality unmeasured).

## WHERE TO LOOK

| Task | Path |
| --- | --- |
| JavaScript host API | `js/context-manager.ts` (`JavaScriptKernel`), `js/worker-host.ts` |
| JS worker runtime, entries | `js/worker-runtime.js`, `js/worker-entry.js`, `js/inline-worker-entry.js`, `js/inline-worker.ts`, `js/worker-core.js` (+ `worker-core.d.ts`) |
| JS import rewriting, queueing | `js/rewrite-imports.ts`, `js/run-queue.ts`, `js/prelude.ts`, `js/local-module-loader.ts` |
| JS declaration persistence / last-expression capture | `js/worker-indirect-eval.js` |
| Shell output capture and child tracking | `js/worker-shell-capture.js`, `js/worker-runtime.js` |
| Python kernel | `py/kernel.ts`, `py/transport.ts`, `py/process.ts`, `py/prelude.py` |
| Ruby kernel | `rb/kernel.ts` + `rb/prelude.rb`, `rb/runner.rb` |
| Julia kernel | `jl/kernel.ts` + `jl/prelude.jl`, `jl/runner.jl` |
| Shared subprocess layer | `shared/subprocess-kernel.ts`, `subprocess-{contract,process,queue,run}.ts`, `runtime-asset.ts` |
| Session environment | `session-env.ts` (PI_* contract shared by all kernels; mirrors the core bash tool) |

## CONVENTIONS

- Each language dir pairs a typed TS host/controller with an embedded runner or
  prelude asset; `shared/runtime-asset.ts` resolves local files or the packaged
  sidecar beside the executable (`node_modules/@code-yeongyu/senpi-codemode/src/`).
- Transport messages are discriminated by string `type` (`ready`, `result`,
  `tool-call`, `closed`, `init-failed`, ...) exchanged as framed bridge
  messages, one JSON line per frame.
- JS persistent cell bindings are rewritten onto `globalThis`; imports are
  AST-parsed (Babel) and rewritten to bridge-compatible dynamic imports.
  `worker-indirect-eval.js` separately scans declarations, literals, comments,
  and regex tokens to preserve bindings and capture the final expression.
- JS runs on worker threads with an inline-worker fallback; py/rb/jl run as
  framed subprocesses through `shared/`.
- Subprocess retirement/restart, worker recovery, timeout, and interrupt
  semantics live here, never in the tool layer.
- Every kernel exposes the active session's `PI_*` environment (`session-env.ts`):
  inherited values are deleted before the session's values are applied, so any
  child spawned from a cell sees the same session environment a bash-tool child
  sees. The JS worker applies it at init (`worker-core.js`; shell capture pins
  the env view under Bun because `delete process.env.X` does not unsetenv),
  and py/rb/jl spawn with it merged into the interpreter environment.

## ANTI-PATTERNS

- Never treat arbitrary objects as bridge messages without discriminant
  validation.
- Never rewrite imports by filename/regex — `rewrite-imports.ts` applies
  source-position edits from the parsed program.
- Do not resolve required runner files to Bun virtual filesystem paths:
  `requireCodemodeRuntimeAsset` rejects those and requires a readable sidecar.
- `py/prelude.py` and `js/worker-indirect-eval.js` exceed 500 lines; exercise
  the language lifecycle/persistence contracts when changing either runtime.
