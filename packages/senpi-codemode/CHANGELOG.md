# Changelog

## [Unreleased]

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.10.10-11] - 2026-10-09

### Breaking Changes

### Added

### Changed

- Replaced the plan-authored type assertions the F2 audit listed, in this package's production code and tests, with real types: `EvalKernel` now declares the optional `describeKernelTools` / `invokeKernelTool` capabilities, the JS `WorkerLike` carries an optional `pid`, `bun:ffi` is read through one shared `isBunFfi` guard, the sandbox `credits` buffer is typed as `Int32Array<SharedArrayBuffer>`, the gate allowlist is validated by the existing typebox `allowlistSchema`, and test fakes use `satisfies`, typed factories and narrowing guards instead of casts. No behavior change, except that a malformed base allowlist is now refused by the same schema the head allowlist already required. ([#3005](https://github.com/code-yeongyu/senpi/issues/3005))
- The bench judges `crash-queue-100` on Ruby and Julia by an absolute head budget instead of the head/base ratio: all 100 queued cells must run exactly once after one kernel replacement, with the head's median wall time under 820 ms (Ruby) or 2,700 ms (Julia). Their base never recovered from the crash, so the ratio compared a failure path with the real work. ([#3025](https://github.com/code-yeongyu/senpi/issues/3025))
- A streaming, queued or running eval row now shows the cell's code in a fixed-height block that scrolls upward as lines arrive: the newest line always stays visible, older lines fold into an "N earlier code lines" row counted inside the block, and once output or status events arrive they share the block's rows instead of growing it, so the row never grows the transcript at any terminal width. The header stays one row, keeping the live spinner and render-clock elapsed time (a queued cell keeps its queued badge). Once a cell finishes, errs or is cancelled, the collapsed row is one line (icon, summary, status and duration), and expanding it shows the full code, output and status events. ([#2933](https://github.com/code-yeongyu/senpi/issues/2933))

### Fixed

- Python cells use a C-backed FIFO and one combined stdout/stderr routing scope, reducing per-cell bookkeeping while retaining interpreter ownership, parked-cell callbacks, invocation scope, cancellation, and stale-descriptor fencing ([#3034](https://github.com/code-yeongyu/senpi/issues/3034)).

- Ruby and Julia cells below the host-read memory notice threshold and ceiling no longer walk all globals or serialize an unused memory payload. Above either threshold, successful and raised cells both collect the same bounded globals diagnostic, including when hysteresis suppresses the notice text. Stopping while a finished cell waits for that optional diagnostic now settles its completed result without globals and keeps kernel state. Current-footprint accounting and ceiling enforcement still run on every cell ([#3028](https://github.com/code-yeongyu/senpi/issues/3028)).

- Warm eval cells now recheck the session working directory synchronously instead of awaiting a filesystem thread-pool round trip. Every cell still refuses a deleted or non-directory cwd with the same error, and other filesystem errors still surface; kernel startup retains its asynchronous pre/post checks ([#3033](https://github.com/code-yeongyu/senpi/issues/3033)).

- When a Python, Ruby, Julia or process-isolated JavaScript kernel dies while a frame is being sent to it, the failed write (EPIPE) is reported as that kernel's error instead of surfacing as an unhandled error. Before, that unhandled error could end the host, or make a test run where every test passed exit 1 ([#3016](https://github.com/code-yeongyu/senpi/issues/3016)).

- On macOS and Linux, when a JavaScript eval cell ends or is interrupted, a process its child started and left behind (re-parented to init after the child exited, as with `(sleep 30 &)`) is now stopped too: every process group the kernel gave a cell child is signalled at retirement. The agent's own group is never signalled, nor a group whose leader exited and whose pid was since reused, and children the cell started with `detached: true` are left running ([#3020](https://github.com/code-yeongyu/senpi/issues/3020)).

- On Windows, ending a kernel's process tree (cell timeout, reset, shutdown) no longer uses `taskkill /T`: the tree is computed from creation times and each process is ended by pid, so an older, unrelated process holding a recycled parent pid is never killed ([#2999](https://github.com/code-yeongyu/senpi/issues/2999)).

- `tool_schema("eval:environments")` now documents the `packages.install(manager, requirements, {timeout?})` cell helper that shipped in #2877: the signature (Python spells the option `timeout=`, default 600 s), the managers per language (`pip` for Python; `bun`/`npm` for JavaScript), the receipt fields, cancellation by `stop`, and the `environment_install_timeout` error code it raises. A two-way contract test now keeps every `environment_*`/`eval_isolate_*` code the source raises documented in its owning entry. ([#3003](https://github.com/code-yeongyu/senpi/issues/3003))

- On macOS and Linux, a process started from a JavaScript eval cell with `node:child_process` or `Bun.spawn` now gets its own process group. A cell that later stops that job by its group (`kill -TERM -- -$PGID`) therefore no longer stops the agent itself. Named imports of `node:child_process`, `node:fs` and `node:path` in a cell now get the session cwd handling too. `Bun.$`, `exec`/`execFile` and the synchronous spawners (`spawnSync`, `execSync`, `execFileSync`, `Bun.spawnSync`, which keep the terminal) still share the agent's group, so a command there that signals a process group (including `pkill -g` and `killall`) prints a notice naming the agent's group. The notice is a warning only and never blocks the cell ([#2995](https://github.com/code-yeongyu/senpi/issues/2995)).

### Removed

## [2026.10.10-10] - 2026-10-09

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.10.10-9] - 2026-10-08

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.10.10-8] - 2026-10-08

### Breaking Changes

### Added

- `packages.install(manager, requirements, {timeout?})` in JavaScript and Python cells installs through the same session environment as `%pip install` / `%bun add` / `%npm add` and returns the install receipt; a stop cancels it and the timeout (600 seconds by default) fails it with `environment_install_timeout`.

- `tool_schema("eval:environments")` and `tool_schema("eval:isolation")` document the package magics (`%pip`, `%bun`/`%npm`, `%environment`, `%load`) and isolated cells on demand, with the error codes each one raises. Nothing is added to the eval prompt or its input schema.

### Changed

### Fixed

- The eval timing benchmark's spike retry no longer waits for a load at or above its own refusal ceiling: the settle target is capped at 70, so a run whose calm load was near 80 cannot start its retries straight into another spike and burn them all in seconds. On a host whose normal load is above 70, each retry now waits the full 15 minutes and then retries anyway; the attempt's own spike checks still decide what is kept. ([#2922](https://github.com/code-yeongyu/senpi/issues/2922))

- The eval timing benchmark no longer throws away a whole multi-block run when the host's 1-minute load goes over 80 partway through: only the block that saw the spike is discarded and re-run (up to 3 retries, each after the load has fallen back under 70). A runtime failure in the same block is never discarded with the spike. A block that spikes on every attempt is labelled, making the run inconclusive rather than refused, and the other blocks still report. Re-run blocks are listed in the JSON report's `retriedBlocks`. ([#2909](https://github.com/code-yeongyu/senpi/issues/2909))

### Removed

## [2026.10.10-6] - 2026-10-07

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.10.10-5] - 2026-10-07

### Breaking Changes

### Added

### Changed

- A running, queued or detached eval row now leads with the cell's summary (or its first code line), then the language, state and elapsed time, on one line; the code is shown on expand. A call still streaming its arguments shows that row instead of the raw `eval code="..."` fallback. Completed rows are unchanged ([#2802](https://github.com/code-yeongyu/senpi/issues/2802)).

- A JavaScript cell may declare a name the kernel or platform already defines (`log`, `fetch`, `print`, `URL`, ...): the value persists for your later cells while the kernel and imported libraries keep the original, `delete <name>` restores it, and the cell notes the shadowing ([#2793](https://github.com/code-yeongyu/senpi/issues/2793)).

### Fixed

- A live eval row whose cell has no summary skips a first code line that holds only escape or control characters and leads with the next line that has content, instead of showing only an ellipsis ([#2850](https://github.com/code-yeongyu/senpi/issues/2850)).

- The `require` in a JavaScript cell carries `require.resolve`, `require.resolve.paths` and `require.cache` like Node's own `require`, and the call and `resolve` share one lookup, so they always name the same copy: builtins natively (including Bun's, such as `bun:sqlite`), then the project, then the managed package environment ([#2832](https://github.com/code-yeongyu/senpi/issues/2832)).

- A live eval row whose cell has no summary sanitizes its first code line before measuring it, so escape and control characters in that line never reach the one-line row ([#2839](https://github.com/code-yeongyu/senpi/issues/2839)).

- A live eval row stays one line in every terminal: its headline is measured and cut in screen cells, so a summary with wide characters (Korean, Chinese, Japanese, emoji) no longer wraps a narrow terminal, and a `peek`/`stop` call still streaming in renders `eval peek` instead of `eval peek undefined` ([#2831](https://github.com/code-yeongyu/senpi/issues/2831)).

- Stopping or timing out a JavaScript cell that awaits something that never settles (a promise, a `fetch` whose server never answers, a polling loop on timers, `Bun.sleep` or `node:timers/promises`, a loop of short `Bun.spawn` children) now keeps the worker and every global instead of restarting it. Stop ends the cell and everything it started: its timers are cleared, pending sleeps and `fetch` requests reject, and the sockets, servers, WebSockets, WebViews, nested workers and child processes it opened are closed; the result arrives once its children are gone. A stopped cell's own `catch`/`finally` can no longer print, call tools, start processes, schedule timers or open connections. An unhandled promise rejection no longer crashes the JavaScript kernel: it is reported on the running or next cell, naming the cell it came from, with bursts folded into one line; an uncaught exception still restarts the worker. A cell stopped during a `Bun.$` command still restarts the worker, as before ([#2788](https://github.com/code-yeongyu/senpi/issues/2788)).

- JavaScript cells can call `require(...)` and `createRequire(...)`: builtins, relative CommonJS and JSON files, and packages from the project or the managed package environment resolve as they do for `import` ([#2792](https://github.com/code-yeongyu/senpi/issues/2792)).

- A detached eval cell's completion notification now carries the same output its result would have shown in the foreground (head, tail, elision marker and full-output notice) instead of a 512-byte tail, and images the cell displayed are delivered with the notification ([#2789](https://github.com/code-yeongyu/senpi/issues/2789)).

### Removed

## [2026.10.10-4] - 2026-10-06

### Breaking Changes

### Added

### Changed

### Fixed

- A detached eval cell that waits for its kernel to start now says so (`waiting for the js kernel to be ready`) instead of `queued behind  in the js kernel` with an empty predecessor ([#2790](https://github.com/code-yeongyu/senpi/issues/2790)).

- A stopped (or failed) detached cell's result and notification show its buffered output instead of the live `1/1 cells running` frame, so a cancelled cell no longer reads as still running. The kernel-state note now says plainly whether the kernel was restarted: `The JavaScript worker was not restarted; variables from earlier cells are kept.` instead of `... remains running; its existing variables are preserved.`, or `The JavaScript worker was restarted; variables from earlier cells are lost.` instead of `... was unresponsive to interrupt and was restarted ...` (the worker may have answered the interrupt and still needed a restart) ([#2791](https://github.com/code-yeongyu/senpi/issues/2791)).

- An isolated (`isolate: true`) eval cell's result names QuickJS as its runtime (`quickjs <version>, sandbox`) instead of the persistent kernel's Bun or Node runtime ([#2811](https://github.com/code-yeongyu/senpi/issues/2811)).

### Removed

## [2026.10.10-3] - 2026-10-06

### Breaking Changes

### Added

- An opt-in process-isolated JavaScript kernel (`isolation.js: "process"` or `SENPI_CODEMODE_JS_ISOLATION=process`) runs each JavaScript kernel in its own subprocess instead of a worker thread, so a kernel crash (`SIGSEGV`, out-of-memory, `process.exit`, an uncaught error) can no longer take down the host session; the next cell runs on a replacement child with a restart notice naming the crash. It isolates crashes, not hostile code: a cell is trusted as in worker mode, and hostile code belongs in `isolate: true` sandbox cells ([#2752](https://github.com/code-yeongyu/senpi/issues/2752) tracks hostile-cell isolation). The child runs on the host's own runtime, exits as soon as its host is gone (including `SIGKILL`), carries large output and `BigInt`/`undefined` values as worker mode does, and its frames carry a per-process token so stray output is never taken for a frame. The default stays `"worker"` and worker-mode behaviour is unchanged ([#2452](https://github.com/code-yeongyu/senpi/issues/2452)).

### Changed

- The README now documents every eval surface (helpers, magic cells, settings, JavaScript isolation modes and sandbox cells), and CI checks it against the helper census, so a new helper cannot ship undocumented ([#2787](https://github.com/code-yeongyu/senpi/pull/2787)).

### Fixed

### Removed

## [2026.10.10-2] - 2026-10-05

### Breaking Changes

### Added

- `@code-yeongyu/senpi-codemode/executable-settings.json` lists the settings that name an executable run at session start (today `languages.pyInterpreter`). senpi's project-trust check reads it, so a project codemode file that sets one asks for trust, and a test fails if a new free-form string setting is neither on the list nor marked as not naming an executable ([#2772](https://github.com/code-yeongyu/senpi/pull/2772)).

### Changed

### Fixed

- Settings that were accepted but did nothing now take effect ([#2763](https://github.com/code-yeongyu/senpi/issues/2763)): `kernelTools.enabled: false` makes JavaScript `tool(fn)` and Python `@tool` refuse with `tools_unavailable`; `languages.pyInterpreter` makes the Python kernel run exactly that executable (a path that does not answer makes Python unavailable, with a warning naming the setting; one named by a project's own settings file is honored only in a trusted project); `prompt.advertiseHelpers: true` adds one line pointing at `tool_schema('eval:helpers')` to the eval description. Settings-file warnings (an unknown key, a fallback to defaults) now reach the user as a notice, or on stderr without a UI.

### Removed

## [2026.10.10] - 2026-10-05

### Breaking Changes

### Added

- Isolated eval cells: with `sandbox.enabled`, `isolate: true` runs a JavaScript cell in a fresh QuickJS VM with no persistence and no ambient host (only `tools.*`, `print`, `display`), streaming output under a credit window. Off by default; the eval schema is unchanged until the setting is on.
- A JavaScript cell that is only `%bun add <package ...>` or `%npm add <package ...>` installs packages into a per-session managed environment without restarting the kernel; the next cell imports them by bare name, the project's `package.json` and `node_modules` are untouched, lifecycle scripts never run, and a failed or cancelled install leaves the previous packages active ([#2452](https://github.com/code-yeongyu/senpi/issues/2452)).

### Changed

### Fixed

- An isolated (`isolate: true`) cell whose QuickJS runtime is missing now fails with `eval_isolate_unavailable` before any of its code runs, instead of a module-resolution error that named a host path ([#2452](https://github.com/code-yeongyu/senpi/issues/2452)).

- `%bun add` over a package first installed from a local directory now works when the new archive's top directory is not `package/` (a GitHub-style `<repo>-<sha>.tgz`, or a plain `.tar`): its name is read from the archive's own top-level directory, so the old directory's links are removed before bun installs ([#2452](https://github.com/code-yeongyu/senpi/issues/2452)).

- A nested tool call that is denied inside an `eval` cell (a permission denial or another hook's block) now reaches the cell as the plain denial, without the `Expected parameters:` schema hint that made it read like an argument error; argument failures still get the hint ([#2700](https://github.com/code-yeongyu/senpi/issues/2700)). Thanks to @MoerAI ([#2755](https://github.com/code-yeongyu/senpi/pull/2755)).
- An `eval` run with an invalid `language` value (for example `"python"`, `""` or `null`) now gets its own error listing the enabled languages, instead of the "run requires language" message meant for an omitted one; `peek` and `stop` still need no language ([#1395](https://github.com/code-yeongyu/senpi/issues/1395)). Thanks to @MoerAI.

### Removed

## [2026.10.9] - 2026-10-04

### Breaking Changes

### Added

- Python `agent(prompt, tools=[...])` grants the child the cell's `@tool` functions by name, like JavaScript's `agent(prompt, { tools })`; anything other than a list of names is refused with `invalid_tools` ([#2731](https://github.com/code-yeongyu/senpi/issues/2731)).
- `workpool(agent, name, {mode, tools})` forwards `tools`, a list of kernel-tool names the cell defined, to the host workpool unchanged in all four languages, so pool workers can call them; anything other than a list of names is refused with `invalid_tools` before reaching the host. Which kernels' tools a host accepts is the host's call: JavaScript `tool(fn)` tools work on omo today, while Python `@tool` tools need omo#9529 ([#2452](https://github.com/code-yeongyu/senpi/issues/2452)).
- A Python or JavaScript cell that is only `%load <path>` runs that local file as the cell: its definitions persist, Python tracebacks name the file and its sibling modules import, and JavaScript resolves the file's relative imports from its directory; remote URLs are refused ([#2452](https://github.com/code-yeongyu/senpi/issues/2452)).
- A Python cell that is only `%pip install <requirements>` installs packages without restarting the kernel; the next cell imports them. Packages go into the session's own environment (or `<cwd>/.senpi/python-packages` after `%environment project`), never the interpreter's site-packages or the user site, and a failed or cancelled install leaves the previous packages active ([#2452](https://github.com/code-yeongyu/senpi/issues/2452)).

### Changed

### Fixed

- A Python cell can now grant its `@tool` functions to a child ([#2731](https://github.com/code-yeongyu/senpi/issues/2731)). Host calls from Python cells (`tool.task(..., tools=[...])`, `agent(..., tools=[...])`, `workpool(..., tools=[...])`) reached the host with no kernel-tools capability, so every such grant was refused as unavailable. Each call now carries its cell, and the host gives it that cell's capability while the cell runs; a call from another, unknown or finished cell gets none.
- `%pip` parsing follow-ups ([#2689](https://github.com/code-yeongyu/senpi/pull/2689)): a `%pip` or `%environment` line after code now says to put it on its own cell instead of "Unsupported line magic"; a comment line ending in a backslash no longer swallows the `%pip` line after it; inside double quotes a backslash is kept unless it escapes a quote, backslash, `$` or a backtick, as a POSIX shell does.

### Removed

## [2026.10.8] - 2026-10-04

### Breaking Changes

### Added

- Internal groundwork for installing Python packages from a cell: per-session environment revisions that are published only after a successful install (a failed or interrupted install leaves the previous revision active), a per-root install lock, and a pip installer that always targets the session's own directory. Not exposed to cells yet ([#2452](https://github.com/code-yeongyu/senpi/issues/2452)).
- Python kernel tools: `@tool` registers a function that in-process children can call, with its schema inferred from type hints; callbacks are served while the kernel is idle or its cell waits on a host call, never during a running computation, and a reset or redefinition makes old descriptors stale. `tool.defined()` / `tool.undefine()` in Python, and `tool_schema("eval:kernel-tools")` ([#2452](https://github.com/code-yeongyu/senpi/issues/2452)).
- Internal groundwork for isolated sandbox cells: a vendored copy of the pi codemode runtime (QuickJS in a worker) with two opt-in host options, output streaming bounded by a credit window and a store policy that keeps no state. Nothing uses it yet ([#2452](https://github.com/code-yeongyu/senpi/issues/2452)).

### Changed

### Fixed

- A cold Python kernel start on a busy machine no longer fails as a hang: startup keeps waiting while the interpreter is still using CPU or writing output, and fails only when it has gone completely still (naming the stage), or after 120 s without becoming ready ([#2718](https://github.com/code-yeongyu/senpi/issues/2718)).

### Removed

## [2026.10.7] - 2026-10-04

### Breaking Changes

### Added

- JavaScript kernel tools: `tool.defined()` lists the defined kernel tools and `tool.undefine(name)` removes one; `tool(fn, { name })` registers a tool under an explicit name while keeping the function's argument order ([#2452](https://github.com/code-yeongyu/senpi/issues/2452)).
- In-cell `wait(handles, {timeout, mode})` barrier and `handle(node | ref | {pool_id})` rich views in all four kernels: `wait` returns values in input order (`all`), the first success (`any`) or every outcome (`settled`), times out with `eval_wait_timeout` without cancelling work, and pauses the run budget while parked; `handle(node).control` offers `status()`, `output()`, `send()`, `cancel()` and `wait()` fenced by owner, id and `run_epoch` through the host's `EvalHandleHost` capability (agent and workpool handles fail with `eval_wait_unavailable` on a host without it); `completion(prompt, {handle: true})` returns an opt-in completion handle bounded by its cell's hard deadline; `tool_schema("eval:helpers")` and `tool_schema("eval:wait")` document the surface and the removed-tool hint for `wait` points at them. The legacy `agent(..., {handle: true})` record, the eval description and the eval input schema are unchanged; the Python runner's dispatcher was renamed `_handle_message` so `handle()` is the helper ([#2687](https://github.com/code-yeongyu/senpi/pull/2687)).

### Changed

### Fixed

- The Ruby kernel's memory notice names the largest globals again on Ruby 2.6 (the sizer used a Ruby 2.7 method) ([#2696](https://github.com/code-yeongyu/senpi/issues/2696)).
- Eval no longer fails with "codemode session manager is disposed" for the rest of a session after a session switch or fork that another extension cancelled: codemode only tears its kernels down when the session actually ends ([#1706](https://github.com/code-yeongyu/senpi/issues/1706)).
- A session whose codemode runtime failed to start is recovered by the next eval call (once, with one stderr line naming the failed start); if re-creation also fails, the call says "codemode runtime could not be re-created: <reason>" and how to bring eval back ([#1706](https://github.com/code-yeongyu/senpi/issues/1706)).

### Removed

## [2026.10.6] - 2026-10-04

### Breaking Changes

### Added

- An opt-in `memory.idleParkMinutes` setting (off by default) closes a kernel that had no cell running or queued for that many minutes to give its memory back; the next cell starts a fresh kernel and its result says every earlier global is lost ([#2452](https://github.com/code-yeongyu/senpi/issues/2452)).
- Ruby eval results name their largest globals, and Ruby and Julia kernels now get the same large-memory notice as JavaScript and Python when the interpreter footprint crosses `memory.noticeMb` ([#2452](https://github.com/code-yeongyu/senpi/issues/2452)).
- Julia eval results name their largest globals in that notice ([#2452](https://github.com/code-yeongyu/senpi/issues/2452)).

### Changed
- Kernel tool descriptors may name any eval language (`js`, `py`, `rb`, `jl`), not only `js`; today only JavaScript kernels define tools, so nothing a session sees changes ([#2452](https://github.com/code-yeongyu/senpi/issues/2452)).

### Fixed
- A Ruby or Julia kernel whose start hangs no longer leaves its cells waiting forever: startup fails, naming the stage it stalled in, once the runner has printed nothing, changed no stage and its process group has used no CPU for 30 s, so a slow but busy start (a cold Julia compiling its prelude) is never cut off ([#2452](https://github.com/code-yeongyu/senpi/issues/2452)).
- A `codemode.json` that names a key this version does not know no longer throws away every other setting: the unknown key gets one warning and the rest still apply (known nested objects stay strict). Optional keys for upcoming features (`environments`, `isolation`, `sandbox`, `prompt.advertiseHelpers`, `kernelTools`, `languages.pyInterpreter`) parse with today's behaviour as their defaults ([#2452](https://github.com/code-yeongyu/senpi/issues/2452)).

- A Python cell's host calls (`tool.*`, `completion`) no longer go through a configured HTTP proxy: the loopback bridge request ignores proxy settings from the environment and, on Windows, the registry, so a proxy can't refuse a `127.0.0.1` call that never needed it ([#2619](https://github.com/code-yeongyu/senpi/issues/2619)).
- A JavaScript memory report no longer runs user code: array elements are read through their own descriptors (an index accessor is skipped and the estimate marked approximate), and typed arrays, buffers, Blob, Map and Set are sized through the built-in getters, so a subclass that overrides `byteLength` or `size` is never called ([#2452](https://github.com/code-yeongyu/senpi/issues/2452)).

### Removed

## [2026.10.5] - 2026-10-03

### Breaking Changes

### Added

- Eval kernels expose the session's `OMO_BROWSER_ENGINE` and clear a value inherited from the host process for a session that chose no engine ([#2611](https://github.com/code-yeongyu/senpi/issues/2611)).
- A Python, Ruby, or Julia eval kernel whose interpreter dies is replaced once instead of failing every later cell: Ruby and Julia no longer stay closed after a crash, and a Python kernel whose stuck interpreter finally exits recovers instead of rejecting every cell. Cells queued behind the death keep their order and run on the replacement, whose first result says `[<language> kernel was restarted after <reason>; every global is lost]`; the cell that was running fails once and is never re-run, and a replacement that dies before finishing a cell fails the queued cells with `eval_kernel_unavailable` ([#2452](https://github.com/code-yeongyu/senpi/issues/2452))

### Changed

### Fixed

### Removed

## [2026.10.4] - 2026-10-03

### Breaking Changes

### Added

- Every live eval kernel in a process is listed in a process-wide registry with its session, language, measure, and last-known memory reading; a JavaScript kernel keeps the heap reading from each result and idle collection and answers an on-demand heap query between cells without running one, while Python, Ruby, and Julia kernels report their interpreter's footprint on demand. Thresholds, notices, and the result frame are unchanged ([#2561](https://github.com/code-yeongyu/senpi/issues/2561)).

- An eval regression gate records the full prompt and schema surfaces, helper witnesses across five required runtime legs, codemode-scoped eager imports, measured teardown resources (including global, named-import, promise and AbortSignal timers, named by creation site) and legacy contract results against a frozen baseline. CI provisions every interpreter and publishes the report; unrelated host imports and slow child startup cannot cause a regression failure. ([#2452](https://github.com/code-yeongyu/senpi/issues/2452))

- Added an interleaved eval timing benchmark that judges each runtime, workload and metric on adjacent base/head pairs against its own A/A-calibrated threshold (capped at 5%, or one shared band with `--band-scope global`), with process CPU accounting across interpreter crashes, a per-row minimum detectable effect, and explicit inconclusive results for incomplete, host-contaminated or noise-limited comparisons. ([#2452](https://github.com/code-yeongyu/senpi/issues/2452))
### Changed

### Fixed

### Removed

## [2026.10.3] - 2026-10-03

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.10.2] - 2026-10-02

### Breaking Changes

### Added

- An eval regression gate records the full prompt and schema surfaces, helper witnesses across five required runtime legs, codemode-scoped eager imports, measured teardown resources (including global, named-import, promise and AbortSignal timers, named by creation site) and legacy contract results against a frozen baseline. CI provisions every interpreter and publishes the report; unrelated host imports and slow child startup cannot cause a regression failure. ([#2452](https://github.com/code-yeongyu/senpi/issues/2452))

### Changed

### Fixed

- Fixed Mistral-hosted GLM 5.3 omitting required `eval` run fields when tool use is forced. ([#2444](https://github.com/code-yeongyu/senpi/pull/2444) by [@urbanbreach](https://github.com/urbanbreach))
- Anthropic-compatible gateways that reject an `enum` inside a root `anyOf` branch (HTTP 400, code 11133) accept the `eval` schema again. ([#2569](https://github.com/code-yeongyu/senpi/issues/2569), reported and verified by [@DevNewbie1826](https://github.com/DevNewbie1826))
- Reloading or replacing a session while a detached eval cell is running no longer kills the process from the footer's elapsed-time ticker. The ticker stops when its session's context is retired and starts again with the next session's cells; any other footer error still surfaces ([#2549](https://github.com/code-yeongyu/senpi/issues/2549) by [@rhyme227](https://github.com/rhyme227)).

- JavaScript eval cells run in the session's project directory: a relative path in `Bun.file`, `Bun.write`, `node:fs`, `path.resolve`, `Bun.$`, spawned children, or `Bun.Glob` now resolves inside the project instead of the host process directory, which made `Bun.file("src/todo.ts")` fail with ENOENT in desktop threads and under `--cwd`. A missing or deleted session directory fails the cell with `CodemodeSessionCwdUnavailableError` instead of falling back to another directory. The bash tool's working directory is unchanged ([omo#9371](https://github.com/code-yeongyu/oh-my-openagent/issues/9371)).

- Stop now explicitly reports when a running `Bun.$` wait forces the JavaScript kernel to restart and clears its variables, and recommends `Bun.spawn` or the bash tool for stoppable commands. Native shell semantics remain unchanged. Thanks to [@floweredao](https://github.com/floweredao) for the investigation ([#2475](https://github.com/code-yeongyu/senpi/pull/2475)); native cancellation remains tracked in [#2453](https://github.com/code-yeongyu/senpi/issues/2453).

### Removed

## [2026.10.1-3] - 2026-10-01

### Breaking Changes

### Added

### Changed

- The `eval` tool points at the bun-1-4 skill before a cell that installs a package, spawns a server or PTY, or starts a long run, instead of demanding it before the first JavaScript cell ([#2505](https://github.com/code-yeongyu/senpi/issues/2505)).

### Fixed

- Kernel-originated tool approvals now reach the RPC client that submitted the cell, including approvals requested after a cell detaches and its original turn ends. Reusing a kernel no longer sends permission dialogs to its creation context. ([#2512](https://github.com/code-yeongyu/senpi/issues/2512))

- Python eval startup waits for kernel readiness with advancing stage events instead of a five-second total deadline. Cold Windows imports can complete normally; a hung start identifies its stalled stage. ([#2452](https://github.com/code-yeongyu/senpi/issues/2452))

- Fixed the running eval spinner freezing between output updates. ([#2503](https://github.com/code-yeongyu/senpi/issues/2503))

### Removed

## [2026.10.1-2] - 2026-10-01

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.10.1] - 2026-10-01

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.30] - 2026-09-30

### Breaking Changes

### Added

### Changed

### Fixed

- An `eval` cell's return value reaches the model whole up to the normal tool-output budget: a long single-line value is no longer cut after 768 bytes with a bare `…`. Any output that is still cut (a printed line past the column cap, or output past the byte or line budget) now tells the model so, with the kept and original sizes and a `[Full output: <path>]` pointer to the saved full output. Reported by @haamsuk-collab. ([#2402](https://github.com/code-yeongyu/senpi/issues/2402))

### Removed

## [2026.9.29-5] - 2026-09-29

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.29-4] - 2026-09-29

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.29-3] - 2026-09-29

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.29-2] - 2026-09-29

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.29] - 2026-09-29

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.28-7] - 2026-09-28

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.28-6] - 2026-09-28

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.28-5] - 2026-09-28

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.28-4] - 2026-09-28

### Breaking Changes

### Added

- JavaScript eval kernels report their memory: a result whose kernel holds at least `memory.noticeMb` (default 1 GiB) live after a collection carries one bracketed notice naming the largest globals and how to drop them, plus `details.memory` (`liveBytes`, `gcRan`, `globals`). A kernel whose live memory reaches `memory.ceilingMb` (default a quarter of physical memory, 2-8 GiB) says so in that result and restarts once no cell is running or queued on it; the next result reports `details.memory.recycled`. Settings `memory.gcWatermarkMb`, `memory.noticeMb`, `memory.ceilingMb` and their `SENPI_CODEMODE_MEMORY_*_MB` overrides; `0` disables each. ([#2261](https://github.com/code-yeongyu/senpi/issues/2261))
- Python eval kernels follow the same memory contract: after each cell the kernel reads its process footprint (macOS `phys_footprint`, Linux `RssAnon`, Windows `PrivateUsage`), runs `gc.collect()` plus glibc `malloc_trim(0)` when it grew past `memory.gcWatermarkMb`, and a result at `memory.noticeMb` names the largest globals (numpy `nbytes`, pandas `memory_usage(deep=True)`, sampled containers) with `del <name>` advice; at `memory.ceilingMb` the Python kernel restarts once its queue is empty and the next result reports `details.memory.recycled`. Ruby and Julia kernels get the ceiling restart from the interpreter footprint the host reads after each result (no globals list). ([#2261](https://github.com/code-yeongyu/senpi/issues/2261))

### Changed

### Fixed

- Retiring a JavaScript eval worker (timeout, interrupt, reset, crash, or memory-ceiling restart) no longer leaves each child process the cell was still running as a zombie of the host: the host now collects them after killing them. Measured: 30 retirements that each left two children went from 60 zombies to 0. ([#1962](https://github.com/code-yeongyu/senpi/issues/1962))
- A persistent eval kernel no longer pins its first cell's handler for the whole kernel generation. The kernel dispatcher is now a bound method of the session manager instead of a closure over the `getKernel` call that created the kernel (under Bun/JSC that closure retained the creating cell's `onMessage` — its output buffers and display images — until the kernel was reset), and every cell releases its kernel listener once it settles, so nothing keeps a settled cell's state alive. Interpreter startup stderr still reaches the cell that created the kernel; a message arriving between cells reaches no settled handler. ([#2260](https://github.com/code-yeongyu/senpi/issues/2260))
- Memory a JavaScript eval cell no longer references returns to the machine without a reset: a finished cell whose heap grew past `memory.gcWatermarkMb` (default 256 MiB) runs a full collection, and on Node and on Bun before 1.4.3 a kernel still holding that much runs an idle collection about a second after its last cell, so `delete globalThis.rows` no longer leaves gigabytes resident until the kernel is reset (Bun 1.4.3 collects idle threads itself). ([#2261](https://github.com/code-yeongyu/senpi/issues/2261))

- Settled eval cells kept for `peek`/`list` no longer pin up to ~800 MB of image data in the session's memory. Their images are written to `<session artifacts>/settled-images/` and read back on `peek`, which still returns the full result. The files are bounded by the new `memory.retainedImagesMb` setting (default 256, env `SENPI_CODEMODE_RETAINED_IMAGES_MB`), deleted with an evicted cell, and removed when the session ends. The in-memory snapshots are bounded by the new `memory.retainedResultsMb` setting (default 32, env `SENPI_CODEMODE_RETAINED_RESULTS_MB`) on top of the 32-cell count cap. ([#2259](https://github.com/code-yeongyu/senpi/issues/2259))

- The JavaScript eval kernel no longer compiles a fresh code-cache entry for its loader prelude on every cell: the prelude is evaluated under one stable source URL (`senpi:kernel-prelude`) instead of a per-cell `` `${cellId}:prelude` `` URL, so identical prelude text reuses the engine's eval code cache: per-cell kernel heap growth over a 1,000-cell series drops from ~2.3 KB to ~1.1 KB (the remainder is the cell body's own per-cell source URL, kept for stack attribution and bounded by the engine's code-cache cap). Stack frames from prelude code now attribute to `senpi:kernel-prelude` for every cell. ([#2263](https://github.com/code-yeongyu/senpi/issues/2263))

### Removed

## [2026.9.28-3] - 2026-09-28

### Breaking Changes

### Added

### Changed

### Fixed

- Live output updates for eval cells no longer rebuild the retained output tail on every chunk. The streaming preview keeps the last eight lines of the trailing byte window, appends in time proportional to the chunk, and output-driven updates are coalesced to one per 100 ms (the core bash tool's cadence), so a cell printing 30,000 lines sends about 10 updates instead of 30,008 and finishes about 4x faster with a lower memory peak. The final result and the text of each update are unchanged. ([#2262](https://github.com/code-yeongyu/senpi/issues/2262))

- `new Bun.WebView()` in a JavaScript eval cell no longer fails with `Bun.WebView with backend "chrome" is only available on the main thread` (every call on Windows and Linux, `backend: "chrome"` on macOS). Cells see a `Bun` whose `WebView` (also through `import { WebView } from "bun"`) hands Chrome-backed views to the process main thread with the same API: navigation, input, `evaluate`, screenshots, `cdp()` and its events, `console` capture, `url`/`title`/`loading`, `close()` and `await using`. The macOS default (WebKit) stays a native view in the kernel worker. `Bun.WebView.closeAll()` in a cell closes only that kernel's views. ([#2248](https://github.com/code-yeongyu/senpi/issues/2248))

### Removed

## [2026.9.28-2] - 2026-09-28

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.28] - 2026-09-28

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.27-4] - 2026-09-27

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.27-3] - 2026-09-27

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.27-2] - 2026-09-27

### Breaking Changes

### Added

- The eval kernels install each active tool's `kernelPrelude`: its JavaScript or Python statements run before a cell whenever one of the prelude's exports is missing, a deactivated tool's exports are removed before the next cell, and each prelude's documentation line joins the eval prompt's helper list. Exports that would shadow a built-in helper are rejected. ([#2178](https://github.com/code-yeongyu/senpi/pull/2178))

### Changed

### Fixed

### Removed

## [2026.9.27] - 2026-09-27

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.26] - 2026-09-26

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.25] - 2026-09-25

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.24-3] - 2026-09-24

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.24-2] - 2026-09-24

### Breaking Changes

### Added

### Changed

- Dense JavaScript eval cells are previewed with Bun's built-in printer when the TUI runs on Bun: one statement per line with normal spacing, while every string, number, template, name, and comment keeps its exact text. On Node, JavaScript cells are shown as sent. Dense Python cells are formatted by your own Python (ruff or black when installed, otherwise the standard library for comment-free cells), appearing formatted a moment after the cell is shown. Anything that cannot be shown faithfully is shown as sent, and the code that runs is unchanged. ([#2076](https://github.com/code-yeongyu/senpi/issues/2076))

### Fixed

- The `eval` tool's run contract is no longer a trap: the schema descriptions now mark `language` and `code` as required for run, and a run call missing either fails with an error that names the enabled languages or the missing cell body instead of a bare "eval run requires language".
- An omitted `eval` `language` now names only the kernels enabled in this session (`js` and `py` by default), instead of advertising gated Ruby and Julia.

### Removed

## [2026.9.24] - 2026-09-24

### Breaking Changes

### Added

### Changed

### Fixed

- Eval code previews no longer show code that means something different from the cell: breaking a long JavaScript array keeps the parentheses around each element, and a Python formatter result that changes string or docstring text (or is not valid Python) is discarded so the cell is shown as sent. ([#2076](https://github.com/code-yeongyu/senpi/issues/2076))
- Python eval previews give your ruff most of the 5-second formatting budget instead of a fixed 4 seconds, so a slow first ruff start still formats the cell. ([#2076](https://github.com/code-yeongyu/senpi/issues/2076))

### Removed

## [2026.9.23-5] - 2026-09-23

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.23-4] - 2026-09-23

### Breaking Changes

### Added

### Changed

- Eval cards no longer display truncation or full-output artifact footer warnings. Model-facing eval text and grouping are unchanged; content explicitly addressed only to the model is omitted from the text fallback. ([#2041](https://github.com/code-yeongyu/senpi/issues/2041))

### Fixed

### Removed

## [2026.9.23-3] - 2026-09-23

### Breaking Changes

### Added

### Changed

- Dense one-line JavaScript eval cells are previewed in the TUI broken at statement, block, and long-array boundaries with indentation, keeping the original tokens and comments. Unparseable, non-JavaScript, and already readable cells are shown as sent, and the code that runs is unchanged. ([#2050](https://github.com/code-yeongyu/senpi/issues/2050))
- The `eval` `summary` guide asks for a progress update saying what the agent is doing and why, in the language the user writes in, and summaries no longer have a length limit (the 80-character truncation is gone). A collapsed eval block shows the first three summary lines; expanding it shows the rest. ([#2050](https://github.com/code-yeongyu/senpi/issues/2050))
- Codemode CI tests use at most two fork workers, matching the coding-agent suite's interpreter-heavy test scheduling. Test deadlines, assertions, and local worker defaults are unchanged. ([#2039](https://github.com/code-yeongyu/senpi/issues/2039))

### Fixed

### Removed

## [2026.9.23-2] - 2026-09-23

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.23] - 2026-09-23

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.22-4] - 2026-09-22

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.22-3] - 2026-09-22

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.22-2] - 2026-09-22

### Breaking Changes

### Added

### Changed

### Fixed

- `wake_source_state` (live detached eval cells) is now published on the rpc channel as well as the in-process event bus, so out-of-process consumers see live cells the way the TUI footer does (#1943).

### Removed

## [2026.9.22] - 2026-09-21

### Breaking Changes

### Added

- `eval` runs up to `maxDetachedCells` background cells per session (default 15, `SENPI_CODEMODE_MAX_DETACHED_CELLS`) and queues same-language cells on their kernel instead of rejecting them; `list` observes live and recent cells, and resetting a busy language refuses with `eval_kernel_busy_reset_refused` instead of stopping live work. ([#1908](https://github.com/code-yeongyu/senpi/issues/1908))
- `agent()` forwards `isolated`, `apply`, and `merge` when the task host advertises isolation. Hosts that do not still drop those options with the existing warning. A foreground call whose isolation did not apply now raises instead of looking successful; with `handle: true` the isolation result arrives on completion. ([#1910](https://github.com/code-yeongyu/senpi/issues/1910))

### Changed

### Fixed

### Removed

## [2026.9.21-2] - 2026-09-21

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.21] - 2026-09-21

### Breaking Changes

### Added

### Changed

- Updated the bundled dependencies: typebox 1.3.27 -> 1.3.34. ([#1895](https://github.com/code-yeongyu/senpi/issues/1895))

### Fixed

- Python eval kernel: a kernel whose host process died mid-cell now exits instead of being orphaned forever. ([#1659](https://github.com/code-yeongyu/senpi/issues/1659))

### Removed

## [2026.9.20] - 2026-09-20

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.19-2] - 2026-09-19

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.19] - 2026-09-19

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.18-6] - 2026-09-18

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.18-5] - 2026-09-18

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.18-4] - 2026-09-18

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.18-3] - 2026-09-18

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.18-2] - 2026-09-18

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.18] - 2026-09-18

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.17-4] - 2026-09-17

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.17-3] - 2026-09-17

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.17-2] - 2026-09-17

### Breaking Changes

### Added

### Changed

### Fixed

- JS eval kernel: a cell whose top-level declaration (`const`/`let`/`var`, plain or destructured) names an existing platform or prelude global (for example `const fetch = ...`) is now rejected before execution with an error naming the identifier and the rename remedy, instead of silently replacing that global for every later cell and wedging the session until a kernel reset. Cell-created globals stay re-declarable across cells, and explicit `globalThis.<name> = ...` assignments remain untouched as the deliberate escape hatch. (#1784)

### Removed

## [2026.9.17] - 2026-09-17

### Breaking Changes

### Added

- `kernelTools.invoke(request, options?)` accepts a per-call execution scope for the nested host calls the invoked closure makes: `{ scope: { tools: { allow?: string[], deny?: string[] } } }`. While that invocation is active, a `tool.<name>()` outside the scope is refused inside the worker with `kernel_tool_host_denied` carrying `{ tool, call_id, reason: "allow" | "deny" }`: the closure sees a rejected promise, the refusal never reaches the host bridge, and the parent's own cells and queue keep the parent's full tool surface. `deny` wins over `allow`, an `allow` list refuses every host tool it does not name, a malformed list fails closed, and the scope lives only for that call — it is dropped when the call settles (including interrupt and reset) and is never persisted. The second argument still accepts a bare `AbortSignal`, and a call without a scope posts exactly the message it always did. Consumers detect the feature through `kernelTools.capabilities.invokeScope === true`; `KERNEL_TOOLS_CAPABILITIES`, `KernelToolsCapabilities`, `KernelToolsInvokeOptions`, `KernelToolsInvokeScope`, `KernelToolsHostScope`, `KernelToolHostDenial` and `KernelToolHostDenialReason` are exported ([#1731](https://github.com/code-yeongyu/senpi/issues/1731)).

### Changed

- Kernel-tools types bind to coding-agent's `ExtensionKernelTools` / `KernelToolInvokeOptions` / `KernelToolInvokeScope` (`KERNEL_TOOLS_CAPABILITIES satisfies ExtensionKernelTools["capabilities"]`) so the implementation cannot drift from the host declaration ([#1731](https://github.com/code-yeongyu/senpi/issues/1731)).

### Fixed

### Removed

## [2026.9.16-3] - 2026-09-16

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.16-2] - 2026-09-16

### Breaking Changes

### Added

### Changed

### Fixed

- The JavaScript kernel-tool capability now reaches host tools called from inside a running eval cell. A cell that registers `tool(fn)` can hand those functions to its in-process children through `task`/`agent`/`workpool`, because `ExtensionContext.kernelTools` resolves for the duration of each host tool call the cell makes. It was undefined at the dispatch point — the worker's message loop ran outside the `kernelToolsStorage` scope that only covered the awaited run chain — so every grant was refused with `tools_unavailable` and the capability shipped in the previous release could not be used ([#1754](https://github.com/code-yeongyu/senpi/issues/1754)).

### Removed

## [2026.9.16] - 2026-09-16

### Breaking Changes

- Background `agent(..., handle=true)` now requires the host task tool to return structured `details.task_id` (`st_` plus lowercase hex) and an integer `details.run_epoch >= 0`. The result gains a `run_epoch` field next to `id` and `handle`, in every kernel language. A host that returns an error, or only a prose task id in its text, raises `invalid_task_handle`; the old regex scrape of the text is gone. Extra producer fields in `details` are accepted. Foreground text and JSON results are unchanged ([#1646](https://github.com/code-yeongyu/senpi/issues/1646)).

### Added

- Added `workpool(agent, name, mode?)` to the JS, Python, Ruby and Julia preludes as a thin adapter over the host `workpool` tool. `agent` is a plain-data spec with one of `category` or `subagent_type` plus `prompt` and optional `model`; `mode` is `fresh` or `keep_alive` and is forwarded only when given. The adapter exposes `pool_id`, `push(items)`, `close()`, `inspect()` and `cancel()`, each returning the same `{text, details, images?, hasError?}` envelope as a direct tool call, and holds no worker, queue or admission state, so a kernel reset drops only the variable and the pool survives. A missing or inactive host tool raises `workpool_unavailable`; a host error at creation is raised instead of returning a broken adapter. Kernel tools may not call `workpool()` (`kernel_tool_recursion`) ([#1646](https://github.com/code-yeongyu/senpi/issues/1646)).
- Added JavaScript kernel tools. `tool(fn, metadata?)` registers a named `function` or `async function` declaration as a fenced tool for in-process children while `tool.<name>(args)` host calls keep working. The parser reads only the declaration head: anonymous functions, classes, generators, native functions and non-identifier parameters are rejected with `invalid_tool_definition`; unicode identifiers are kept as written. Names must already fit the MCP grammar (`[A-Za-z0-9_-]`, at most 64 characters) and are checked against reserved bridge names, live host tools (including tools attached after the worker started) and tools registered by the session's Python, Ruby or Julia kernels, raising `reserved_tool_name` or `tool_name_collision`. Each descriptor carries `name`, a JSON input schema, `kernel_generation` and `definition_revision`; a stale generation or revision is refused with `kernel_tool_stale`, redefining a function bumps its revision, and a kernel reset clears every registered tool and bumps the generation. `agent()` accepts `tools: string[]` to hand a child those tool names. Kernel-tool requests against Python, Ruby or Julia kernels fail with `tools_unavailable` ([#1647](https://github.com/code-yeongyu/senpi/issues/1647)).
- The JS worker answers kernel-tool `describe` and `invoke` requests on a separate pump from the top-level run queue, so a parent cell can stay pending on `agent()` while an in-process child calls one of the parent's registered functions. Interrupting the parent settles every nested invoke, and a worker reset, crash or close rejects the pending ones with `kernel_tool_stale` ([#1647](https://github.com/code-yeongyu/senpi/issues/1647)).
- `CodemodeExtensionAPI.kernelTools` exposes the parent cell's kernel-tool `describe`/`invoke` capability to extensions while a JavaScript eval is live; `KernelToolDescriptor`, `KernelToolsCapability`, `KernelToolsDescribeResult`, `KernelToolsInvokeRequest` and `KERNEL_TOOLS_UNSUPPORTED` are exported. Kernels may implement `EvalKernel.listKernelToolNames()` so the session manager can detect cross-language name collisions ([#1647](https://github.com/code-yeongyu/senpi/issues/1647)).

### Changed

- The eval prompt documents `workpool()` and the `run_epoch` field on background `agent()` handles, and the JS prelude describes `tool(fn, metadata?)` and `workpool()` ([#1646](https://github.com/code-yeongyu/senpi/issues/1646), [#1647](https://github.com/code-yeongyu/senpi/issues/1647)).

### Fixed

### Removed

## [2026.9.15-2] - 2026-09-15

### Breaking Changes

### Added

### Changed

### Fixed

- Detached eval result cards no longer arm the 1 Hz repaint ticker (they render static with frozen elapsed time), and a live ticker whose row stops rendering now stops itself after 60 idle ticks and rearms on the next render, so transcript rebuilds and session switches cannot accumulate intervals on idle sessions ([#1696](https://github.com/code-yeongyu/senpi/issues/1696)).
- Bounded three unbounded retentions that grew long-lived session heaps without limit: settled eval cells now leave the live registry into a 32-entry terminal snapshot LRU, the JS kernel's unconsumed tool-call queue is capped at 256 and cleared on interrupt/reset/close/crash (mirroring the subprocess kernel), and per-cell display buffers cap at 8 images / 24 MB / 64 JSON outputs with elision notes ([#1695](https://github.com/code-yeongyu/senpi/issues/1695)).

### Removed

## [2026.9.15] - 2026-09-15

### Breaking Changes

### Added

### Changed

### Fixed

- Eval cells no longer abandon the processes they spawn. When a JavaScript cell settles, is interrupted, or times out, its `Bun.spawn`/`node:child_process` children and their descendants are terminated (SIGTERM then SIGKILL after a grace), unless the cell asked for a detached process; a child whose worker is lost while blocked is retired by the host instead. Python kernels sweep their process group when they close gracefully, and a parent-death watchdog takes the kernel and its subprocesses down when the host dies mid-cell ([#1697](https://github.com/code-yeongyu/senpi/issues/1697)).

### Removed

## [2026.9.13-2] - 2026-09-13

### Breaking Changes

### Added

- Added `PI_SESSION_CWD` and `PI_GOAL_STORE_FILE` session environment keys for kernels and shell children, including clearing of inherited values when absent (fixes #1663).

- Interactive foreground eval cells detach on queued steering without cancelling their computation or in-flight tools. An occupied detached slot keeps the call waiting ([#1637](https://github.com/code-yeongyu/senpi/issues/1637)).

### Changed

### Fixed

### Removed

## [2026.9.13] - 2026-09-13

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.12-3] - 2026-09-12

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.12-2] - 2026-09-12

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.12] - 2026-09-12

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.11] - 2026-09-11

### Breaking Changes

### Added

### Changed

- The eval tool instructions now tell callers to emit large text in bounded chunks or through offset-based file reads, and to treat a truncation notice as incomplete data that must be recovered from the full-output path instead of being read as the whole result ([#1600](https://github.com/code-yeongyu/senpi/pull/1600)).

### Fixed

- Column-capped eval output now preserves a recoverable full-output artifact, so a cell whose output is clipped by a narrow terminal column cap still exposes the complete text through the artifact path ([#1600](https://github.com/code-yeongyu/senpi/pull/1600)).

### Removed

## [2026.9.10-2] - 2026-09-10

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.10] - 2026-09-10

### Breaking Changes

- The eval `timeout` argument is now the cell's run budget (a kill deadline for the cell's own execution time) instead of the interactive detach budget; interactive calls detach at `cellTimeoutSeconds` capped by `foregroundWindowSeconds` regardless of `timeout`, and print/json calls are bounded by the run budget instead of a `cellTimeoutSeconds` idle kill.

### Added

- Every eval cell carries a run budget (`runBudgetSeconds`, default 300s, env `SENPI_CODEMODE_RUN_BUDGET_SECONDS`, per-call `timeout`) that charges only its own execution time, is paused while a host tool call is in flight, keeps counting after detach, and kills the cell through the cooperative interrupt path with a result or notification that names the exhausted budget and the kernel-state outcome.

### Changed

- The eval tool schema and description state the configured run budget, detach point, and hard limit, and say that a killed JavaScript cell that cannot settle restarts its kernel and loses every global.

### Fixed

### Removed

## [2026.9.9-2] - 2026-09-09

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.9] - 2026-09-09

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.8] - 2026-09-08

### Breaking Changes

### Added

### Changed

- The eval tool description teaches cell mechanics only (batch independent calls, real code, failures kept verbatim, truncated output re-read) and drops the "default execution surface / never a chain / distilled facts only" wording; routing lives in the model's prompt preset.

### Fixed

### Removed

## [2026.9.7-2] - 2026-09-07

### Breaking Changes

### Added

### Changed

### Fixed

- The JS kernel's shell capture now pins the worker's environment view for `Bun.spawnSync` as well as `Bun.spawn`, so a cell calling it without an explicit `env` sees the session's `PI_*` values instead of the inherited OS environ.
- Eval kernels and every child they spawn now see the active session's `PI_*` environment (`PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`) exactly as bash-tool children do: inherited `PI_*` values are dropped before the session values are applied, so subprocesses such as `omo-agent-toolkit ulw-loop` resolve the same session as the `bash` tool instead of a cwd-global one.
- JavaScript eval cells no longer lose their completion value when a nested function, callback, or try/catch helper contains `return`: the cell wrapper now skips last-expression capture only for a genuine top-level `return`, and a property named `return` no longer primes the statement scanner as the keyword (#1439).
- Eval output truncation notices now name the real cause: a width-clamped line reports `N line(s) clamped to M columns (… dropped)`, a byte-capped tail reports the actual cap, and a notice never presents the output's own size as a limit.

### Removed

## [2026.9.7] - 2026-09-07

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.6] - 2026-09-06

### Breaking Changes

### Added

### Changed

- The Bun eval description now tells the model to shell out through `Bun.$` or `Bun.spawn` and never `Bun.spawnSync`, because a synchronous child blocks the worker and a stop or timeout then loses every variable.
- JavaScript eval cells now interrupt cooperatively: `stop` and kernel timeouts first ask the worker to settle the cell (pending bridge `tool.*` calls are rejected, `Bun.spawn` children are killed) and keep the worker VM and its globals when the cell settles within a 2 s grace; only an unsettled cell restarts the worker.

### Fixed

- `eval({ action: "stop" })` no longer hangs when the JavaScript worker is blocked in a synchronous call such as `Bun.spawnSync`: worker termination is bounded by a 3 s deadline, a fresh worker replaces the blocked one, and the cell output names the blocked synchronous call.
- `Bun.$` commands run from a JavaScript cell no longer inherit the TUI's terminal as stdin (a stdin reader such as `cat`, an ssh or git credential prompt, or a keychain prompt blocked the cell forever); the shell wrapper isolates stdin while a cell is active without changing output, exit codes, `cwd`, `env`, or explicit stdin redirects.
- Stop results and detached-cell completion notifications report the real interrupt outcome (variables preserved, worker restarted, or outcome unknown) instead of a hardcoded per-language note.

### Removed

## [2026.9.5-3] - 2026-09-05

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.5-2] - 2026-09-05

### Breaking Changes

### Added

### Changed

- The GPT eval dialect now routes a wait or a long run through `tool.monitor` inside the cell (the subscription line precedes the detach note, and the `## Tool Guidelines` line says so when `monitor` is reachable), so a GPT model no longer reads "long cells detach" as the way to wait on a `--watch`.

### Fixed

### Removed

## [2026.9.5] - 2026-09-05

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.4-3] - 2026-09-04

### Breaking Changes

### Added

### Changed

- The package `test` script runs `vitest run test/` instead of `npx tsx …/vitest/dist/cli.js`, matching every other workspace package. The old form spawned npm and tsx to reach the vitest CLI that is already a direct dependency.
### Fixed

### Removed

## [2026.9.4-2] - 2026-09-04

### Breaking Changes

### Added

- `foregroundWindowSeconds` codemode setting (default `60`, env `SENPI_CODEMODE_FOREGROUND_SECONDS`): the longest an interactive `eval` call blocks the turn before the cell detaches. A larger `timeout` now frees the turn at this window while the cell keeps running to the hard limit, instead of blocking the agent loop for the whole `timeout`.

### Changed

- The Bun kernel line of the `eval` description now names `new Bun.WebView()` as the headless browser and states when to reach for it (a page that needs JS, a login, or a screenshot) instead of `curl` or a browser CLI. The line previously advertised `Bun.*` builtins generically, so sessions on a Bun kernel resolved page work to `curl`/`fetch` and never discovered the in-process browser. Node kernels are unchanged.
- The `eval` tool description is dieted a second time: the `Fields:` list now defers to the parameter schema (its single home), the detach guidance is one paragraph, and helper lines keep every signature with fewer words. gpt/codex dialect 1,489 -> 1,087 o200k tokens (description + guidelines); claude 1,173, kimi 1,190, default 1,189. Also fixes the fused `jl` handle form in the all-languages render.

- The `eval` tool description is dieted from ~2002 to ~1588 tokens (codex dialect): the three reuse-chain JSON examples, the `<workflow>` graph prose, the repeated state-persistence rules, and the per-dialect wait-doctrine clause are removed or folded; every helper signature and dialect routing is kept. The workflow block's fused `handle=True{ handle: true }` is fixed into per-language correct forms.

### Fixed

### Removed

## [2026.9.4] - 2026-09-04

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.3-3] - 2026-09-03

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.3-2] - 2026-09-03

### Breaking Changes

### Added

### Changed

### Fixed

- JavaScript eval cells no longer leak child-process output onto the host terminal under Bun: `Bun.$` commands awaited without `.quiet()`/`.text()` and `Bun.spawn` children with the default stderr now route their output into the cell's stdout/stderr streams instead of the inherited fd 1/2 that the interactive TUI owns.

### Removed

## [2026.9.3] - 2026-09-03

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.2-4] - 2026-09-02

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.2-3] - 2026-09-02

### Breaking Changes

### Added

### Changed

- The eval prompt's JS runtime line is now runtime-aware: on a bun kernel it names `Bun <version>` and
  `Bun.*` builtins, and only while the bundled `bun-1-4` skill is active it adds a MUST READ pointer to
  that skill's absolute path before the first js cell; node kernels keep the Node.js worker wording.
  `activeBunSkillPath()` exposes the same gate the `resources_discover` contribution uses.
- The bundled `bun-1-4` skill description is rewritten as a fact-framed MUST READ notice with
  English-only copy (Korean trigger words removed; the `Bun.stringWidth` example no longer uses Hangul).

### Fixed

- Compiled binaries now contribute the bundled `bun-1-4` skill by resolving the codemode sidecar shipped next to the executable, and a missing skill is reported on stderr so it can no longer corrupt the RPC protocol stream on stdout.

### Removed

## [2026.9.2-2] - 2026-09-02

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.9.2] - 2026-09-02

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.31] - 2026-08-31

### Breaking Changes

### Added

- The codemode extension now bundles the `bun-1-4` skill and contributes it via `resources_discover` only
  when the js eval kernel itself runs bun >= 1.4 (`process.versions.bun`); node-kernel sessions never
  receive the skill, regardless of any bun binary on PATH.

### Changed

### Fixed

### Removed

## [2026.8.30-3] - 2026-08-30

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.30-2] - 2026-08-30

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.30] - 2026-08-30

### Breaking Changes

### Added

### Changed

- The eval prompt's dependency-graph section is now `<workflow>` and states its contract directly:
  define the workflow spec in code, one node per logically distinct step, rather than hand-authoring
  the graph as a single opaque call.

### Fixed

- The JavaScript kernel persistence transform no longer truncates declarations whose multi-line
  initializers contain interior `//` comments (previously emitted unparseable code such as
  `globalThis["jobs"] = {;`, failing cells with `Unexpected token ';'. Expected a property name.`),
  and no longer re-evaluates comment-bearing initializers when persisting bindings — such
  declarations are kept verbatim and their bindings persisted by reference.
- Last-expression capture no longer inserts `return` before continuation lines (`else`/`catch`/`finally`
  clauses and leading-`.`/operator method-chain lines), and now scans template literals (including
  nested templates in interpolations), regexes, and comments with the same literal-aware scanner as
  the persistence transform — fixing `return else …`, `return .replace(…)`, and mid-argument
  `return )` corruption of valid cells.
- Last-expression capture now follows real ASI statement semantics: a parenthesized/bracketed/template
  line after a closed block starts a new statement (echo restored), expressions split after a trailing
  operator or `await` stay one statement, tagged templates split across lines invoke the tag, regexes
  directly after a control-structure condition no longer desync the scanner, and labeled final
  statements are left uncaptured instead of emitting invalid `return label: …`.
- Destructuring patterns carrying interior line comments now persist their bindings, and declarations
  with a dangling trailing comma are left untransformed so the original syntax error surfaces instead
  of being silently "repaired".
- Rewritten destructuring assignments are emitted with a leading defensive semicolon so they can no
  longer ASI-merge into a preceding unterminated expression statement as a bogus call
  (`foo()\n({…} = …)` previously became `foo()({…} = …)`).

### Removed

## [2026.8.29] - 2026-08-29

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.28-2] - 2026-08-28

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.28] - 2026-08-28

### Breaking Changes

### Added

### Changed

### Fixed

- JavaScript and Python eval kernels resolve worker and prelude assets from the executable sidecar in Bun-compiled distributions instead of passing unusable `$bunfs` paths to `Worker` and `python3`.

### Removed

## [2026.8.27] - 2026-08-27

### Breaking Changes

### Added

### Changed

- Eval tool description examples are now a JS-first mixed set: set up once in JavaScript, fan out batched `Promise.all` session-tool calls in the next cell, then hop to Python when the JS kernel is busy with a detached cell. The detach paragraph now states in the same sentence that another language can continue.

### Fixed

- An explicit `timeout` no longer silently disables detach for interactive `eval` cells. Previously `timeout` was both the detach budget and the hard-limit extension with no cap, so a call like `timeout: 7000` (intended to keep a long detached cell alive) blocked the agent loop for ~2h before the hard limit killed it. The detach point is now capped at the foreground window; `on_timeout: "error"` (and print/json) keep `timeout` as the unclamped deadline, and the hard-limit extension (`max(hardLimitSeconds, timeout)`) is unchanged.
- Detached-eval same-language busy errors now name each idle enabled kernel and tell the agent to continue the step there (`continue this step in an idle kernel: js`), instead of only pointing at peek and the output tail. A busy Python kernel no longer reads as "eval is unavailable", which previously sent agents to `bash`+`python3` while JavaScript (or another idle kernel) was free. Single-language sessions and fully-busy sessions omit the idle-kernel claim.
- JavaScript eval cells now persist only top-level declarations, including destructuring bindings and uninitialized variables, without rewriting declaration-shaped text inside literals or comments.
- Eval completion and detached-cell handling retain explicit lifecycle observability: nested tool counts, wall/kernel timing, detach state, `peek`, `stop`, hard limits, and crash recovery remain bounded and machine-readable for hosts and telemetry consumers.

### Removed

## [2026.8.26-2] - 2026-08-26

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.26] - 2026-08-26

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.25] - 2026-08-25

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.24] - 2026-08-24

### Breaking Changes

### Added

### Changed

### Fixed

- Detached eval cell overflow notices now point at the absolute spill file path (`…/local/detached-eval-<id>.log`) instead of a `local://detached-eval-<id>.log` URI. `local://` is resolved only by the in-cell kernel helpers, not by the agent `read` tool, so following the old notice failed with `ENOENT …/local:/detached-eval-<id>.log`. This restores the documented contract that spill notices carry plain absolute paths.

### Removed

## [2026.8.23] - 2026-08-23

### Breaking Changes

### Added

### Changed

### Fixed

- Detached eval cell completion notices no longer enter the user-input steering queue. They were delivered via `sendUserMessage`, so hosts projecting that queue (e.g. the OmO desktop composer) rendered the raw `<system-reminder>Detached eval cell …</system-reminder>` notice under the STEERING heading as if the user had typed and queued it. Notices now deliver via `sendMessage` with `customType: "senpi-codemode:notification"` and `display: false` — model-visible, never painted as user input — matching the terminal and monitor notification contract.

### Removed

## [2026.8.22-2] - 2026-08-22

### Breaking Changes

### Added

- Eval headers now display the kernel runtime identity, e.g. `eval py (3.14.7, ~/.venv/bin/python3)` and `eval js (node 26.7.0, /opt/…/bin/node)`; the same `runtime` info rides `EvalToolDetails` and its `cells` so RPC consumers receive it, interpreter detection resolves absolute executable paths from PATH, and the eval prompt host line names the JS runtime (`node`/`bun` with version).

### Changed

- Running eval cell headers now tick their elapsed time in real time (`eval py running · 13s`) instead of freezing between kernel update events; the renderer derives elapsed time from a render-time clock while a cell is pending/running/detached and repaints once per second, while settled cells keep their exact final duration. `EvalCellResult` gains an additive `startedAt` so RPC consumers can compute the same live value.

### Fixed

- A host tool call from inside an eval cell no longer suspends the cell's timeout indefinitely. The idle watchdog previously cleared its timer for the entire duration of a bridge call, so a call that never returned (e.g. an awaited `dag-wait`) left the cell pending — and the agent loop parked, queueing user messages invisibly — until the 1800s hard limit. The pause is now bounded by a max pause grace (default 600s, floored at the cell's own `timeout`): a long bridge call such as a 5-minute build still runs to completion, but a stuck one now trips the cell's `on_timeout` handling and releases the loop.

### Removed

## [2026.8.22] - 2026-08-22

### Breaking Changes

### Added

### Changed

### Fixed

- Ruby and Julia eval cells now wait for the subprocess `ready` signal before execution timeouts begin, so interpreter startup under load cannot time out a state-setting cell and silently restart the kernel before the next cell runs.

### Removed

## [2026.8.21-3] - 2026-08-21

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.21-2] - 2026-08-21

### Breaking Changes

### Added

### Changed

### Fixed

- `js` eval cells now accept `local://` paths in `read()` and `write()` like every other kernel. The session manager computed the session local root only after its `language === "js"` early return, so the JavaScript kernel was constructed without `localRoots` or `artifactsDir` and every `local://` helper call failed with `Protocol paths are not supported by write()`, even though the JavaScript prelude documents `local://` as the session local root. `py`/`rb`/`jl` behavior is unchanged.

### Removed

## [2026.8.21] - 2026-08-21

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.20-2] - 2026-08-20

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.20] - 2026-08-20

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.19] - 2026-08-19

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.18-3] - 2026-08-18

### Breaking Changes

### Added

### Changed

### Fixed

- Eval cells that initiated no tool calls no longer render a `0 calls · 0.00 calls/s`
  throughput badge; the footer shows only the elapsed time. Positive call counts are
  unchanged.

### Removed

## [2026.8.18-2] - 2026-08-18

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.18] - 2026-08-18

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.17] - 2026-08-17

### Breaking Changes

### Added

- Show exact nested tool-call count and calls-per-second in completed eval TUI headers, using true wall-clock elapsed time for both the visible duration and throughput denominator while preserving kernel-reported timing separately ([#916](https://github.com/code-yeongyu/senpi/pull/916)).

### Changed

### Fixed

### Removed

## [2026.8.16] - 2026-08-16

### Breaking Changes

### Added

- Published one versioned `senpi.eval.execution` event per settled eval cell: the in-process bus receives bounded rich call details, while the external RPC projection exposes only byte-capped timing/count metadata for safe OMO analytics; total wall time, kernel runtime, pending calls, exact aggregate totals, and overflow accounting are reported separately ([#897](https://github.com/code-yeongyu/senpi/pull/897)).

### Changed

### Fixed

### Removed

## [2026.8.14] - 2026-08-14

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.13-2] - 2026-08-13

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.13] - 2026-08-13

### Breaking Changes

### Added

- Gave every eval cell a wall-clock hard limit (`hardLimitSeconds`, default 1800s, overridable with `SENPI_CODEMODE_HARD_LIMIT_SECONDS`) so a detached or tool-call-heavy cell can no longer run unbounded: the deadline survives `detach()` and is never paused by bridge tool calls, and a cell it kills reports itself to the agent as killed at the hard limit ([#857](https://github.com/code-yeongyu/senpi/pull/857)).

### Changed

### Fixed

### Removed

## [2026.8.12-4] - 2026-08-12

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.12-3] - 2026-08-12

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.12-2] - 2026-08-12

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.12] - 2026-08-12

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.11-6] - 2026-08-11

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.11-5] - 2026-08-11

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.11-4] - 2026-08-11

### Breaking Changes

### Added

### Changed

### Fixed

- Ruby and Julia `eval` kernels launched from standalone Bun binaries now
  resolve their external runner files from the shipped codemode sidecar when
  the embedded `$bunfs` module path has no physical asset
  ([#818](https://github.com/code-yeongyu/senpi/pull/818)).

### Removed

## [2026.8.11-3] - 2026-08-11

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.11-2] - 2026-08-10

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.11] - 2026-08-10

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.10] - 2026-08-10

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.9-2] - 2026-08-09

### Breaking Changes

### Added

### Changed

- Detached eval cells now emit the shared `wake_source_state` event under source `senpi-codemode` when they detach, complete, stop, or are disposed. The optional host event passthrough remains guarded, synchronous cells emit no lifecycle transition, and per-cell snapshot metadata is preserved.

### Fixed

### Removed

## [2026.8.9] - 2026-08-09

### Breaking Changes

### Added

- Detached eval cells now publish their liveness as a `resumption_channel_state` event (source `eval-detached`) on the
  host event bus: a full per-source snapshot with `activeCount` and per-cell `id`/`description`/`startedAtMs` entries is
  emitted whenever a cell detaches, settles, is stopped, or is disposed, and once on `session_start`. The goal builtin
  consumes this to hold its hidden continuation while detached cells are still computing instead of nagging immediately
  at turn end. Hosts without an event bus are unaffected (emission is a no-op), and the footer/status rendering is
  unchanged.

### Changed

### Fixed

### Removed

## [2026.8.7] - 2026-08-07

### Breaking Changes

### Added

### Changed

### Fixed

- Formatted completed eval durations in the simple-result transcript branch with the same compact human-readable units
  used by detailed cell headers and nested tool widgets, so sub-second, seconds, minutes, and hours values render as
  labels such as `<1s`, `12s`, `3m 5s`, or `1h 2m` instead of raw millisecond counts. Live footer, working-status, and
  thinking-duration policies are unchanged ([#743](https://github.com/code-yeongyu/senpi/pull/743)).

### Removed

## [2026.8.6] - 2026-08-06

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.5-2] - 2026-08-05

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.5] - 2026-08-05

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.4-2] - 2026-08-04

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.4] - 2026-08-04

### Breaking Changes

- Replaced the eval tool's optional presentation `title` with a required user-language `summary`: every eval call must now describe the cell's purpose in the user's language, callers using `title` must migrate to `summary`, and the generated tool schema, prompt contract, README examples, bridge fixtures, and test corpus all enforce the new argument ([#695](https://github.com/code-yeongyu/senpi/pull/695)).

### Added

- Rendered each eval summary inside its transcript cell frame and used the same summary to label detached cells and their completion notices, so concurrent or long-running JavaScript and Python work remains identifiable after detachment and when results arrive asynchronously ([#695](https://github.com/code-yeongyu/senpi/pull/695)).

### Changed

### Fixed

### Removed

## [2026.8.3-3] - 2026-08-03

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.3-2] - 2026-08-03

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.3] - 2026-08-03

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.1] - 2026-08-01

### Breaking Changes

### Added

### Changed

### Fixed

- Preserve rich live and terminal `eval` details when peeking detached cells,
  including code, title, output, phase, status events, tool-call summaries,
  duration, and structured displays; cancellation now remains authoritative
  over late completion races
  ([#603](https://github.com/code-yeongyu/senpi/pull/603)).

### Removed

## [2026.7.31-2] - 2026-07-31

### Breaking Changes

### Added

### Changed

- Include a live elapsed label in detached `eval` footer status. The ticker updates only when the rendered duration
  changes and is disposed when the cell completes, fails, or is stopped.

### Fixed

### Removed

## [2026.7.31] - 2026-07-31

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.30-2] - 2026-07-30

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.30] - 2026-07-30

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.29-6] - 2026-07-29

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.29-5] - 2026-07-29

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.29-4] - 2026-07-29

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.29-3] - 2026-07-29

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.29-2] - 2026-07-29

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.29] - 2026-07-29

### Breaking Changes

### Added

- Show every live detached eval cell in the interactive footer, using a highlighted `↗ <language> · <title>` status for one cell and a bounded packed summary for multiple cells; clear the status immediately when the final detached cell settles ([#483](https://github.com/code-yeongyu/senpi/pull/483)).

### Changed

### Fixed

- Route reserved `agent()`, `output()`, and `tool_schema()` bridge calls from Python and other subprocess kernels through the reserved HTTP handler instead of attempting to execute nonexistent `__agent__`, `__output__`, and `__schema__` tools; ordinary bridge tool calls remain unchanged ([#462](https://github.com/code-yeongyu/senpi/pull/462)).

### Removed

## [2026.7.28-3] - 2026-07-28

### Breaking Changes

### Added

- Add nested tool-call widgets that render the real call shape of tools invoked from eval cells, with truthful status, duration, and sanitized previews ([#444](https://github.com/code-yeongyu/senpi/pull/444)).

### Changed

### Fixed

### Removed

## [2026.7.28-2] - 2026-07-28

### Breaking Changes

### Added

### Changed

### Fixed

- Start a fresh eval cell when a caller reuses the ID of a terminal cell, preventing completed or failed results from being replayed as though new code had executed ([#439](https://github.com/code-yeongyu/senpi/pull/439)).
- Omit the eval `took` duration when timing metadata is unavailable, avoiding misleading zero-duration status output for detached or restored cell results ([#439](https://github.com/code-yeongyu/senpi/pull/439)).

### Removed

## [2026.7.28] - 2026-07-28

### Breaking Changes

### Added

- Add `tool_schema()` and return parameter schemas from failed eval tool calls so cells can inspect and self-correct tool invocations ([#407](https://github.com/code-yeongyu/senpi/pull/407)).

### Changed

- Allow eval cells and extensions to activate named searchable tools lazily on the calling surface without globally widening the active tool set ([#408](https://github.com/code-yeongyu/senpi/pull/408)).

### Fixed

### Removed

## [2026.7.26] - 2026-07-26

### Breaking Changes

- Remove the separate GPT-only `exec`/`wait` runtime; GPT models now compose active tools through the persistent `eval` surface.

### Added

- Detach interactive `eval` cells on timeout, inject completion notifications, and support `peek`/`stop` actions without blocking other language kernels.
- Report whether Python kernel state survived an interrupt or timeout, with a real-surface QA driver covering the contract.

### Changed

- Bound each cell's retained status history and summarize omitted events ([#334](https://github.com/code-yeongyu/senpi/pull/334) by [@minpeter](https://github.com/minpeter)).
- Make task-output lookups non-blocking and document detached-cell state, output, and artifact behavior.

### Fixed

- Preserve Python state when interruption succeeds, report truthful state when it does not, and tolerate kernels predating the interrupt-outcome contract.
- Stop normal bridge-request completion from aborting still-running host tool calls.

### Removed

## [2026.7.25-2] - 2026-07-25

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.25] - 2026-07-25

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.24] - 2026-07-24

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.23] - 2026-07-23

### Breaking Changes

### Added

- Added the GPT-only Code Mode runtime with `exec` and `wait` tools, plus model-aware GPT eval routing ([#301](https://github.com/code-yeongyu/senpi/pull/301)).

### Changed

### Fixed

### Removed

## [2026.7.22-2] - 2026-07-22

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.22] - 2026-07-22

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.20-2] - 2026-07-20

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.20] - 2026-07-20

### Breaking Changes

### Added

### Changed

### Fixed

- Fixed the Python kernel's `tool.<name>()` proxy injecting an omp-only `i` ("py prelude") intent field into every bridged tool call. Senpi tool schemas never declare `i`, so strict tools (`additionalProperties: false`, e.g. `web_search`) rejected every eval-bridged call with `Validation failed for tool …: must not have additional properties`. Args now pass through verbatim, matching the JS/Ruby/Julia preludes.

### Removed

## [2026.7.17-5] - 2026-07-17

### Breaking Changes

### Added

### Changed
- Changed the Kimi K-series eval prompt dialect to make eval-first, whole-step parallel batching the default: strong positive emphasis now directs multi-call work into one `eval` cell, parallelizes independent calls, handles failures in-kernel, and returns distilled facts.

### Fixed

### Removed

## [2026.7.17-4] - 2026-07-17

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.17-3] - 2026-07-17

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.17-2] - 2026-07-17

### Added

- Added a host-sizing note to the `eval` prompt: the extension now passes a preformatted host line (platform, arch, CPU model, core count) at registration so the prompt tells the model to size `parallel(thunks)` pools to the local cores and keep shell commands platform-appropriate.
- Added model-aware eval-first batching emphasis: the `eval` tool description and its system-prompt guideline now render in a dialect selected by the active model id (Claude/GLM, OpenAI, Kimi, and a maximum-emphasis default fallback), re-registering on `model_select` so mid-session model switches pick up the matching dialect.

### Changed

### Fixed

## [2026.7.17] - 2026-07-17

### Added

### Changed

### Fixed

- Fixed `eval` tool calls rendering duplicate stacked boxes after a result arrived; the pending, running, and completed states now update in one in-place frame ([#223](https://github.com/code-yeongyu/senpi/pull/223)).

## [2026.7.16-3] - 2026-07-16

### Added

### Changed

### Fixed

## [2026.7.16-2] - 2026-07-16

### Added

### Changed

### Fixed

## [2026.7.16] - 2026-07-16

### Added

### Changed

### Fixed

## [2026.7.14-3] - 2026-07-14

### Added

### Changed

### Fixed

## [2026.7.14-2] - 2026-07-14

### Added

### Changed

### Fixed

## [2026.7.14] - 2026-07-14

### Added

### Changed

- Improved the `eval` prompt instructions and reuse-chain examples to teach persistent-state reuse, batch file processing, and parallel session-tool fan-out within a single cell.

### Fixed

## [2026.7.13] - 2026-07-13

### Added

- Added the source-only `@code-yeongyu/senpi-codemode` workspace package scaffold.
- Added codemode settings loading, interpreter detection, prompt generation, loopback bridge helpers, and persistent JS/Python/Ruby/Julia kernel building blocks.
- Added structured kernel status events from the bridge through TUI rendering.
- Added `agent()` and `output()` bridges that delegate through configured task-tool contracts.
- Added bounded streaming output with session-adjacent spill files and plain-path notices.
- Added eval render parity for highlighted cells, status rows, task progress, JSON displays, truncation warnings, and image fallbacks.
- Added JavaScript import rewriting for persistent eval cells.

### Changed

- Activated the exported extension factory so the bundled package registers and reconfigures the persistent-kernel `eval` tool in Senpi sessions.
- Improved `eval` TUI rendering with streaming status and timing, bounded expandable previews, width-safe ANSI/CJK/emoji reflow, nested tool-call state, and terminal-aware image fallbacks.
- Re-register the eval prompt and schema at session start after settings, interpreter availability, and active task-tool names resolve.
- Recorded the completed oh-my-pi eval-port provenance for this extension; task delegation and artifact handling follow Senpi extension boundaries.

### Fixed

- Prevented image MIME labels from injecting terminal control sequences through eval text fallbacks.
- Fixed eval cancellation and timeout handling across JavaScript, Python, Ruby, and Julia kernels: aborts now interrupt active work, unresponsive subprocesses escalate to bounded hard termination, queued Python cells cannot execute after cancellation, persistent Python state survives graceful interrupts, timeout/death durations remain truthful, and late bridge or retired-process output cannot keep an eval hung or contaminate the next cell.
- Fixed the bundled `eval` extension failing to load in packaged installs: `completion/handler.ts` imported peer symbols via the monorepo source path `../../../ai/src/*`, which only resolves inside the workspace and threw `Cannot find module` once packed. It now imports from the `@earendil-works/pi-ai/compat` package entry, so `eval` loads in the shipped Node package.
- Fixed a temporal-dead-zone crash in the `eval` tool: subprocess kernels (py/rb/jl) emit their `ready` frame synchronously during kernel startup, which invoked the message handler before the `kernel` binding initialized and crashed the whole agent process. The self-referential binding is now hoisted so startup frames no longer throw.
- Fixed cell-output misattribution on reused persistent kernels: `getKernel` now rebinds the per-cell `onMessage` on every call, so a second (and later) cell's streamed `text`/`display`/`log` output is delivered to that cell instead of the previous one.
- Fixed the Ruby kernel corrupting its JSONL protocol channel: user `puts`/`print` output is now captured via a redirected `$stdout` and emitted as `text` frames instead of being written directly onto the shared stdout stream.
- Fixed the Ruby kernel raising `ArgumentError: unknown keywords` on Ruby 3.0+ (e.g. CI's Ruby 3.x, while local Ruby 2.6 masked it): `env()`/`read()`/`write()` passed braceless string-keyed hashes to `__senpi_emit_status`, which Ruby 3 parses as keyword arguments against its `force:` keyword parameter instead of the positional `fields` hash. The field hashes are now wrapped in explicit braces so status emission and final-expression auto-display work identically across Ruby 2.6–3.4.
