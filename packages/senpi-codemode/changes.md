# senpi-codemode fork changes

## 2026-09-24 - Eval language errors list the enabled kernels

### What changed

- `packages/senpi-codemode/src/tool/eval-request.ts`: `parseEvalRequest` takes the enabled language list; a missing or unknown `language` fails with `eval run requires language — one of` those tokens, not the full js/py/rb/jl set.
- `packages/senpi-codemode/src/tool/eval-tool.ts`: execute passes the session's enabled languages into the parser so the teaching error matches the schema the model already sees.
- Tests: `test/eval-request-language.test.ts` pins a js-only execute path and a py+js parse path. QA: `scripts/qa-e2e-eval.ts` expects `one of "js", "py"` on the default host.

### Why

- The published schema already enumerates only enabled kernels. The teaching error still listed Ruby and Julia, which are off by default, so a model that omitted `language` was told to retry with a kernel that would then fail as unsupported.

### Why an extension could not handle it

- The eval request parser belongs to this package.

### Expected merge conflict zones

- LOW: the fork-only eval parser, its tests, and the QA driver.

## 2026-09-24 - Eval run schema and parser agree on required language/code

### What changed

- `packages/senpi-codemode/src/tool/types.ts`: the `language` union and `code` field descriptions now state "REQUIRED for run" (the language description also explains per-kernel persistent state). Both stay optional in the wire schema because the control actions (`peek`, `stop`, `list`) share it — the same treatment `summary` already had.
- `packages/senpi-codemode/src/tool/eval-request.ts`: a run with a missing or unknown `language` now fails with `eval run requires language — one of "js", "py", "rb", "jl"`, and a run without `code` fails with `eval run requires code — the cell body to execute, verbatim`, replacing the bare `eval run requires language` / `eval run requires code`.
- Tests: `test/eval-request-language.test.ts` pins the actionable parse errors, the schema descriptions, and the tool-execute error path. QA: `scripts/qa-e2e-eval.ts` drives the omitted-language call through a real session and asserts the actionable error.

### Why

- The published schema marked `language` (and `code`) optional with no description, so models omitted them and burned a round trip on an opaque TypeError. No default or last-used kernel exists, and py+js are both enabled by default, so guessing a default kernel could run the cell in the wrong interpreter — a surprising failure that still spends a kernel run. An explicit schema contract plus an actionable error is the root fix and matches the existing `summary` treatment.

### Why an extension could not handle it

- The eval tool's schema and request parser belong to this package.

### Expected merge conflict zones

- LOW: the fork-only eval schema/parser, its tests, and the QA driver.

## 2026-09-24 - Python preview ruff timeout follows the formatter budget (#2076 follow-up)

### What changed

- `packages/senpi-codemode/src/tool/display-python.ts` passes the ruff timeout (the formatter budget minus one second) as the formatter script's first argument; `display-python-script.ts` uses it instead of a fixed `timeout=4`.
- `test/eval-display-python.test.ts`: the fake-ruff tests share a `fakeRuff` helper with a 25 s budget and assert a marker file the fake writes, so a ruff that timed out can no longer pass the docstring-rejection test.

### Why

- The final gate review measured 3-13 s first-run latency for freshly written executables on macOS; the fixed 4 s timeout made the fake-ruff test fail there and let the docstring test pass without ruff running.

### Why an extension could not handle it

- The eval renderer belongs to this package.

### Expected merge conflict zones

- LOW: the Python display modules only.

## 2026-09-24 - Eval preview equivalence guards (#2076 follow-up)

### What changed

- `packages/senpi-codemode/src/tool/display-js-layout.ts`: the long-array break rewrites only the whitespace in each gap, so the parentheses of a parenthesized element (`[(a, 1), (b, 2)]`) stay.
- `packages/senpi-codemode/src/tool/display-js.ts`: besides the character guard, the preview must re-parse to the same program as the cell (positions, raw spellings, and parenthesization flags ignored; comments compared), otherwise the cell is shown as sent.
- `packages/senpi-codemode/src/tool/display-python-script.ts`: `same_tokens` becomes `equivalent`: a formatter result is kept only when `ast.dump` of it equals the source's and its string, number, f-string, and comment tokens have the same text. Rejects docstring normalization and `ast.unparse` output that is not valid Python (`1 .real`).
- `packages/senpi-codemode/src/tool/display-python.ts`: a rejected formatter promise settles as "no formatted cell" instead of an unhandled rejection.
- Tests: `test/eval-display-fixtures.ts` gains the parenthesized-element array; `test/eval-display-python.test.ts` gains a fake ruff that rewrites a docstring and the `1 .real` cell.

### Why

- A post-merge gate review of #2078 reproduced both cases: the character guard ignored `()` and Python whitespace inside strings, so a preview with a different meaning passed.

### Why an extension could not handle it

- The eval renderer belongs to this package.

### Expected merge conflict zones

- LOW: the display modules only.

## 2026-09-24 - Bun-laid-out JS previews and interpreter-formatted Python previews (#2076)

### What changed

- `packages/senpi-codemode/src/tool/display-code.ts`: `displayCode(code, language, onFormatted?)` dispatches dense cells (a line over 100 characters) per language. JavaScript is laid out only when the renderer runs on Bun (`process.versions.bun` plus a constructible `Bun.Transpiler`); on Node it is shown as sent. Python goes to the user's interpreter in the background. Ruby and Julia are shown as sent. The #2050 Babel line breaker is removed.
- `packages/senpi-codemode/src/tool/display-js.ts`, `display-js-mask.ts`, `display-js-layout.ts`, `display-js-ast.ts` (new): every literal, template, tagged template, identifier (one placeholder per spelling so labels resolve), private name, and directive is swapped for a placeholder, statement-level comments become placeholder statements, `Bun.Transpiler` lays the masked cell out (unwrapped for module syntax, inside an async function for top-level `return`), and the source text is substituted back with exact occurrence counts. Trailing line comments return to their statement's line, `for` headers print as `for (a; b; c)` / `for (;;)`, and one-line arrays over 60 characters still break one element per line. A comment inside an expression, a Bun parse failure, a count mismatch, or any non-layout character difference shows the cell as sent.
- `packages/senpi-codemode/src/tool/display-python.ts`, `display-python-script.ts` (new): the interpreter the py kernel detection finds (`python3`, `python`, `py -3`) runs a formatter script with the cell on stdin: ruff (PATH or the `ruff` package, `quote-style = 'preserve'`), then black (`string_normalization=False`), then `ast.unparse` over a cell whose strings, f-strings, and numbers are masked, only when it has no comments. A result that differs from the source beyond layout is discarded. Results are cached; at most two formatter processes run at once, each with a 5 s timeout.
- `packages/senpi-codemode/src/tool/code-preview.ts` (new, moved out of `render.ts`): `highlightedCode` passes the repaint callback. `render.ts` threads `context.invalidate` as `RenderEnvironment.repaint` for complete call args and results; the no-theme call frame passes it to `displayCode` the same way.
- `packages/senpi-codemode/AGENTS.md`: the "No Bun-only APIs" invariant now allows them only behind runtime detection with a correct Node path, and records the display-only fidelity rule.
- Tests: `test/eval-display-code.test.ts` (Node: cells shown as sent), `test/eval-display-code-bun.test.ts` (spawns `bun` for the layout and fidelity battery plus the rendered frame), `test/eval-display-python.test.ts` (real `python3`: ast layout, fallbacks, a fake ruff on PATH, repaint wiring), fixtures in `test/eval-display-fixtures.ts`.

### Why

- The #2050 preview only split lines, so dense cells kept minified spacing. The renderer runs on Bun in the compiled distribution, and Bun ships a printer; a raw `Bun.Transpiler` round trip is not faithful (it rewrites `"a\nb"` into a multi-line template, `0xff` into `255`, emoji into escapes, folds `typeof undefined`, and drops comments and directives), hence the masking. Python has no printer in the host runtime, so the user's own interpreter and formatters are borrowed when present.

### Why an extension could not handle it

- The eval renderer belongs to this package.

### Expected merge conflict zones

- LOW: `packages/senpi-codemode/src/tool/render.ts` imports, `RenderEnvironment`, the call and result `environment` literals, and the no-theme call frame; the display modules are new.

## 2026-09-23 - Readable preview for dense JS eval cells (#2050)

### What changed

- `packages/senpi-codemode/src/tool/display-code.ts` (new): `displayCode(code, language)` reformats a JS cell with a line longer than 100 characters. It parses with `@babel/parser` (top-level `await`/`return` allowed, as in the kernel) and turns the whitespace, comma, and comment regions between statements, inside non-empty blocks, and between the elements of a one-line array longer than 60 characters into indented line breaks. Every other character is copied verbatim. Parse failures, non-JS languages, and non-dense code return the input unchanged; results are memoized (64 entries).
- `packages/senpi-codemode/src/tool/render.ts`: `highlightedCode` and the no-theme call frame preview `displayCode(...)` instead of the raw cell.
- `packages/senpi-codemode/test/eval-display-code.test.ts`: the dense cell shape from the report, top-level `await`/`return`, comments, identity cases, and the rendered cell frame.

### Why

- Models often send a cell as one line of semicolon-joined statements, and the preview hard-wrapped it into an unreadable block. Reformatting only at display time keeps the tool arguments byte-identical (senpi#1472). Babel works under Node (the package's Node 24 target and Vitest) and Bun, and it keeps comments, which `Bun.Transpiler` would drop.

### Why an extension could not handle it

- The eval renderer belongs to this package.

### Expected merge conflict zones

- LOW: `packages/senpi-codemode/src/tool/render.ts` `highlightedCode` and the no-theme branch of `renderEvalCall`; `display-code.ts` is new.

## 2026-09-23 - Uncapped, purpose-framed eval summary (#2050)

### What changed

- `packages/senpi-codemode/src/tool/types.ts`: the `summary` field loses `maxLength` and `EVAL_SUMMARY_MAX_LENGTH`; its description drops the language-specific example and the truncation claim and asks for one line, in the language the user writes in, that is a progress update saying what the agent is doing and why rather than a label for the code. A literal English template ("Working on <task> to <purpose>") was tried and rejected: a real model copied the English words into a Korean summary.
- `packages/senpi-codemode/src/tool/eval-request.ts`: `clampEvalSummary` becomes `normalizeEvalSummary` (trim, whitespace collapse, blank -> absent; no truncation). The teaching error uses the same framing. `eval-tool.ts` `prepareArguments` and the render-time `displaySummary` call it.
- `packages/senpi-codemode/src/tool/render.ts`: `summaryVisualLines`/`summaryBlock` show the first `SUMMARY_PREVIEW_LINES` (3) wrapped lines of a collapsed summary with a trailing ellipsis and the whole summary when expanded, in the cell frame, the no-theme call frame, and the plain result frame.
- Tests: `packages/senpi-codemode/test/eval-request-summary.test.ts` and `packages/senpi-codemode/test/eval-render-summary.test.ts` (renamed from `eval-render-summary-clamp.test.ts`) pin the uncapped contract and the display bound; the coding-agent #1472 regressions exercise whitespace normalization, the preparation difference that remains.

### Why

- "WHAT this cell does" produced labels for the code block rather than a statement of the work in progress and its purpose, and the 80-character cap cut the purpose clause. The language-specific example is redundant with "the language the user writes in".
- The display bound keeps the src/tool rule that rendered output is capped, without capping what the model may write.

### Why an extension could not handle it

- The schema, request parser, and renderer are this package's own eval tool.

### Expected merge conflict zones

- LOW: `packages/senpi-codemode/src/tool/types.ts` summary field, `packages/senpi-codemode/src/tool/eval-request.ts` summary normalization, `packages/senpi-codemode/src/tool/render.ts` summary rendering.

## 2026-09-23 - Bound interpreter test concurrency in CI (#2039)

### What changed

- `packages/senpi-codemode/vitest.config.ts` limits CI and GitHub Actions to two fork workers, matching the existing coding-agent suite.
- `test/ci-worker-policy.test.ts` imports the actual configuration in isolated processes and verifies both CI signals, unchanged assertion deadlines, and unchanged local defaults.

### Why

- Real interpreter tests can each spawn several child runtimes. The default four-core scheduler ran three interpreter test files concurrently; the explicit bound reduces simultaneous runtime startup without increasing any timeout or skipping assertions.
- The reported Julia timeout was not reproduced in isolated macOS or Linux checks. This is concurrency hardening, not a claim that its exact historical delay was identified.

### Why an extension could not handle it

- `packages/senpi-codemode/vitest.config.ts` owns the test runner's worker pool, outside the runtime extension API.

### Expected merge conflict zones

- LOW: `packages/senpi-codemode/vitest.config.ts`, the `test` options; the regression is a new file.

## 2026-09-21 - Remove write-only Python prelude session state

### What changed

- `packages/senpi-codemode/src/kernels/py/prelude.py`: remove the unused `SESSION_ID` initializer, global declaration and init-frame assignment.

### Why

- `packages/senpi-codemode/src/kernels/py/prelude.py`: the internal variable had no readers in the package or its tests and was not exposed in the cell namespace. The init frame and `PI_SESSION_ID` environment contract remain unchanged.

### Why an extension could not handle it

- `packages/senpi-codemode/src/kernels/py/prelude.py`: the write-only state belongs to the embedded runner, so its removal is internal to that asset.

### Expected merge conflict zones

- LOW: `packages/senpi-codemode/src/kernels/py/prelude.py`, module globals and the init branch of `handle`.


## 2026-09-21 - Busy py kernel retires when its host died before boot finished (senpi#1659)

### What changed

- `src/kernels/py/prelude.py` starts a `senpi-named-parent-watch` daemon thread when `SENPI_PY_KERNEL_PARENT_PID` is set: every 500 ms it checks `os.kill(pid, 0)` and calls `_terminate_process_group()` on `ProcessLookupError`, closing the gap where the host died before the interpreter captured its baseline ppid (`getppid()` already returns the posthumous value, so the existing ppid watch sees no transition).
- `src/kernels/py/process.ts` `defaultSpawn` passes its own pid via `SENPI_PY_KERNEL_PARENT_PID` on non-Windows platforms; Windows spawns non-detached, so host-loss semantics differ there and the env var is not set.
- `test/py-kernel-parent-watchdog.test.ts` drives the kernel through the production `defaultSpawn` under a throwaway parent: a busy kernel retires within 3 s of host death and an idle kernel still retires on stdin EOF (skipped on win32 / when no python3 is present).

### Why

A detached py kernel whose host died before the prelude captured its baseline ppid never notices the loss: a busy cell never returns to the stdin loop, `getppid()` never transitions, and the orphan sleeps under init for days (senpi#1659) — a slow resource leak on long-lived hosts.

### Why an extension could not handle it

The host pid must be present in the kernel's environment at spawn time and the watchdog must run inside the kernel process itself; a host-side extension cannot inject a parent-death signal into an already-spawned detached interpreter, and the ppid it could observe is already posthumous at boot.

### Expected merge conflict zones

- LOW: `src/kernels/py/prelude.py` (`_watch_parent`/`_start_parent_watch` region), `src/kernels/py/process.ts` (`defaultSpawn`), `test/py-kernel-parent-watchdog.test.ts` (new file).

## 2026-09-21 - Forward agent isolation options to capable task hosts (senpi#1910)

### What changed

- `src/bridges/agent-bridge.ts` probes the configured task schema once per bridge via the existing host catalog, forwards advertised `isolated`/`apply`/`merge` options, normalizes boolean merge aliases, and preserves the unsupported-host warning. Foreground unapplied isolation raises `AgentIsolationNotAppliedError` with recovery fields; host isolation metadata is preserved, including on immediate handles.
- `src/bridges/reserved-dispatch.ts` passes the same catalog used by `tool_schema()` to the agent bridge for JS and HTTP transports.
- `src/kernels/js/worker-runtime.js`, `src/kernels/py/prelude.py`, `src/kernels/rb/prelude.rb`, and `src/kernels/jl/prelude.jl` preserve optional handle isolation details; Python no longer coerces string merge modes to booleans.
- `src/kernels/js/prelude.ts`, the Python/Ruby/Julia prelude docs, `src/prompt/eval-prompt-template.ts`, and `README.md` document capability gating, merge aliases, foreground errors, and waiting for background completion.
- `test/agent-bridge.test.ts` and `test/workpool-prelude.test.ts` cover bridge contracts and real-language transports; the existing prompt snapshot follows the updated shipped helper documentation.

### Why

- Capable task engines must receive the requested isolation controls instead of silently dropping them; unapplied foreground changes must not appear successful.

### Why an extension could not handle it

- This extension owns the reserved agent bridge and language adapters. Isolation execution remains entirely in the host task engine; no orchestration dependency or task-handle schema change is introduced.

### Expected merge conflict zones

- LOW: agent option/result mapping, reserved dispatch catalog forwarding, and the four language helper adapters and docs.

## 2026-09-21 - Configurable detached capacity and multi-job QA (senpi#1908)

### What changed

- `src/config/settings.ts` accepts the numeric `maxDetachedCells` setting (default 15) and resolves `SENPI_CODEMODE_MAX_DETACHED_CELLS` with the run-budget parser. `src/index.ts` and `src/tool/eval-tool.ts` share that resolver; the manager's cap also supplies `buildEvalPrompt`.
- README and package/kernel/tool guides describe queued same-language execution on one kernel, the global cap, `list`, and `eval_kernel_busy_reset_refused`.
- `test/config.test.ts` and `test/extension.test.ts` exercise file/default/environment admission and registration; `scripts/qa/eval-multi-job.ts` records a real session with JS/Python barriers, queued cancellation, reset refusal, completion notices and cleanup.
- `src/tool/eval-kernel-reset-refused-error.ts` includes its stable code in the refusal message, preserving the identifier when the session serializes thrown errors as text.

### Why

- File and environment settings must control both the advertised cap and actual admission after registration.

### Why an extension could not handle it

- This extension owns settings resolution, manager construction, and the eval prompt.

### Expected merge conflict zones

- LOW: settings schema/resolvers, manager creation, and README settings table.

## 2026-09-21 - Eval list and busy-kernel reset refusal (senpi#1908)

### What changed

- `src/tool/{types,eval-request,eval-tool,eval-tool-options,detached-eval-result,render}.ts` accept and render list controls with typed, cross-language live/recent metadata, without touching notifications. Peek/stop schema validation requires a nonempty cell id.
- `src/tool/{detached-cell-contract,detached-cell-snapshot}.ts` retain submission timestamps and reset-refusal error codes in terminal snapshots.
- `src/tool/{run-eval-cell,eval-kernel-reset-refused-error}.ts` reject busy-language resets, excluding the requesting queued cell, without resetting or stopping existing work.
- `src/prompt/eval-prompt-template.ts`, its shipped-copy snapshot, and README explain list observation and reset refusal. `test/eval-list-and-reset.test.ts` covers schema, execution, listing, notification preservation, reset refusal and recovery.

### Why

- Callers need a session-wide view of eval work and must not erase state used by another live cell.

### Why an extension could not handle it

- This extension owns the schema, cell registry, reset boundary, and renderer.

### Expected merge conflict zones

- MEDIUM: eval tool schema/execute overloads, detached snapshots/results, reset boundary, and prompt sentence.

## 2026-09-21 - Foreground capacity window and queued eval guidance (senpi#1908)

### What changed

- `src/tool/run-eval-cell.ts`, `cell-execution.ts`, and `src/timeouts/idle-timeout.ts` re-arm one submission-bound foreground wait after a refused detach. Bridge pauses cannot extend that deadline; shorter at-cap cells complete normally.
- `src/tool/detached-eval-result.ts`, `detached-cell-manager.ts`, and `types.ts` return a typed capacity cancellation, preserve queued-detached status, and report live-cell counts and queue predecessors. `cell-runtime.ts` emits queued progress.
- `src/tool/eval-tool.ts`, `src/prompt/{eval-prompt,eval-prompt-template}.ts`, and `src/extension/eval-status.ts` thread the configured cap into model guidance and show a queued marker rather than a fabricated elapsed time. README and the eval prompt snapshot follow the new contract.
- `test/eval-detach.test.ts`, `eval-steering-detach.test.ts`, and `eval-status-queued.test.ts` cover FIFO notifications, the 30/45/60-second cap window, targeted cancellation, bridge pauses, acquisition, and steering without cancellation.

### Why

- Reaching background capacity must neither reject short work nor block the turn beyond its foreground window. Queued work needs clear non-retry guidance and must not look like executing work.

### Why an extension could not handle it

- This extension owns foreground execution, watchdog cleanup, detached settlement, and the model-facing tool contract.

### Expected merge conflict zones

- MEDIUM: run-eval-cell, CellExecution watchdog, detached result conversion, eval prompt sentence and snapshot.

## 2026-09-21 - Capped detached set and queued kernel admission (senpi#1908)

### What changed

- `src/tool/detached-cell-{manager,contract,state,snapshot,status}.ts`, `managed-cell.ts`, and `terminal-snapshot-store.ts` track queued/running execution separately from detachment, cap detached cells globally, list live/recent cells, and dequeue queued stops without interrupting active work.
- `src/tool/{eval-tool,eval-tool-options,run-eval-cell,cell-runtime,detached-eval-result,eval-execution-event,types,render}.ts` admit same-language work, bind per-run callbacks, start budgets on kernel activation, expose `queued_ms` and queue predecessors, and render queued state.
- `src/config/settings.ts`, `src/index.ts`, `src/extension/eval-status.ts`, and `src/prompt/eval-prompt-template.ts` wire the default-15 cap and document submission-time hard limits versus execution-time budgets.

### Why

- Detached cells must not reject subsequent same-language work or consume its budget while it waits. Cell-specific callbacks prevent a later submission from stealing earlier output.

### Why an extension could not handle it

- The extension owns this cell state machine, kernel admission boundary, and renderer contract.

### Expected merge conflict zones

- MEDIUM: detached-cell manager, run-eval-cell, result/status rendering, and deadline fixtures.

## 2026-09-17 - Reject cell declarations that would replace kernel globals (senpi#1784)

### What changed

- `src/kernels/js/worker-shadow-guard.js` (new) lazily snapshots `globalThis` own names at the first guard call — the first cell's transform, when prelude globals exist but no cell-created global does — and reports the first binding that would replace a protected global.
- `src/kernels/js/worker-indirect-eval.js` calls the guard from `rewriteDeclaration` before emitting `globalThis[...]` assignments; a colliding top-level `const`/`let`/`var` (plain or destructured) now fails the cell with an error naming the identifier, the rename remedy, and the explicit `globalThis.<name>` escape hatch.
- `test/kernel-js-persistence.test.ts` covers plain/let/var/destructured rejection, native-global survival in the next cell, prelude-global protection, re-declaration of cell-created globals, and explicit `globalThis` assignments staying untouched.
- `scripts/qa-js-shadow-guard.ts` (new) drives the real kernel end to end: guard error text, native-global survival, destructured rejection, and re-declaration.

### Why

- Hoisting a declaration named after an existing global (`const fetch = ...`, `const [fetch] = ...`) silently replaced the platform or prelude global for every later cell; sessions wedged with confusing TypeErrors far from the cause and only a kernel reset recovered. The guard rejects the declaration before execution, so the failure is loud, local, and actionable.

## 2026-09-16 - Bind kernel-tools types to the host declaration (senpi#1731)

### What changed

- `src/kernels/js/kernel-tools-types.ts` aliases `KernelToolsInvokeOptions` / `KernelToolsInvokeScope` / `KernelToolsHostScope` from `@code-yeongyu/senpi`'s `KernelToolInvokeOptions` / `KernelToolInvokeScope`, types `KernelToolsCapability` as `ExtensionKernelTools`, and `KERNEL_TOOLS_CAPABILITIES satisfies ExtensionKernelTools["capabilities"]`.
- `src/tool/run-eval-cell.ts` types the cell capability object with `satisfies ExtensionKernelTools`.

### Why

- Coding-agent owns the public `ExtensionContext.kernelTools` declaration; this package implements it. Importing the host types here is the drift check (#1731).

### Why an extension could not handle it

- The capability object is constructed by the codemode kernel and published onto the host `kernelToolsStorage`; only this package can bind that object to the host type.

### Expected merge conflict zones

- LOW: `src/kernels/js/kernel-tools-types.ts`, `src/tool/run-eval-cell.ts`.

## 2026-09-16 - Call-scoped host-tool policy for kernel-tool invoke (#1731)

### What changed

- `src/kernels/js/kernel-tools-types.ts` adds `KernelToolsInvokeScope`/`KernelToolsHostScope`/`KernelToolsInvokeOptions`, the `KERNEL_TOOLS_CAPABILITIES` marker (`invokeScope: true`) and widens `KernelToolsCapability.invoke` to `(request, options?: AbortSignal | KernelToolsInvokeOptions)`.
- `src/kernels/js/kernel-tools-host.ts` normalizes the second argument, copies the caller's lists onto the `kernel-tool-invoke` frame only when the call names host tools, and rebuilds the typed refusal (`kernel_tool_host_denied` plus its `details`) from the reply.
- `src/bridge/kernel-tools-protocol.ts` carries the optional `scope` on `kernel-tool-invoke` and the optional `details` payload on kernel-tool errors.
- `src/kernels/js/kernel-tools-scope.js` holds the policy (deny wins, allow list refuses everything it does not name, malformed list fails closed) and the refusal factory; `src/kernels/js/kernel-tools-pump.js` puts the scope in the call-scoped bridge store and serializes `details`; `src/kernels/js/worker-core.js` refuses a scoped nested host call before it reaches the bridge.
- `src/tool/run-eval-cell.ts` publishes `capabilities` on the cell's capability object and forwards the options through `JavaScriptKernel.invokeKernelTool`.

### Why

- A consumer granting a parent's kernel tool to a child with a narrower tool policy had only two options: refuse the grant, or let the closure's nested `tool.<host>()` calls run with the parent's full permissions (#1731). The scope is per call, so the parent's own cells and queue are untouched.

### Why an extension could not handle it

- The refusal must happen inside the JS worker's call-scoped bridge context, between the closure and the host bridge, which only the codemode kernel owns.

### Expected merge conflict zones

- LOW: `src/kernels/js/kernel-tools-*`, `src/bridge/kernel-tools-protocol.ts`, `src/tool/run-eval-cell.ts`.

## 2026-09-16 - Kernel-tool capability on the worker tool-call path (#1754)

### What changed

- `src/tool/run-eval-cell.ts` computes the cell's `kernelTools` capability before the handler exists and passes it into `CellHandler` through `CellBridgeRuntime`.
- `src/tool/cell-handler.ts` enters `kernelToolsStorage.run(kernelTools, ...)` around each `tool-call` dispatch (reserved `agent()`/`output()` bridges, completion, and ordinary host tools), so `ExtensionContext.kernelTools` resolves for exactly the duration of every host tool call a live JS cell makes.

### Why

- The kernel's message callback fires from the worker's own message loop, outside the `kernelToolsStorage.run` scope that only wrapped the awaited run chain, so every host tool dispatched by a running cell saw an empty store and refused kernel-tool grants with `tools_unavailable` (#1754); the capability from #1647 was unreachable in the shipped product.

### Why an extension could not handle it

- The dispatch boundary between the JS worker's message loop and the host tool runtime is owned by the codemode cell handler.

### Expected merge conflict zones

- LOW: `src/tool/cell-handler.ts`, `src/tool/run-eval-cell.ts`.

## 2026-09-16 - Live host and foreign kernel-tool name collisions (#1647)

### What changed

- Session manager passes live `hostToolNames` / `foreignLanguageNames` providers into the JS kernel. Foreign names come from `listKernelToolNames()` on the other kernels of the same session (py/rb/jl).
- Worker init still carries optional name arrays. The host re-resolves providers on worker start and before each cell via `kernel-tools-names`, so MCP attach after kernel start collides at `tool()`.
- py/rb/jl kernels expose `listKernelToolNames()` (currently empty) as the source of truth for cross-language collisions.

### Why

- Host names were a one-shot `listTools()` snapshot, and `foreignLanguageNames` never left session-manager, so production JS `tool()` missed Python-side names and tools attached after worker start.

### Why an extension could not handle it

- Collision sets live in the worker registry and session kernel map.

### Expected merge conflict zones

- MEDIUM: `src/extension/session-manager.ts`, `src/kernels/js/worker-startup.ts`, `src/kernels/js/context-manager.ts`, `src/bridge/kernel-tools-protocol.ts`.

## 2026-09-16 - Fail-closed JS kernel-tool parser and nested interrupt (#1647)

### What changed

- `src/kernels/js/kernel-tools-parse.js` is the only parser (Babel `.ts` copy removed). It accepts `function name(` / `async function name(` with IdentifierName parameters, including unicode and arrow-containing bodies, and rejects trailing commas, defaults, rest, destructuring, arrows, generators, and classes.
- Worker init carries `hostToolNames` / `foreignLanguageNames` into `createKernelToolRegistry`. JS names that would require MCP mangling are rejected rather than rewritten.
- Parent interrupt aborts nested kernel-tool waits with `kernel_tool_stale` so the host waiter settles once.
- py/rb/jl kernels expose describe/invoke that return `tools_unavailable`.

### Why

- Unit tests locked the unused Babel parser while the worker guessed trailing commas, over-rejected `=>` in bodies, skipped live collision rules, and hung nested invokes across interrupt.

### Why an extension could not handle it

- Worker parser, init protocol, and nested pending maps are kernel internals.

### Expected merge conflict zones

- MEDIUM: `src/kernels/js/kernel-tools-parse.js`, `src/kernels/js/worker-core.js`, `src/kernels/js/worker-runtime.js`, `src/bridge/protocol.ts`.

## 2026-09-16 - Reentrant JS kernel tool pump (#1647)

### What changed

- Host/worker protocol adds correlated kernel-tool describe/invoke/cancel/reply frames serviced off the top-level run queue.
- Nested invokes use a call-scoped pending-reply map so `read()` inside a parent tool cannot deadlock behind `agent()`.
- Recursive `agent()`/`workpool()` from a kernel tool returns `kernel_tool_recursion`; reset/kill rejects waiters with `kernel_tool_stale`.
- `scripts/qa/omp-item6.ts` event-gates parent-awaits-child and reset/recursion cases.

### Why

- A parent JS cell awaiting a child must keep pumping nested host bridges without a second top-level eval.

### Why an extension could not handle it

- Worker message dispatch and run-queue ownership are kernel internals.

### Expected merge conflict zones

- MEDIUM: `src/kernels/js/worker-core.js`, `src/kernels/js/context-manager.ts`, `src/bridge/protocol.ts`.

## 2026-09-16 - Fenced JS kernel tool descriptors (#1647)

### What changed

- `src/kernels/js/kernel-tools-*.js` parse named functions, apply MCP naming rules, and fence descriptors by generation/revision.
- `tool(fn, metadata?)` is callable in the JS worker while `tool.<name>()` host calls remain.
- `src/bridges/agent-bridge.ts` accepts and forwards `tools: string[]`.
- Bridge protocol schemas include kernel-tool describe/invoke frames; production invoke pumping is not enabled yet.
- `vitest.config.ts` merges workspace source aliases from `vitest.base.ts` so Node-hosted Vitest can load agent-bridge tests without package dist.

### Why

- In-process children need live, fenced parent JS functions without persisting closures or colliding with host/reserved names.

### Why an extension could not handle it

- Kernel globals, bridge frames, and agent argument forwarding are owned by codemode.

### Expected merge conflict zones

- MEDIUM: `src/bridge/protocol.ts` host/kernel unions, `src/kernels/js/worker-runtime.js` `tool` global, `src/bridges/agent-bridge.ts` argument schema.

## 2026-09-16 - Workpool aggregate QA and reset retention (#1646)

### What changed

- `src/bridges/agent-bridge.ts` sets `additionalProperties: true` on the task-handle schema so extra producer fields match the frozen contract.
- `scripts/qa/omp-item2-plugin.mjs` subscribes to `senpi-task.workpool-aggregate` on the parent session JSONL before close and asserts `pool_id`, keyed results in input order, and no `yield_unavailable`.

### Why

- Happy QA hardcoded `aggregateVerified: false` and could not certify a working O2 producer; kernel-reset tests inspected a canned fixture ID that could not observe a dropped engine pool.

### Why an extension could not handle it

- Task-handle validation and the checked-in workpool QA runner are owned by codemode; an extension cannot change the consumer schema or the ship-gate assertion.

### Expected merge conflict zones

- LOW: `agent-bridge.ts` schema options and `scripts/qa/omp-item2-plugin.mjs` aggregate extraction.

## 2026-09-13 - Typed task handles and host workpool sugar (#1646)

### What changed

- `src/bridges/agent-bridge.ts` validates structural `task_id`/`run_epoch` details and removes all final-handle prose fallback. Background failures raise `invalid_task_handle`; foreground text/schema behavior is unchanged.
- The JS/Python/Ruby/Julia preludes forward `workpool` create/push/close/inspect/cancel through the existing host-tool surface and retain only an opaque pool ID. Task handles retain the host epoch in every language.
- `src/bridge/http-server.ts`, `src/tool/cell-handler.ts`, and the kernel error transports preserve typed error codes. Missing workpool hosts produce `workpool_unavailable`.
- The eval helper documentation describes engine ownership and explicit close; `scripts/qa/omp-item2.ts` exercises all kernels and the separately built local O2 plugin without paid calls.

### Why

- Multiple task IDs in prose must not bind the wrong task, and kernel reset must not become the owner of engine work. A convenience adapter cannot select a worker default or emulate missing aggregate support.

### Why an extension could not handle it

- These bridge result boundaries and embedded prelude globals are owned by codemode. The engine itself remains an external host tool; no orchestration package is imported by product code.

### Expected merge conflict zones

- LOW: agent result validation, prelude helper installation, typed error forwarding, and helper documentation. No kernel scheduler, reserved bridge, task polling, or isolation changes.

## 2026-09-15 - Static detached cards and self-stopping live ticker (#1696)

### What changed

- `packages/senpi-codemode/src/tool/render.ts` narrows `isLiveCellStatus` to `pending`/`running`, so detached cell cards render static (frozen elapsed time) instead of arming the 1 Hz repaint ticker forever.
- `PlainTextComponent` gains an idle guard: the ticker counts ticks since the last `render()` and stops itself after 60 (a live row repaints every tick, so 60 renderless ticks means the row was dropped by a transcript rebuild or session switch); the next `render()` rearms it.

### Why

- Detached snapshot cards never receive a terminal re-render, so their 1 Hz tickers ran for the session lifetime; rows dropped by transcript rebuilds had no dispose path and accumulated intervals. Measured idle sessions burned 2-8% CPU each on leaked repaint timers.

### Why an extension could not handle it

- The ticker is an internal component lifetime decision; extensions see neither the render component contract nor the host's row-replacement cycle.

### Expected merge conflict zones

- LOW: `render.ts` ticker block and `isLiveCellStatus`. Rendered output for pending/running/terminal cards is unchanged; detached cards keep their icon and label with a frozen elapsed value.

## 2026-09-15 - Bound eval-cell, tool-call, and display retention (#1695)

### What changed

- `packages/senpi-codemode/src/tool/detached-cell-manager.ts` moves settled cells out of the live registry into a 32-entry terminal snapshot LRU (`terminal-snapshot-store.ts`), keeping `peek`/`stop`/`waitForTerminal` answerable for recent cells while `dispose` clears both maps; the managed-cell factory moved to `managed-cell.ts`.
- `packages/senpi-codemode/src/kernels/js/context-manager.ts` caps the pull-API pending tool-call queue at 256 (drop-oldest) and clears it on interrupt/reset/close/crash, mirroring the subprocess kernel; `packages/senpi-codemode/src/kernels/shared/subprocess-queue.ts` gains the same cap.
- `packages/senpi-codemode/src/tool/image.ts` caps per-cell display buffers (8 images, 24 MB base64, 64 JSON outputs) with elision counters and a sink note; resize and result marshalling split into `image-resize.ts` and `tool-result-marshal.ts`.

### Why

- Long-lived sessions retained every settled cell (result + closures), every unconsumed tool-call message (full tool arguments), and every display payload for the session lifetime, growing idle session heaps to multiple GB.

### Why an extension could not handle it

- The live-cell registry, kernel message queues, and the per-cell output collector are all internal ownership boundaries; no extension hook sees settled cells, kernel bridge frames, or display messages before retention.

### Expected merge conflict zones

- LOW: `detached-cell-manager.ts` settlement and lookup paths; `context-manager.ts` tool-call branch and lifecycle teardown; `image.ts` display collection. Behavior of active cells, the pull-based `nextToolCall` contract within its 256-message budget, and display ordering under the caps is unchanged.

## 2026-09-13 - Session cwd and authoritative goal-store environment (#1663)

### What changed

- `packages/senpi-codemode/src/kernels/session-env.ts` adds `PI_SESSION_CWD` and optional `PI_GOAL_STORE_FILE` from the extension context, clearing inherited values before applying the active session. The shared subprocess environment carries both to Python, Ruby, and Julia.
- `packages/senpi-codemode/src/kernels/js/worker-core.js` mirrors both keys in its worker-init clearing list, including the isolated inline fallback and children spawned by cells.

### Why

- A kernel's process cwd or session JSONL path cannot identify the authoritative goal store for an overridden session directory or an in-memory session. Consumers need host-resolved values, and an omitted optional value must never expose a stale parent session's path.

### Why an extension could not handle it

- `packages/senpi-codemode/src/kernels/session-env.ts` owns the environment contract at interpreter creation; `packages/senpi-codemode/src/kernels/js/worker-core.js` owns the separate worker environment before cells or their imports run. Consumer extensions cannot sanitize either boundary themselves.

### Expected merge conflict zones

- LOW: `packages/senpi-codemode/src/kernels/session-env.ts` key list, structural context slice, and resolver; `packages/senpi-codemode/src/kernels/js/worker-core.js` mirrored key list. Runtime factory plumbing is unchanged because it already passes the context.

### Tests

- `test/session-env.test.ts`: resolution, optional omission, inherited-value clearing.
- `test/js-kernel-session-env.test.ts`: worker/inline cells and children, inherited-value clearing.
- `test/py-kernel-session-env.test.ts`: subprocess sanitization and live Python/child values.
- `test/extension-session-env.test.ts`: session-start forwarding and exact environment snapshots.

## 2026-09-13 - Steering detaches eligible foreground evaluations (#1637)

### What changed

- `packages/senpi-codemode/src/tool/run-eval-cell.ts` subscribes to the invocation's steering-only signal before acquiring a kernel, checks queued steering at readiness, and reuses the idle watchdog's successful detach transition. Failed steering admission preserves the foreground wait without cancellation. The listener is removed when the foreground call returns or rejects.
- `packages/senpi-codemode/src/tool/detached-cell-manager.ts` refuses a detach when its language already has a detached owner, preserving the existing one-slot limit at the transition itself.

### Why

- Queued steering should release the interactive turn without killing computation or in-flight bridge work. Boot-time steering must not be lost, and a colliding detach must not replace another cell's ownership.

### Why an extension could not handle it

- `packages/senpi-codemode/src/tool/run-eval-cell.ts` owns the foreground wait and cancellation separation; `packages/senpi-codemode/src/tool/detached-cell-manager.ts` owns atomic detached admission. Neither transition is replaceable from a consumer extension.

### Expected merge conflict zones

- LOW: `packages/senpi-codemode/src/tool/run-eval-cell.ts` around idle detachment, kernel readiness, and foreground settlement.
- LOW: `packages/senpi-codemode/src/tool/detached-cell-manager.ts` around `detach()` admission. No kernel queue, capacity setting, or deadline duration changes.

## 2026-09-11 - Column-capped eval output keeps a recovery artifact

### What changed

- `src/output/streaming-output-buffer.ts` and
  `src/output/streaming-output.ts`: raw output now starts the existing spill
  artifact when the per-line column cap drops bytes, even if the total output
  has not crossed the spill threshold.
- `src/prompt/eval-prompt-template.ts`: large text guidance now directs eval
  callers to bounded chunks or offset-based file reads and treats truncation
  notices as incomplete output.
- `test/output/streaming-output.test.ts`: column-cap truncation proves that the
  preview remains bounded while the artifact contains the complete raw stream.

### Why

- A long `console.log` line can be truncated by the output column cap before
  the spill threshold. Without an artifact, the model has no reliable way to
  recover the omitted bytes.

### Why an extension could not handle it

- The column cap and raw-stream mirroring are owned by `OutputSink` before the
  eval tool result and notice are built; an external extension cannot recover
  bytes that the sink never writes.

### Expected merge conflict zones

- LOW in `src/output/streaming-output.ts` around `push()` and `#mirrorRaw()`.
- LOW in `src/prompt/eval-prompt-template.ts` and
  `test/output/streaming-output.test.ts`.

## 2026-09-10 - Every eval cell gets a run budget; `timeout` is that budget

### What changed

- New `src/timeouts/run-budget.ts` (`RunBudget`): a pausable, cumulative watchdog over a cell's own execution time. Unlike `IdleTimeout` it does not restart after each host tool call; it charges only un-parked time (nested pause depth), fires once with a `TimeoutError` naming the budget, and is disposable.
- New `src/tool/cell-deadlines.ts` (`CellDeadlines`): the wall-clock hard limit timer moved here out of `detached-cell-manager.ts`, next to the run budget; first expiry wins and disarms the other. `EvalDetachedCellManager` creates one per cell at `create()` (hard limit = `max(hardLimitSeconds, timeout)`, run budget = `timeout ?? runBudgetSeconds`), exposes `pause(cell)`/`resume(cell)`, and routes both expiries through the existing foreground (`onKill` -> `CellExecution.cancel`) and detached (`#cancel` -> `kernel.interrupt`) paths. The snapshot carries `runBudgetSeconds` when the budget killed the cell and the completion notification says so.
- `src/config/settings.ts`: `runBudgetSeconds` (default 300, `SENPI_CODEMODE_RUN_BUDGET_SECONDS`, `resolveRunBudgetSeconds`); the three env resolvers share one parser.
- `src/tool/run-eval-cell.ts` (split out of `eval-tool.ts`, which sat at 258 pure LOC) and `cell-execution.ts`: the idle watchdog is now optional and only interactive calls get one, with `timeoutMs = min(cellTimeoutSeconds, foregroundWindowSeconds)`; `timeout` no longer feeds it. `timeout-pause`/`timeout-resume` status frames are forwarded to the manager as well as the idle watchdog.
- `src/tool/types.ts`: the `timeout` and `on_timeout` descriptions are rendered from `EvalDeadlineSeconds` (run budget, effective detach point, hard limit) so a settings or env override shows in the tool contract. `src/prompt/eval-prompt-template.ts` (template split out of `eval-prompt.ts`) states the run budget and the kernel-loss cost of a kill; `index.ts` threads `runBudgetSeconds` into both tool registrations and both cell managers.

### Why

- A detached js cell had no bound on its own work short of the 1800s bash-parity hard limit, while one running cell blocks its whole language kernel and a killed js cell that cannot settle (a pending `Bun.$`, a sync call) restarts the worker with every global lost. Observed 2026-09-10: two `find` walks over a 450-node_modules volume held the js kernel for 10.5 minutes, then the same mistake in the py kernel; the model had no number to reason against because the schema named none. Five minutes of own execution time is the default now, host tool calls are exempt so `agent()` DAG cells keep working, and the contract is in the schema.
- `timeout` carried two meanings (detach budget capped at the window, plus a hard-limit raise) that matched neither bash nor the model's intent ("let it run this long"). It is now one thing: the cell's run budget, bash's kill-deadline reading.
- Print/json calls used to die at a 30s idle watchdog; they are now bounded by the same run budget as interactive cells, so a `timeout` means the same thing in every mode.

### Tests

- `test/run-budget.test.ts`: cumulative accounting, parked time not charged, nested pauses, orphan resume, dispose, single fire.
- `test/eval-run-budget.test.ts`: detached kill and notification, parked survival with resumed counting, hard limit while parked, explicit `timeout` both directions, detach at the idle budget with a larger `timeout`, print-mode kill by the budget, kernel status frames freezing the budget, in-budget completion.
- `test/eval-schema-deadlines.test.ts`: configured numbers reach the schema descriptions and the eval description.
- Contract updates: `eval-detach` (print mode), `eval-foreground-window` (window caps the idle budget), `eval-hard-limit` (explicit timeout raise measured on a parked cell), `eval-tool-timeout-state` / `eval-bridge-finalization` / `eval-tool-interrupt` (budget message), `config`, `interpreter`, `extension`, prompt snapshot.

## 2026-09-09 - Eval description teaches cell mechanics; routing moved to the presets

### What changed

- `src/prompt/eval-prompt.ts`: every dialect block (`<eval_first_batching>`, `<gpt_eval_dialect>`, codex, kimi, default) drops the "default execution surface / one cell per multi-call step / never a chain / return ONLY distilled facts" wording and keeps mechanics: batch a step's independent calls in one cell with `parallel(thunks)`, write real code around them, keep every failed or missing item in the result verbatim, re-read truncated output before deciding, and (with monitor) start long-running work through `tool.monitor`. `BATCHING_GUIDELINES` are one-line pointers without capitals. The routing decision (what is batched, what runs one at a time and is observed) now lives once, in the model's preset.
- `test/prompt.test.ts`: the guideline equality uses the new default line; dialect markers are checked by tag and by shape (no all-caps words of five or more letters in the Kimi instruction, no `NEVER` in the default instruction) instead of pinned slogans.

### Why

- The same instruction rendered in three homes per session (tool description, preset rule, system guideline). Prompt-engineering skill: one home per rule; the description is the right home for mechanics because it renders for every model, the preset for routing because that wording is per model. Distilled-only returns hid the detail the next step needed in 14% of sampled cells (2026-09-09 census), so the description now names the failure-verbatim rule instead of "return ONLY distilled facts". o200k: default 1396 -> 1278, claude 1390 -> 1291, kimi 1397 -> 1277, codex/gpt 1325 -> 1321.

## 2026-09-07 - Bun.spawnSync inherits the pinned session environment

### What changed

- `src/kernels/js/worker-shell-capture.js` wraps `Bun.spawnSync` under the same environment pin gate as `Bun.spawn`: when a session environment was applied and the call passes no explicit `env`, the worker's `process.env` view is injected (array and object call forms); explicit `env` is left untouched and the original is restored on uninstall.

### Why

- Measured on Bun 1.4.0: a Worker's `process.env` writes are visible to `Bun. and `node:child_process` but not to `Bun.spawn`/`Bun.spawnSync` without an explicit `env`, which inherit the OS environ. The 2026-09-07 session-environment change covered `Bun.spawn` only, so a cell using `Bun.spawnSync` could still route per-session tooling (e.g. the omo ulw-loop toolkit keyed on `PI_SESSION_ID`) to the wrong scope.

### Tests

- `test/js-kernel-shell-capture.test.ts`: pinned / explicit-env / object-form `spawnSync` cases and a no-session pass-through plus restore case (fake Bun records `spawnSync` calls).
- `test/js-kernel-session-env.test.ts`: the worker + inline matrix runs a real `Bun.spawnSync` child when the cell runtime is Bun.


## 2026-09-07 - Eval kernels carry the session environment

### What changed

- New `src/kernels/session-env.ts` resolves the per-session `PI_*` environment (`PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`) from the extension session context and merges it over the inherited environment with the bash tool's delete-then-set semantics.
- `runtime-factory` resolves the environment at session start and threads it through `CreateCodemodeSessionManagerOptions.sessionEnv` into every kernel: the JS worker applies it to its own `process.env` at worker init (so `env()`, `process.env`, `Bun.$`, `Bun.spawn`, and `child_process` children all see it), and the py/rb/jl interpreters spawn with it merged into their environment (so `os.environ` and their children see it). Restarted or reset interpreters re-apply it because it is a kernel option, not a one-shot spawn side effect.
- Under Bun a `delete process.env.X` does not unsetenv, so `worker-shell-capture.js` additionally pins the worker's environment view (`$.env` seed plus explicit `env` on captured `Bun.spawn` calls without one) whenever the session environment deleted inherited keys; without this, children would still see deleted `PI_*` values in the OS environment.

### Why

- A child spawned from an eval cell saw no `PI_SESSION_ID`, so `omo-agent-toolkit ulw-loop` invoked from a cell resolved the cwd-global state instead of the active session — a real data-corruption path. The contract is that a child spawned from eval sees the same session environment a child spawned from the `bash` tool sees; the core exposes no importable helper for that set (its bash implementation is private and the host package is a type-only dependency here), so the five-key contract is mirrored in one documented helper.

## 2026-09-07 - Fail clearly when compiled codemode assets are missing

### What changed

- Kernel runtime asset resolution now rejects Bun virtual paths and reports the missing codemode sidecar beside the executable, while skill contribution resolution remains non-throwing.

### Why

- Compiled binaries cannot pass embedded `/$bunfs` paths to workers or subprocesses; the actionable error identifies the expected sidecar asset and deployment fix.


## 2026-09-06 - Bun eval description steers away from Bun.spawnSync

### What changed

- `src/prompt/eval-prompt.ts`: the Bun runtime sentence gains one instruction after the WebView
  clause: "Shell out through `Bun.$` or `Bun.spawn`, never `Bun.spawnSync`: a synchronous child blocks
  the worker, so a stop or timeout then loses every variable."

### Why

- Session audit (#1403): models wrapped shell commands in `Bun.spawnSync` inside cells; a worker blocked
  in a synchronous call cannot honour `interrupt`, so the stop that #1406 made bounded still has to
  replace the worker and drop its globals. The model cannot derive the worker-thread limit; the async
  forms settle cooperatively and keep the kernel.

### Why an extension could not handle it

- Prompt text owned by this package; no runtime behavior changed.

### Expected merge conflict zones

- LOW: fork-only description text.

## 2026-09-06 - JS kernel: cooperative interrupt, bounded stop, stdin isolation (#1403)

### What changed

- `src/kernels/js/worker-core.js`: handles the `interrupt` bridge message. It emits an
  `interrupt-ack` status at once, rejects every pending bridge `tool.*` call and any later call from
  the same cell with `CellInterruptedError` (`JS cell interrupted: <reason>`), and asks the runtime to
  kill the cell's children, so a cell parked on a bridge call or a spawned child settles without
  losing the worker.
- `src/kernels/js/worker-runtime.js`: tracks `Bun.spawn` children created during the active cell
  (forgotten when they exit or the cell ends) and kills the live ones on `interrupt()`.
- `src/kernels/js/worker-shell-capture.js` (+ `.d.ts`): while a cell is active every `Bun.$`
  template is framed as `true | (\n<template>\n)` so no command inherits the host's terminal as
  stdin; `Bun.spawn` children are reported through the new optional `onChild` hook.
- `src/kernels/js/context-manager.ts`: `interrupt()` and the kernel timeout go through
  `#stopActive` - post `interrupt`, wait for the ack (`INTERRUPT_ACK_MS`) and then the settlement
  grace (`JS_INTERRUPT_GRACE_MS`), and only replace the worker when the cell stays unsettled;
  the host-composed result (`interruptResult`) wins over the worker's own error text; a worker
  abandoned at the termination deadline gets a stderr note into the cell output. The worker
  generation moved to `src/kernels/js/worker-slot.ts` (startup with inline fallback, message
  fencing, bounded retirement) and the startup sequence to `src/kernels/js/worker-startup.ts`
  (also the new home of `resolveJsWorkerEntryUrl`, re-exported from `context-manager.ts`).
- `src/kernels/js/interrupt-bounds.ts`: `awaitCooperativeSettlement`, `retireWorker` (bounded by
  `WORKER_TERMINATE_DEADLINE_MS`), `abandonedWorkerNote`.
- `src/kernels/js/run-queue.ts`: pending runs carry `settlement`, `interruptResult`,
  `interruptAck`, `settledByWorker`; `settleAll` prefers the in-flight interrupt result.
- `src/bridge/reserved.ts`: `INTERRUPT_ACK_OP`.
- `src/tool/detached-cell-manager.ts`: `stop` and the hard limit cancel through `#cancel`, which
  parks the completion notification (`interruptOutcome`) until the kernel reported whether state
  survived and keeps the handle's `note`; the public snapshot/notifier/options interfaces moved to
  `src/tool/detached-cell-contract.ts` (re-exported) and the status/wake-source projections to
  `src/tool/detached-cell-status.ts`; `src/tool/detached-notification-queue.ts` awaits async
  snapshots; `src/tool/detached-cell-snapshot.ts` and `src/tool/detached-eval-result.ts` carry
  `interruptNote` into the stop result.
- `src/tool/cell-execution.ts` + `src/tool/interrupt-note.ts`: the foreground timeout path keeps the
  whole interrupt handle (`interruptHandle`) so `describeTimeoutState` can wait for a bounded stop
  and append the kernel's note; `src/tool/types.ts` adds the optional `note` to
  `KernelInterruptHandle`.
- `src/tool/detached-cell-notification.ts`: the state note comes from `interruptionStateNote` /
  `unknownInterruptionStateNote` (`src/tool/interrupt-note.ts`) instead of a per-language constant.

### Why

- Audit of 30k eval calls (#1403): `stop` on a worker blocked in `Bun.spawnSync` hung the tool call
  (51 min in production) because `worker.terminate()` had no deadline; `Bun.$` inherited the TUI's
  stdin so `cat`, ssh/git prompts, and keychain dialogs blocked cells forever; every interrupt or
  timeout wiped the VM and the note claimed the worker was "unresponsive" without ever asking it.
  Python already preserves state on SIGINT; JavaScript now matches it where the cell can settle and
  tells the truth where it cannot.

### Why an extension could not handle it

- Interrupt delivery, worker lifecycle, and the shell wrapper live inside the kernel package's
  worker protocol; no extension can reach the worker thread or the run queue.

### Expected merge conflict zones

- MEDIUM: `src/kernels/js/context-manager.ts` was split; an upstream change to worker startup or
  interrupt lands in `worker-slot.ts` / `worker-startup.ts` / `interrupt-bounds.ts` now.
- LOW: `worker-core.js`, `worker-runtime.js`, `worker-shell-capture.js`, `detached-cell-*.ts`.

## 2026-09-05 - Explain eval's run-only language requirement

- The live and exported eval schemas describe `language` as required for runs,
  with no default kernel, while keeping it optional for `peek` and `stop`.
- Request parsing distinguishes an omitted language from an unsupported value
  and lists the supported language identifiers for invalid values.
- The README documents explicit language selection for runs and language-free
  `peek`/`stop` requests.
- Regression: `test/eval-request-language.test.ts` covers distinct diagnostics,
  omitted run languages, and language-free control requests. Fixes #1395.

## 2026-09-05 - GPT eval dialect routes waits through tool.monitor

### What changed

- `src/prompt/eval-prompt.ts`: in `<gpt_eval_dialect>` the `tool.monitor` line moves ahead of the
  detach line and reads "A wait or a long run (build, test run, deploy, watch) starts through
  `tool.monitor({ command, filter })` in that same cell with the decisive-line filter; its event wakes
  the turn, so no cell sits on the wait and no child is spawned for it." The detach sentence is
  unchanged and now describes computation cells. The GPT batching guideline (the line senpi renders
  under `## Tool Guidelines`) becomes monitor-aware: with `monitor` reachable it reads "Use eval to
  compose tool work in one cell; a wait or a long run starts through `tool.monitor` in that cell, so
  no cell sits on it and nothing polls."; without it the previous detach wording stays.
- `test/prompt.test.ts`: pins the monitor-aware guideline copy for `gpt-5.6` with `monitor: true`,
  and that the gpt description names `tool.monitor(` before "detach on timeout" and carries "no cell
  sits on the wait". Existing gating and dialect assertions are unchanged.

### Why

- The GPT guideline said "long cells detach on timeout and notify on completion, so do not poll" -
  the only wait mechanism the system prompt named for GPT models, while the subscription route lived
  three lines down in the tool description. A multi-round backtest against the real `gpt-6-astra`
  (eval-only tool shape) showed the consequence on a CI-then-merge request: 2 of 3 samples awaited
  `gh pr checks --watch` through `Bun.spawn` inside a cell, a form the guideline sanctioned. Two routes
  for one situation is the contradiction the GPT-5.6 guide warns about; the guideline now names the
  route, the description states the cost once (a cell that waits holds the kernel; a child spawned
  to watch burns a session), and the detach fact stays as mechanics rather than advice.

### Why extension system couldn't handle this differently

- Prompt text owned by this package; no runtime behavior changed.

### Expected merge conflict zones on next upstream sync

- LOW: fork-only dialect text and its test.

## 2026-09-04 - eval tool description diet, second pass

### What changed

- `src/prompt/eval-prompt.ts`: the `Fields:` block is gone; the description names the enabled
  `language` values and defers every per-field rule (`summary`, `timeout`, `on_timeout`, `reset`,
  `action`) to the parameter schema, which already carries each of them. The detach paragraph is one
  sentence pair (what detaches, how to peek/stop). Helper doc lines drop restated words but keep every
  signature; the `<workflow>` block keeps the graph rules in one sentence each. The `jl` handle form
  now gets a separator when it follows `py`/`js` (`/ \`handle=true\``), fixing a fused
  `}\`\`handle=true\`` render that the all-languages snapshot had pinned.
- `test/prompt.test.ts` + snapshot: the field-semantics test now asserts the schema is the single home
  (no `- \`timeout\``/`\`on_timeout\`` in the description) and that the guideline still states reset
  scope; the handle-form test gains the four-language case and rejects the fused `jl` form.

### Why

- After the first diet the gpt/codex dialect still rendered 1,489 o200k tokens (description +
  guidelines, py+js, spawns). The `Fields:` list restated the parameter schema word for word (198
  tokens of schema text billed twice), and the detach/busy-kernel text said the same thing in three
  places. Every deleted sentence has a surviving home; no helper signature or dialect block changed.

### Why an extension could not handle it

- The description is built inside this package's `buildEvalPrompt`; there is no hook that lets an
  outer extension shorten a tool description it does not own.

### Expected merge conflict zones

- LOW: `EVAL_PROMPT_TEMPLATE` prose and the three snapshot files. Upstream pi has no codemode
  package, so the zone is fork-only.

## 2026-09-04 - eval tool description diet

### What changed

- `src/prompt/eval-prompt.ts`: dropped `REUSE_CHAIN_EXAMPLES` (three embedded JSON call examples), collapsed the `<workflow>` block to one dense rule sentence, merged the three state-persistence restatements into one, tightened the timeout/on_timeout/hard-limit/detach prose, and removed the per-dialect "sleeping/timed retries are not waiting" clause from the monitor bullets (the terminal section owns that doctrine). Helper signatures and dialect selection are unchanged. Fixed the workflow block's fused `handle=True{ handle: true }` into per-language correct forms.
- `test/prompt.test.ts`: removed the reuse-chain filter test (its subject is gone), added the handle-form regression test, regenerated snapshots.

### Why

- The description cost ~2.0k tokens on every eval-enabled turn; the cuts are content the model already does by default or that the terminal section states. codex dialect 2002 -> 1588, claude 2058 -> 1648, kimi 2073 -> 1668, default 2079 -> 1668 (o200k).

### Expected merge conflict zones

- LOW: `eval-prompt.ts` template and the prompt snapshots; regenerate snapshots rather than merging.


## eval foreground window caps the interactive detach budget (2026-09-04)

### What changed

- `packages/senpi-codemode/src/config/settings.ts` adds `foregroundWindowSeconds` to the settings schema, `CodemodeSettings`, `defaultCodemodeSettings` (`60`), and `mergeSettings`, plus `DEFAULT_FOREGROUND_WINDOW_SECONDS`, `FOREGROUND_WINDOW_ENVIRONMENT_FLAG` (`SENPI_CODEMODE_FOREGROUND_SECONDS`), and `resolveForegroundWindowSeconds()` mirroring the hard-limit resolver.
- `packages/senpi-codemode/src/tool/eval-tool.ts` computes the timeout behavior first, then clamps the detach watchdog budget to `min(timeout ?? cellTimeoutSeconds, foregroundWindowSeconds)` only when the behavior is `"detach"`; `"error"` keeps the unclamped deadline. The wall-clock hard limit (`max(hardLimitSeconds, timeout)`) is untouched.
- `packages/senpi-codemode/src/tool/eval-tool-options.ts` adds the optional `foregroundWindowSeconds` factory option; `packages/senpi-codemode/src/index.ts` passes `resolveForegroundWindowSeconds(...)` at both eval registration sites.
- `packages/senpi-codemode/src/prompt/eval-prompt.ts` and `packages/senpi-codemode/src/tool/types.ts` document that `timeout` is the detach budget capped at the foreground window and that a larger value extends the hard limit, not the foreground block.

### Why

- A real session passed `timeout: 7000` to keep a long detached orchestration cell alive; because `timeout` had no cap it blocked the agent loop for ~2h and then hit the 7000s hard limit, killing the cell and restarting the kernel. The bash tool already separates a 60s foreground window from the kill deadline; eval had no equivalent, so `timeout` did the worst of both worlds.

### Why an extension could not handle it

- The detach-vs-error decision and the idle watchdog budget are computed inside this package's `runEvalCell`; no downstream hook can re-cap the detach timer before the cell is scheduled, and the setting must live in this package's settings schema and registration path.

### Expected merge conflict zones

- LOW in `src/config/settings.ts` around the settings schema, defaults, and resolver functions.
- LOW in `src/tool/eval-tool.ts` around the `timeoutMs` computation in `runEvalCell`.
- LOW in `src/index.ts` at the two `createEvalTool` registration sites.
- LOW in `src/tool/types.ts` and `src/prompt/eval-prompt.ts` around the `timeout`/`on_timeout` descriptions.


## Eval description subscribes to monitor events when available (2026-09-03)

### What changed

- `packages/senpi-codemode/src/prompt/eval-prompt.ts` adds a capability-gated monitor-subscription bullet to each emphasis dialect and folds filter/join/aggregate wording into the existing result-reduction bullets.
- `packages/senpi-codemode/src/tool/eval-tool-options.ts` carries the optional `monitor` capability, and `packages/senpi-codemode/src/tool/eval-tool.ts` forwards it to prompt construction.
- `packages/senpi-codemode/src/index.ts` detects `monitor` in `pi.getAllTools()` for session-runtime eval registration; the pre-extension fallback registration passes `false` deliberately because monitor is not loaded yet.
- `packages/senpi-codemode/test/prompt.test.ts` asserts both gated directions across all five dialects, and `packages/senpi-codemode/test/__snapshots__/prompt.test.ts.snap` records the intentional result-reduction wording change.

### Why

- With monitor reachable only through an eval cell, the eval description is the only model-facing surface that can teach the callable `tool.monitor({ command, filter })` form and the event-driven wait stance without naming an unavailable tool. The existing monitor rule is being removed from the preset, so this compact addition preserves the contract while consolidating result reduction.

### Why an extension could not handle it

- The description is composed by the eval tool factory before the model can invoke a cell; an external extension cannot add a capability-gated instruction to that tool's registered description or change its dialect rendering.

### Expected merge conflict zones

- LOW in `src/prompt/eval-prompt.ts` around the dialect template, `src/tool/eval-tool-options.ts` and `src/tool/eval-tool.ts` around prompt options, and `src/index.ts` around baseline/session-runtime eval registration.

## Bun child-process output stays inside the JS cell (2026-09-03)

### What changed

- New `src/kernels/js/worker-shell-capture.js` (+ `.d.ts`): `installShellCapture({ isActive, emitText })` replaces `Bun.$` and `Bun.spawn` on the worker's `Bun` global. While a cell is active, every `Bun.$` promise is switched to native quiet mode before its command starts and its captured stdout/stderr are echoed once into the cell's `text` stream when it settles — unless the cell reads it through `.quiet()`/`.text()`/`.json()`/`.lines()`/`.arrayBuffer()`/`.bytes()`/`.blob()`, which Bun itself keeps silent. Shell-level `env`/`cwd`/`nothrow`/`throws` chain on the captured shell; the `Shell`/`ShellPromise`/`ShellError`/`braces`/`escape` statics are carried over. `Bun.spawn` calls that leave `stderr` at its default get `stderr: "pipe"` and the pipe is drained into the cell's stderr stream; explicit `stderr`/`stdio` choices pass through. Outside an active cell both surfaces behave exactly as before (inline-worker mode shares the host globals). On Node the installer is a no-op.
- `src/kernels/js/worker-runtime.js` installs the capture beside the existing `console`/`process.stdout.write` routing and restores it from `__senpi_restore_console__`.
- `test/js-kernel-shell-capture.test.ts` pins the contract against a fake that mirrors the verified Bun 1.4 `ShellPromise` behavior (lazy start on `then`, internal quiet for the read methods, same-object chaining); `test/js-kernel-shell-capture-bun.test.ts` runs the real kernel under `bun` (skipped when `bun` is absent) and asserts the markers never reach the driver's fd 1/2.

### Why

- Bun's shell streams a command's output to the process' fd 1/2 unless `.quiet()` is applied or the output is read through a `.text()`-style helper (verified on bun 1.4.0: `await Bun.$\`echo x\`.nothrow()` prints `x` to stdout AND captures it), and `Bun.spawn` defaults `stderr` to `inherit`. Inside the JS kernel those fds are the interactive TUI's terminal, so a cell doing `await $\`vibe-notion page get … --pretty\`.nothrow().then(r => r.stdout)` dumped the whole pretty-printed JSON onto the screen (observed 2026-09-03: a Notion page's block JSON landed in the user's editor and was pasted into the next prompt). The existing `routeWrite` only intercepts JS-level `process.stdout.write`; native child-output writes bypass it.
- Echoing the captured output into the cell instead of only silencing it keeps Bun's documented "the output is visible" semantics at the correct sink, consistent with how `console.log` is routed today.

### Why an extension could not handle it

- The worker's `Bun` global and the cell-activity gate (`#hooks`) live inside this package's worker runtime; nothing outside the worker can wrap `Bun.$` before a cell's first `then` or attribute an emission to the running cell.

### Expected merge conflict zones

- LOW in `src/kernels/js/worker-runtime.js` around `#installGlobals` (import plus install/restore lines).
- NONE for the new module and tests.
## Binary skill resolution and stdout-safe miss reporting (2026-09-02)

### What changed

- `packages/senpi-codemode/src/extension/skill-contribution.ts` resolves the bundled
  `bun-1-4` SKILL.md through `resolveCodemodeRuntimeAsset`, so a compiled binary falls
  back to the sidecar at
  `node_modules/@code-yeongyu/senpi-codemode/src/skill/bun-1-4/SKILL.md` next to the
  executable instead of only probing the embedded module-relative path.
- The "skill not found" notice moves from `console.debug` to `console.error`.
- `test/bun-skill-contribution.test.ts` pins both contracts: sidecar resolution in a
  compiled-binary layout, and stderr-only reporting with stdout untouched.

### Why

- The compiled binary has no readable module-relative asset, so the skill was silently
  skipped for every binary user, and the notice was written to stdout - the same stream
  that carries the RPC JSONL protocol. `scripts/smoke-standalone-binary.mjs` parses that
  stream and failed with `received malformed RPC output`, which failed the `Build binaries`
  job of `build-binaries.yml` and skipped its final `Dispatch publish-npm.yml` job. Both
  the v2026.9.2 and v2026.9.2-2 tag runs failed this way, so neither release reached npm.
- The Ruby and Julia kernel runners already resolve their assets through the same sidecar
  helper; this brings the skill asset onto that established path.

## Eval QA owns its temporary agent directory (2026-08-30)

### What changed

- `packages/senpi-codemode/scripts/qa-e2e-eval.ts` now always creates its own
  temporary agent directory instead of reusing an inherited
  `SENPI_CODING_AGENT_DIR`.
- `test/qa-e2e-eval-sandbox.test.ts` runs the real QA driver with an external
  sentinel agent directory and proves the directory remains unchanged after
  the driver exits.

### Why

- A QA command launched from an active Senpi or branded Omo session inherits
  the live runtime's agent directory. The driver previously treated that path
  as QA-owned scratch space, wrote test settings into it, and recursively
  removed it during cleanup.
- In the observed incident, deleting the live sessions directory made the
  running UI appear to open a new session. The surviving processes recreated
  headerless JSONL fragments, so the resume picker no longer found the recent
  sessions.

### Why an extension could not handle it

- The destructive path selection and cleanup happen in the standalone QA
  driver before extension behavior can impose a filesystem boundary. The
  driver itself must create and own the paths it removes.

### Expected merge conflict zones

- LOW in `scripts/qa-e2e-eval.ts` around sandbox setup and cleanup.
- LOW in the new focused QA sandbox regression test.

## Compiled eval kernels resolve runtime assets from the sidecar (2026-08-27)

### What changed

- JavaScript worker entries and the Python prelude now resolve through the compiled-runtime sidecar, matching the existing Ruby and Julia kernel behavior.
- Added coverage for all three assets in the compiled runner path tests.

### Why

- Bun-compiled eval kernels received `$bunfs` paths that are not usable by `Worker` or an external `python3` process. The staged sidecar provides real filesystem paths next to the compiled executable.

### Expected merge conflict zones

- LOW in the JavaScript and Python kernel asset resolution paths and compiled runner path tests.

## Session teardown failures stay out of lifecycle handler rejections (2026-08-25)

### What changed

- `SessionManagerProxy` catches inner-manager `dispose()` failures in `replace()` and `dispose()` and routes them through an injectable reporter (default: one `[senpi-codemode] session teardown failed: …` stderr line, AggregateError causes inlined) instead of propagating them to the caller.
- `test/session-manager-proxy.test.ts` pins the contract: a replacement installs even when the outgoing manager's dispose rejects, `dispose()` resolves while reporting the failure, and a superseded replacement's dispose failure is contained.

### Why

- A kernel that misses its post-SIGKILL reap window (500ms in `subprocess-process.ts`) makes `subprocess-kernel.close()` throw `KernelRetirementError`; `DefaultCodemodeSessionManager` aggregates it into `Failed to dispose codemode session manager`, and the rejected `session_shutdown`/`session_before_switch` handler surfaced as a user-facing `extension_error` warning in RPC hosts (observed as a Work Log warning row in the omo desktop app). Teardown is best-effort — the interpreter is already SIGKILLed — so the failure is diagnostics, not a session error.
- The inner manager keeps its throwing dispose contract (pinned in `session-manager-lifecycle.test.ts`); only the proxy boundary that lifecycle handlers call absorbs it.

### Expected merge conflict zones

- LOW in `src/extension/session-manager-proxy.ts` around `replace()`/`dispose()`.

## Detached-eval spill notices carry absolute paths (2026-08-23)

### What changed

- `packages/senpi-codemode/src/tool/detached-cell-notification.ts` now writes the plain absolute spill path into the oversized-output notice (`Buffered output overflowed; full output: <absolute path>`) instead of a `local://…` URI. The `localUri` helper and the unused `artifactsDir` parameter on `buildDetachedCellNotification` are gone; `DetachedNotificationQueue` no longer stores `artifactsDir`.
- `test/eval-detach.test.ts` locks the contract: the notice must contain `join(artifactsDir, "local", "detached-eval-<id>.log")` and must not contain `local://`.

### Why

- `local://` is a kernel-helper scheme resolved from the session artifact root inside eval cells (`read()`/`write()` prelude helpers). The agent-facing `read` tool resolves plain paths only, so a model that followed the notice's `local://detached-eval-<id>.log` got `ENOENT: <cwd>/local:/detached-eval-<id>.log`. This reproduces the documented invariant: spill notices contain plain absolute paths, not a custom URI scheme.

### Why an extension could not handle it

- The spill notice text is composed inside this package's notification builder; no downstream hook can rewrite the notice before it is queued to the notifier.

### Expected merge conflict zones

- LOW in `src/tool/detached-cell-notification.ts` around the spill-notice composition and the removed helper.
- LOW in `src/tool/detached-notification-queue.ts` around the constructor and flush mapping.
- LOW in `test/eval-detach.test.ts` around the crash-spill assertions.

## Detached-cell notices deliver as internal custom messages (2026-08-23)

### What changed

- `packages/senpi-codemode/src/extension/eval-notifier.ts` now delivers detached-cell completion notices through `sendMessage` with the new `EVAL_NOTIFICATION_CUSTOM_TYPE` (`senpi-codemode:notification`) and `display: false`, instead of `sendUserMessage`. Wake/next-turn mode still selects `steer` vs `followUp`, and delivery stays once-per-cell per session generation.
- `CodemodeExtensionAPI` requires `sendMessage` in place of `sendUserMessage`; the host binding forwards to `pi.sendMessage`.

### Why

- `sendUserMessage` enqueues into the same steering queue that holds real user input, and that queue carries no provenance. A host projecting it (the OmO desktop composer) rendered the raw `<system-reminder>Detached eval cell ... cancelled.` notice under its STEERING heading as if the user had typed and queued it.
- The sibling injectors already solved this: terminal (`senpi-terminal:notification`), monitor (`senpi-monitor:notification`), and loop-guard notices all use `sendMessage` with a `customType`, documented as "deliver a model-visible notification without rendering synthetic user input". The eval notifier was the sole caller still using the user-input door, so this aligns it with the existing contract rather than adding a new mechanism.

### Why an extension could not handle it

- The notifier is owned by this package and constructed during its extension factory wiring; the delivery door it calls is chosen inside `senpiCodemode`, so no downstream extension can redirect it.

### Expected merge conflict zones

- LOW in `src/extension/eval-notifier.ts` around the deps interface and the notify body.
- LOW in `src/index.ts` around the `CodemodeExtensionAPI` surface and the notifier construction.
- LOW in the codemode test fakes that implement the host API surface.

## Subprocess readiness gates cell execution (2026-08-21)

### What changed

- `packages/senpi-codemode/src/kernels/shared/subprocess-kernel.ts` now keeps Ruby and Julia cells queued until the active subprocess emits `ready`; only then does it write the `run` frame and arm that cell's timeout.
- An `init-failed` frame now fails queued work immediately as a kernel startup error instead of leaving it to an unrelated cell timeout.

### Why

- The shared kernel previously sent `init` and immediately started the first cell's timeout without observing readiness. Under load, interpreter and prelude startup could consume the entire cell budget, time out the state-setting cell, restart into a clean process, and make the following state-read cell fail nondeterministically.

### Why an extension could not handle it

- Subprocess generation ownership, protocol readiness, run queue dispatch, and timeout arming are private to the shared kernel implementation; an extension cannot safely order those lifecycle transitions from outside the package.

### Expected merge conflict zones

- LOW in `packages/senpi-codemode/src/kernels/shared/subprocess-kernel.ts` around process startup and protocol-message dispatch.
- LOW in the Ruby subprocess lifecycle tests that now emit the protocol readiness event explicitly.

## Eval completion throughput badge (2026-08-17)

### What changed

- Final single-cell eval frames now append the exact initiated nested tool-call count, a two-decimal
  calls-per-second rate, and true wall-clock elapsed time to the completed header, for example
  `eval py done ✓ · 2 calls · 1.00 calls/s · 2s · timeout 420s`.
- `EvalToolDetails` carries `wallDurationMs` and `toolCallCount` alongside the existing
  kernel-reported `durationMs`; the renderer uses wall time for final elapsed and throughput while
  preserving kernel duration for consumers that need interpreter timing.
- A cell that initiated no tool calls renders no throughput badge at all: both the count and the
  rate segments are dropped, so the header reads `eval py done ✓ · <1s` instead of
  `eval py done ✓ · 0 calls · 0.00 calls/s · <1s`. Positive calls without a positive wall duration
  render `n/a calls/s`, so the TUI never displays `Infinity` or `NaN`.
- Partial, pending, running, error, and synthetic multi-cell frames do not show a misleading final
  aggregate. The legacy no-cells result path renders the same final metadata when the new fields are
  available and preserves old output when they are absent.

### Why

- The eval extension already measures every nested tool invocation and true end-to-end wall time,
  but users could only see completion duration and per-call rows. Surfacing count and throughput in
  the final header makes eval composition efficiency observable without opening an analytics view.
- Dividing by kernel-reported duration would overstate throughput whenever host tool calls wait
  outside interpreter timing, so the visible elapsed label and the rate denominator share the same
  wall-clock source.

### Why this cannot be expressed externally

- The completed frame is owned by the eval renderer, while exact initiated-call counts and cell
  start time are owned by the eval runtime before the generic tool result reaches any external
  extension. An external renderer cannot reconstruct both facts reliably.

### Expected merge conflict zones

- MEDIUM in `src/tool/render.ts` around `cellHeader`, `renderDetailedLines`, and final result metadata.
- LOW in `src/tool/types.ts` and `src/tool/cell-runtime.ts` around `EvalToolDetails` construction.
- LOW in eval renderer and execution-event tests.

## Eval execution metadata event (2026-08-16)

### What changed

- Every settled eval cell now publishes one versioned `senpi.eval.execution` event. The in-process
  event bus receives the full bounded payload, while the external RPC channel receives a
  metadata-only projection that excludes prompts, arguments, call ids, errors, and result previews.
- The payload records producer timestamps, true end-to-end eval wall time, kernel-reported runtime,
  terminal status, detached status, every initiated nested tool-call count (including calls still
  pending when an error cell settles), distinct tool names, and per-tool aggregate durations.
- Generic and MCP tools retain the existing 30-call enrichment cap while every call still
  contributes to exact counts and aggregates. Reserved agent/output calls now receive the same
  bounded argument and duration capture; internal schema bridge calls preserve their legacy shape.
- Captured names and identifiers are length-bounded, at most 64 distinct names receive individual
  aggregates, excess names roll into an exact overflow aggregate, and the RPC projection has a
  final 32 KiB serialized-byte ceiling with a deterministic aggregate-only fallback.
- Session-generation fencing suppresses events from retired codemode runtimes.

### Why

- OMO needs producer-side timing data to determine whether eval composition and parallel tool calls
  actually reduce round trips and wall-clock time, rather than relying on model-side assumptions.
- OMO can consume rich metadata from the in-process event bus and later publish an explicitly
  redacted or capability-gated desktop projection. The current desktop adapter decodes but ignores
  unknown extension event names, so desktop rendering remains a separate consumer change.

### Why this cannot be expressed externally

- The eval extension owns kernel message dispatch, per-call bridge timing, bounded argument/result
  capture, detached settlement, and session-generation fencing. An external extension cannot
  reconstruct those facts accurately after the eval tool result has returned.

### Expected merge conflict zones

- MEDIUM in `src/index.ts`, `src/tool/eval-tool.ts`, and `src/tool/cell-handler.ts` around runtime
  registration, settlement, and nested tool-call capture.
- LOW in `src/tool/cell-runtime.ts`, `src/tool/eval-tool-options.ts`, and the new event builder.

## Eval cell hard limit (2026-08-13)

### What changed

- A cell now carries a wall-clock kill deadline resolved from the new `hardLimitSeconds` setting
  (default 1800s, `SENPI_CODEMODE_HARD_LIMIT_SECONDS` override), raised per call by an explicit
  larger `timeout`.
- `EvalDetachedCellManager` arms that deadline when the cell is created and clears it only on
  settlement, so it survives `detach()` and is never paused by bridge tool calls. On expiry the cell
  is interrupted, settles as cancelled, and the detached-cell notification tells the main agent it
  was killed at the hard limit.

### Why

- `cellTimeoutSeconds` only feeds the idle watchdog: `CellExecution.detach()` disposes that watchdog
  and `withBridgeTimeoutPause` pauses it for the whole duration of every host tool call, so a
  detached or tool-call-heavy cell had no upper bound at all — one observed cell ran 1h13m. The bash
  tool has enforced a kill deadline since `bash-timeout/timeout.ts`; eval now matches it.

### Why this cannot be expressed externally

- Cell lifetime, kernel interruption, and the detached-cell notification queue all live inside the
  package; an extension cannot observe a detached cell, let alone kill it.

### Expected merge conflict zones

- MEDIUM in `src/tool/detached-cell-manager.ts` around cell creation and settlement.
- LOW in `src/config/settings.ts` schema/defaults and the prompt timeout wording.

## Compiled binary runner sidecar resolution (2026-08-11)

### What changed

- Ruby and Julia kernels now preserve their normal module-relative runner path
  in source/npm execution but fall back to the standalone executable's
  `node_modules/@code-yeongyu/senpi-codemode/src/kernels/...` sidecar when the
  embedded `$bunfs` path does not exist.
- Focused tests pin Ruby, Julia, and non-compiled local-path behavior.

### Why

- The compiled coding-agent embeds the codemode factory and JavaScript
  dependency graph, but Ruby and Julia execute external runner files that Bun
  does not expose at the embedded module's `import.meta.dirname`.

### Why this cannot be expressed externally

- Runner paths are selected inside kernel construction before user code or an
  extension wrapper can replace the subprocess arguments.

### Expected merge conflict zones

- `src/kernels/rb/kernel.ts` and `src/kernels/jl/kernel.ts` runner arguments.
- `src/kernels/shared/runtime-asset.ts` compiled sidecar layout.

## Detached eval cell wake-source contract (2026-08-09)

### What changed

- The duplicated cross-package event literal is now `wake_source_state`, with source `senpi-codemode` and optional per-cell `items` metadata.
- Detached-cell detach, completion, stop, and session-dispose transitions publish the current active count through the optional host `events` passthrough; synchronous cells do not emit a lifecycle transition.
- The focused wiring suite pins event-bus delivery, completion-to-zero, bus-less compatibility, and the exact duplicated literal.

### Why

Goal continuation now aggregates every producer under one wake-source contract, so codemode must use the same event and a stable package-owned source key rather than the retired resumption-channel name.

### Why this cannot be expressed externally

Detach and settlement ownership lives inside `EvalDetachedCellManager`, and only the extension entry has access to the host event bus.

### Expected merge conflict zones

- MEDIUM in `src/index.ts` and `src/tool/detached-cell-manager.ts` around lifecycle snapshot wiring.
- LOW in the duplicated event contract and focused tests.

## Detached eval cell resumption-channel liveness (2026-08-08)

### What changed

- New `src/extension/resumption-channel.ts` duplicates the cross-package `resumption_channel_state` event literal and
  payload type locally; senpi-codemode is a separate package and must not import from packages/coding-agent, so a
  sentinel test pins the literal to catch drift.
- `src/tool/detached-cell-manager.ts`: new optional `onChannelState` callback fires a full per-source snapshot
  (`{ source: "eval-detached", activeCount, channels: [{ id, description, startedAtMs }] }`) on the same transitions as
  the existing `#emitStatus` footer seam (detach / settle / stop / dispose). `description` mirrors the footer label
  fallback (`summary` else cell id). A public `publishChannelState()` re-publishes the current snapshot.
- `src/index.ts`: the local `CodemodeExtensionAPI` widens with an optional `events?: { emit(name, data) }`; emission
  goes through `pi.events?.emit(...)` so hosts without an event bus are a harmless no-op. Both cell-manager
  constructions wire the callback, and the `session_start` handler re-publishes the snapshot because the consuming
  goal builtin clears its per-session counts there.
- `test/eval-resumption-channel.test.ts`: pins the single-cell snapshot, the two-cells-settling count sequence, the
  bus-less host no-op, the `session_start` re-emit plus bus transport, and the event-name sentinel.

### Why

- The goal builtin delays its hidden "keep going" continuation while a live resumption channel is on duty, but it only
  ever learned about terminal monitors. Detached eval cells are a real live channel that reported nothing, so the goal
  nagged itself immediately at turn end while a cell was still computing. This change makes codemode EMIT its liveness;
  a sibling lane owns the consuming side in the goal builtin.
- The legacy `terminal_monitor_state` event keeps its single-owner full-snapshot semantics; emitting it from a second
  source would clobber the terminal's count, so only the new source-keyed event is used.

### Why this cannot be expressed externally

- The liveness transitions live inside the detached-cell manager and the extension entry; an external extension cannot
  observe detach/settle/dispose without reimplementing the cell lifecycle.

### Expected merge conflict zones

- LOW: `src/index.ts` around the cell-manager constructions and the `session_start` handler.
- LOW: `src/tool/detached-cell-manager.ts` around `#emitStatus`.
- MEDIUM: `CHANGELOG.md` `[Unreleased]` when sibling lanes land entries; keep both bullets.

## Compact elapsed labels for simple eval results (2026-08-06)

### What changed

- `src/tool/render.ts`: final eval results without detailed cell records now route `durationMs` through the same compact formatter already used by cell headers, agent progress, and nested tool-call widgets.
- `test/eval-result-duration.test.ts`: focused coverage pins sub-second, seconds, minutes, and hours output plus the surrounding status/summary/phase/output frame.
- Existing renderer-state expectations now preserve the compact `<1s` label for very short completed and failed evaluations.

### Why

- The simple-result branch was the only eval duration surface that interpolated raw milliseconds, producing labels such as `took 3720000ms` while the detailed branch rendered the same duration as `1h 2m`.
- Consistent compact labels make completed tool-call timing readable without changing live footer, working-status, or thinking-duration policies.

### Why this cannot be expressed externally

- The inconsistency lives inside the eval tool's result renderer and must be corrected at the branch that builds transcript metadata.

### Expected merge conflict zones

- LOW: `src/tool/render.ts` around `resultMetadata()`.
- LOW: `test/eval-render-state.test.ts` and `test/eval-result-duration.test.ts`.

## Eval `summary` replaces `title` (2026-08-04)

### What changed

- `title` removed from the eval input surface entirely (schema, `EvalToolInput`, `EvalCellResult`, `EvalToolDetails`, renderers, detached surfaces, prompt, README, tests, QA scripts). Phase/status-event `title` is a different concept and is untouched.
- `summary` is now REQUIRED for run requests: schema property stays optional because the flat schema object is shared with the peek/stop actions, so required-ness is enforced in `parseEvalRequest` exactly like `language`/`code`, with the teaching error: `eval run requires summary — one line in the user's language: what this cell does and for what purpose`.
- The 80-char clamp runs in the `ToolDefinition`'s `prepareArguments` hook, which executes BEFORE schema validation, so an over-long summary can never become a validation error.
- The schema description carries the user-language WHAT+WHY writing guide the model reads at call time.
- Rendering: title-less header, muted summary line beneath it in transcript frames and live-update text; detached footer label is `summary ?? cellId`.
- Back-compat: callers still sending `title` keep validating (value ignored); legacy stored results (title-only details) re-render without a label and without crashing.

### Why

- `title` was decorative metadata the model rarely populated meaningfully; `summary` forces a one-line, user-language description of intent at every run, improving transcript readability and downstream debugging.
- Enforcing required-ness in the parser (not the schema) keeps the shared flat schema valid for peek/stop while still rejecting run requests that omit `summary`.

### Why this cannot be expressed externally

- The change spans the tool schema, request parser, type definitions, renderers, detached-cell manager, status events, prompt instructions, README, and all QA scripts — a single coordinated fork commit.

### Expected merge conflict zones

- `src/tool/types.ts`, `src/tool/eval-request.ts`, `src/tool/eval-tool.ts`, `src/tool/cell-runtime.ts`, `src/tool/render.ts`, `src/tool/detached-cell-manager.ts`, `src/tool/detached-cell-snapshot.ts`, `src/extension/eval-status.ts`, `src/prompt/eval-prompt.ts`, `README.md`, `test/`, `scripts/`.

## Backfill: persistent eval lifecycle and tool surface (2026-08-01)

### What changed

- Eval cells can detach, report state-aware timeouts, and reuse neither active nor completed detached cell IDs.
- Eval now has one normalized tool surface with bounded current-main status history and rich detached-cell peeks.
- Bridge aborts, reserved bridge routing, tool-schema feedback, and tool widgets are handled explicitly.

### Why

- Long-running eval work must remain observable, addressable, and safe across retries, timeouts, and UI rendering.

### Why this cannot be expressed externally

- The contracts span the persistent kernel manager, bridge routing, tool schema, detached notification state, and renderer.

### Expected merge conflict zones

- `src/tool/eval-tool.ts`, detached cell manager/state/notification files, bridge code, status events, and eval rendering/tests.

## Live elapsed footer for detached eval cells (2026-07-31)

- `src/tool/detached-cell-manager.ts`: `ManagedCell` and `EvalDetachedCellStatusEntry` gain
  `startedAtMs` (epoch ms at cell creation); the manager accepts an injectable `now`.
- `src/extension/eval-status.ts`: `formatEvalCellStatus(entries, nowMs)` appends the oldest
  cell's goal-style elapsed label (`↗ py · title (45s)`, `↗ eval 2: a, b (3m)`); the 48-char
  budget and `+N more` packing are preserved.
- `src/extension/eval-status-ticker.ts` (new): `EvalStatusTicker`, same shape as the terminal
  builtin's `MonitorStatusTicker` — 1s unref'd interval, label dedupe, stop-and-clear when the
  last detached cell settles. `src/index.ts` routes `showDetachedCells` through the ticker and
  stops it in `dropRuntime`; `SenpiCodemodeOptions` gains an optional `now` clock for tests.
- Tests: `test/eval-status.test.ts` (elapsed rendering + budget), `test/eval-status-ticker.test.ts`
  (new; interval discipline), `test/eval-status-wiring.test.ts` (footer advances 1s→2s→3s while
  a cell stays detached, clears on completion).


- `src/extension/eval-status.ts` (new): `formatEvalCellStatus(entries)` — undefined when
  no cell is detached, `↗ <lang> · <title>` for one (cellId fallback when untitled),
  `↗ eval N: <packed titles>` for many, 48-char budget with whole-label packing and a
  `+N more` tail. `EVAL_CELLS_STATUS_KEY = "eval-cells"`. Semantics mirror the terminal
  extension's monitor-status so both live watches read the same in the footer.
- `src/tool/detached-cell-manager.ts`: `EvalDetachedCellStatusEntry` plus the
  `onStatusChange` option. Emissions happen only inside `#transition` (the single
  detach/terminal boundary) and in `detach()`, so the listener always observes the
  exact live detached set; an empty array means "clear the status".
- `src/index.ts`: `showDetachedCells` publishes the formatted status through
  `ctx.ui.setStatus("eval-cells", ...)`, highlighted with `selectedBg` in tui mode and
  left plain elsewhere. Hosts that hand a partial ui surface (no theme) fall back to
  plain text instead of breaking the cell lifecycle.
- Tests: `test/eval-status.test.ts` (formatter), new `eval detached cell status
  emissions` block in `test/eval-detach.test.ts` (manager contract), and
  `test/eval-status-wiring.test.ts` (extension → footer wiring through session_start).

## wake_source_state reaches the rpc channel

`emitWakeSourceState` in `src/index.ts` publishes on `pi.rpc` before `pi.events`, mirroring
`onCellSettled`. Out-of-process consumers (rpc mode with `extension_events`) now receive the
live-cell transitions; `test/eval-wake-source.test.ts` pins the rpc case and the wiring test
filters the settle payload instead of asserting an rpc-channel exact list. (#1943)


## 2026-09-23 — Hide eval artifact and truncation renderer warnings

### What changed

`packages/senpi-codemode/src/tool/render.ts`: Remove both renderer-owned artifact/truncation warning paths and omit model-only text from the fallback. Stop pattern-based footer stripping from ordinary output. The existing artifactNotice and formatTruncationWarning helpers do not attach text to model results, so eval model text and grouping stay unchanged.

### Why

Eval bookkeeping should not be duplicated in visible cards or cause ordinary user output to be stripped by resemblance.

### Why an extension could not handle it

These card builders own the rendered details and cannot be corrected by an external extension.

### Expected merge conflict zones

Detailed eval cells and fallback result blocks; no collector, output grouping, or model content changes.

- Covered production paths: `packages/senpi-codemode/src/tool/render.ts`.
