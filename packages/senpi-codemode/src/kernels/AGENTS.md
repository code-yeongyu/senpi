# src/kernels

Persistent kernels for four runtimes plus shared subprocess lifecycle. Earned
by score 13 — distinct multi-runtime domain (31 files, TS hosts plus embedded
runner/prelude assets).

## WHERE TO LOOK

| Task | Path |
| --- | --- |
| JavaScript host API | `js/context-manager.ts` (`JavaScriptKernel`), `js/worker-host.ts` |
| JS worker runtime, entries | `js/worker-runtime.js`, `js/worker-entry.js`, `js/inline-worker-entry.js`, `js/inline-worker.ts`, `js/worker-core.js` (+ `worker-core.d.ts`) |
| JS import rewriting, queueing | `js/rewrite-imports.ts`, `js/run-queue.ts`, `js/prelude.ts`, `js/local-module-loader.ts` |
| Python kernel | `py/kernel.ts`, `py/transport.ts`, `py/process.ts`, `py/prelude.py` |
| Ruby kernel | `rb/kernel.ts` + `rb/prelude.rb`, `rb/runner.rb` |
| Julia kernel | `jl/kernel.ts` + `jl/prelude.jl`, `jl/runner.jl` |
| Shared subprocess layer | `shared/subprocess-kernel.ts`, `subprocess-{contract,process,queue,run}.ts`, `runtime-asset.ts` |

## CONVENTIONS

- Each language dir pairs a typed TS host/controller with an embedded runner or
  prelude asset; `shared/runtime-asset.ts` ships them.
- Transport messages are discriminated by string `type` (`ready`, `result`,
  `tool-call`, `closed`, `init-failed`, ...) exchanged as framed bridge
  messages, one JSON line per frame.
- JS persistent cell bindings are rewritten onto `globalThis`; imports are
  AST-parsed (Babel) and rewritten to bridge-compatible dynamic imports.
- JS runs on worker threads with an inline-worker fallback; py/rb/jl run as
  framed subprocesses through `shared/`.
- Subprocess retirement/restart, worker recovery, timeout, and interrupt
  semantics live here, never in the tool layer.

## ANTI-PATTERNS

- Never treat arbitrary objects as bridge messages without discriminant
  validation.
- Never rewrite imports by filename/regex — `rewrite-imports.ts` applies
  source-position edits from the parsed program.
- An optional interpreter being absent (py/rb/jl not installed) is a capability
  gap, not an installation failure or error path.
