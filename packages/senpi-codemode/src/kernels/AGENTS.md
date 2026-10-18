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
| Session environment | `session-env.ts` (PI_* contract shared by all kernels; mirrors the core bash tool) |
| JS process isolation | `js/process-worker.ts` (host side), `js/process-entry.js` (child entry), `js/kernel-memory.ts`, `js/control-frames.ts` |
| Sandbox cells | `sandbox/sandbox-cell.ts` (host executor); `sandbox/vendor/pi-codemode/**` (vendored runtime, see its `VENDORED.md`) |

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
- Each language keeps one serial FIFO kernel. Queued cancellation removes only
  that cell; active interruption and runtime recovery stay in the kernel layer.
- Every kernel exposes the active session's `PI_*` environment (`session-env.ts`):
  inherited values are deleted before the session's values are applied, so any
  child spawned from a cell sees the same session environment a bash-tool child
  sees. The JS worker applies it at init (`worker-core.js`; shell capture pins
  the env view under Bun because `delete process.env.X` does not unsetenv),
  and py/rb/jl spawn with it merged into the interpreter environment.
- Every kernel runs in the session cwd. py/rb/jl spawn there; the JS worker cannot
  chdir, so `js/worker-cwd.js` applies the cwd to `process.cwd`, `path.resolve`,
  `fs`, `child_process`, and `Bun.file`/`write`/`$`/`spawn`/`Glob` at init. The
  session manager rejects a cell whose cwd is missing (`extension/session-cwd.ts`).

## ANTI-PATTERNS

- Never treat arbitrary objects as bridge messages without discriminant
  validation.
- Never rewrite imports by filename/regex — `rewrite-imports.ts` applies
  source-position edits from the parsed program.
- An optional interpreter being absent (py/rb/jl not installed) is a capability
  gap, not an installation failure or error path.
