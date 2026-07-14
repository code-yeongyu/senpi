# oh-my-pi eval test parity

Status meanings:

- `ported`: todo 17 added a direct senpi-codemode counterpart.
- `covered`: tests from todos 1–16 already exercise the applicable contract.
- `skipped`: the source test is outside the user-approved port surface; the reason is mandatory.

The target is Node.js 24+ and Senpi extension APIs. Bun-only worker mechanics, OMP-native TUI bookkeeping, `artifact://` identifiers, and plan-mode gates are mapped to the corresponding target contract rather than copied literally.

| oh-my-pi test | senpi-codemode counterpart | status | reason / adaptation |
| --- | --- | --- | --- |
| `src/eval/__tests__/agent-bridge.test.ts` | `test/agent-bridge.test.ts`; `test/js-helper-parity.test.ts`; `test/py-prelude-parity.test.ts` | ported | Host validation, task delegation, progress, schema parsing, handles, and JS/Python helper return shapes are covered. OMP plan-mode and budget gates do not exist in Senpi. |
| `src/eval/__tests__/bridge-timeout.test.ts` | `test/timeouts.test.ts`; `test/eval-bridge-finalization.test.ts` | ported | Pause/resume reference counting, failure recovery, disposal, one-shot interruption, and late bridge completion are covered. |
| `src/eval/__tests__/budget-bridge.test.ts` | — | skipped | Budget was explicitly excluded by the user-approved port plan; senpi-codemode exposes no budget bridge. |
| `src/eval/__tests__/completion-bridge.test.ts` | `test/completion-handler.test.ts`; `test/completion-parity.test.ts` | ported | Credentials, tiers, schema output, default/explicit system prompts, stop reasons, and empty replies are covered. |
| `src/eval/__tests__/helpers-local-roots.test.ts` | `test/js-helper-parity.test.ts`; `test/py-prelude-parity.test.ts`; `test/jl-kernel.test.ts`; `test/rb-kernel.test.ts` | ported | Injected roots, plain paths, traversal rejection, unsupported protocols, and language helper round trips are covered. |
| `src/eval/__tests__/idle-timeout.test.ts` | `test/timeouts.test.ts`; `test/eval-tool-interrupt.test.ts`; `test/eval-bridge-finalization.test.ts` | covered | Active-time watchdog behavior, bridge pauses, aborts, and single settlement are covered by the target timeout ownership model. |
| `src/eval/__tests__/js-context-manager.test.ts` | `test/js-kernel.test.ts`; `test/js-kernel-interrupt.test.ts`; `test/js-kernel-crash-lifecycle.test.ts`; `test/js-runtime-isolation.test.ts` | ported | Persistent state, queueing, reset, crash recovery, cwd isolation, close isolation, and tool routing are covered with Node workers. |
| `src/eval/__tests__/julia-prelude.test.ts` | `test/jl-kernel.test.ts`; `test/jl-error-parity.test.ts` | ported | REPL values, helpers, status/display frames, concurrency helpers, and exception name/message preservation are covered when Julia is installed. |
| `src/eval/__tests__/kernel-spawn.test.ts` | `test/factory.test.ts`; `test/interpreter.test.ts`; `test/py-kernel.test.ts`; `test/js-kernel.test.ts`; `test/rb-kernel.test.ts`; `test/jl-kernel.test.ts` | covered | Interpreter detection, startup failure, secret-free argv, worker fallback, and language kernel construction are covered. |
| `src/eval/__tests__/prelude-agent.test.ts` | `test/js-helper-parity.test.ts`; `test/py-prelude-parity.test.ts`; `test/js-kernel.test.ts` | ported | Agent option forwarding, foreground text, structured data, background handles, null-handle fallback, and DAG-node fields are covered. |
| `src/eval/py/__tests__/prelude.test.ts` | `test/py-prelude-parity.test.ts`; `test/py-kernel.test.ts` | covered | Magics, auto-display, environment, local files, status flags, agent/output/completion helpers, and persistent namespace behavior are covered. |
| `src/eval/py/__tests__/runner-shell-output.test.ts` | `test/py-shell-output-parity.test.ts` | ported | Chunk streaming, `returncode`, line/byte caps, one truncation notice, bounded capture, and newline-free cell-magic streaming are direct ports. |
| `test/tools/eval-display-text.test.ts` | `test/eval-display-parity.test.ts`; `test/eval-tool.test.ts` | ported | Text/display ordering, JSON summaries, bounded model text, no-output fallback, and image display handling are covered. |
| `test/tools/eval-fallback.test.ts` | `test/eval-render-state.test.ts`; `test/eval-tool.test.ts` | covered | Empty output, image-only output, hidden-image behavior, host errors, and safe MIME fallback are covered without OMP-native TUI classes. |
| `test/tools/eval-streaming-output.test.ts` | `test/eval-tool.test.ts`; `test/eval-render-streaming.test.ts` | covered | Monotonic live tails, running-cell attribution, partial replacement, final replacement, and error finalization are covered. |
| `test/tools/eval-timeout.test.ts` | `test/eval-tool-interrupt.test.ts`; `test/eval-bridge-finalization.test.ts`; `test/timeouts.test.ts` | covered | Reset/run deadlines, kernel interruption, nested tool aborts, late replies, and exactly-once settlement are covered. |
| `test/tools/eval-agent-progress.test.ts` | `test/agent-bridge.test.ts`; `test/status-events.test.ts`; `test/eval-render-streaming.test.ts` | covered | Defensive agent progress synthesis, upsert semantics, current-tool rendering, and final status replacement are covered. |
| `test/tools/eval-code-preview.test.ts` | `test/eval-render-preview.test.ts`; `test/eval-render-width.test.ts`; `test/eval-render.test.ts` | covered | Preview windows, truncation markers, width limits, titles, reset, and timeout labels are covered. |
| `test/tools/eval-commit-stability.test.ts` | `test/eval-render-streaming.test.ts` | covered | Senpi reuses the same rendered result component across partial updates and finalization; OMP native-scrollback APIs are OMP-infra-specific. |
| `test/tools/eval-description.test.ts` | `test/extension.test.ts`; `test/prompt.test.ts` | covered | Dynamic language availability, helper documentation, task-helper gating, and the registered eval surface are covered. |
| `test/eval/agent-bridge.test.ts` | `test/agent-bridge.test.ts`; `test/js-helper-parity.test.ts` | ported | Worker-to-host tool calls, replies, structured handle values, and error propagation are covered. |
| `test/eval/console-table.test.ts` | `test/js-runtime-output-parity.test.ts` | ported | Object rows, column filtering, table borders, values, and trailing newline behavior are direct ports. |
| `test/eval/display-image-coerce.test.ts` | `test/js-runtime-output-parity.test.ts` | ported | Strict base64, decimal CSV, typed arrays, ArrayBuffer, Buffer, serialized Buffer, and rejected image diagnostics are direct ports. |
| `test/eval/process-stdio-capture.test.ts` | `test/js-runtime-output-parity.test.ts` | ported | Exact stdout/stderr string and Buffer writes are routed into the active cell without an added newline. |
| `test/eval/runtime-global-dispose.test.ts` | `test/js-runtime-isolation.test.ts`; `test/js-kernel.test.ts` | ported | Senpi isolates each runtime in a Node worker; closing one kernel cannot remove another kernel's globals or cwd. Same-realm ownership is not part of the target architecture. |
| `test/eval/worker-core.test.ts` | `test/js-kernel.test.ts`; `test/js-kernel-interrupt.test.ts`; `test/js-kernel-crash-lifecycle.test.ts`; `test/js-runtime-isolation.test.ts` | covered | Protocol init/run/close, independent workers, queueing, timeout restart, crash restart, and isolation replace OMP same-realm conflict handling. |
| `test/core/eval-workflow-helpers.integration.test.ts` | `test/py-kernel.test.ts`; `test/py-prelude-parity.test.ts`; `test/status-events.test.ts` | covered | Real-kernel parallel order/concurrency/errors, pipeline barriers, log/phase events, and local roots are covered; OMP-only `append()` is outside the documented Senpi helper surface. |
