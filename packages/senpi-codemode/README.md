# @code-yeongyu/senpi-codemode

`@code-yeongyu/senpi-codemode` is Senpi's source-only Code Mode extension. It
registers the persistent-kernel `eval` execution surface for every eligible
model. `eval` owns one persistent kernel per enabled language and re-registers
at session start after configuration, interpreter availability, and active
task-tool names are known.

## Capabilities

- Persistent JavaScript, Python, Ruby, and Julia cells. State survives later
  cells in the same language until reset, restart, or session disposal.
- Timeout detachment for interactive `eval`: long pure-compute cells return a
	handle and continue in their existing kernel. Completion is injected with the
	final value/error and buffered output; use `eval({ action: "peek"|"stop",
	cell_id })` to inspect or terminate a detached cell. A running peek preserves
	the original code and summary together with current output, phase, status
	events, tool-call summaries, elapsed duration, and structured display state;
	a terminal peek preserves the exact final result.
- Loopback, bearer-authenticated kernel bridge with bounded JSONL frames.
- Tool calls retain the submitting cell's host context, including its RPC approval
  channel, even after detachment or kernel reuse. Headless sessions deny commands
  that require approval rather than waiting for an absent UI.
- Structured status events for file operations, environment access, phases,
  bridge activity, and delegated task progress.
- One versioned `senpi.eval.execution` event at terminal cell settlement. The
  in-process event bus receives bounded per-call arguments and result previews
  for extension-owned consumers; external RPC clients receive a 32 KiB-capped
  metadata-only projection with wall time, kernel time, exact call counts,
  pending-call counts, and bounded per-tool aggregates.
- Bounded streaming output with head/tail previews, column clamping, and
  session-adjacent spill files for large streams.
- TUI and HTML-export rendering for syntax-highlighted cells, status rows,
  task progress, structured display values, truncation warnings, and image
  fallbacks. A JavaScript cell sent as dense one-line code is previewed broken
  at statement, block, and long-array boundaries; the cell itself runs exactly
  as sent.
- Runtime identity badges in eval headers — `eval py (3.14.7, ~/.venv/bin/python3)`,
  `eval js (node 26.7.0, /opt/…/bin/node)` — with the same `runtime` info on
  `EvalToolDetails` and its `cells` for RPC consumers; interpreter detection
  resolves absolute executable paths, and the eval prompt host line names the
  JS runtime (`node`/`bun`).
- JavaScript import rewriting for supported local modules and package imports
  in the persistent JS worker (Bun when senpi runs on bun, Node.js otherwise).
- On a Bun >= 1.4 kernel the eval prompt names the bundled `bun-1-4` skill as
  MUST READ before the first js cell; node kernels keep the Node.js wording.
- GPT models receive a terse `eval` prompt dialect that prioritizes composing
  active tools through `tool.<name>(args)` and documents detach-on-timeout.

## Kernels

| Language | Default | Runtime | Notes |
| --- | --- | --- | --- |
| `js` | enabled | In-process worker on senpi's own runtime (Bun or Node.js 24+) | Supports top-level `await` and `return`; the eval prompt's runtime line follows the kernel. |
| `py` | enabled | `python3` or `python` | Optional interpreter detected at session start. |
| `rb` | disabled | `ruby` | Optional interpreter detected at session start. |
| `jl` | disabled | `julia` | Optional interpreter detected at session start. |

A missing optional interpreter removes that language from the session's `eval`
schema; it is not an installation failure.

Python startup waits for the interpreter's `ready` event. It reports progress
through `stdlib-imports`, `runtime-init`, and `host-init`; advancing to the next
stage resets an inactivity guard rather than consuming a total startup budget.
The default guard is 11 seconds per stage, derived from a measured 5.220-second
Windows fresh-cache bootstrap p99 (30 samples). A stalled or failed start names
the last stage and retains the interpreter's diagnostic error. The low-level
`PythonKernel.start({ startupTimeoutMs })` override applies per stage.

### Session environment

Every kernel starts with the active session's `PI_*` environment — `PI_SESSION_ID`,
`PI_SESSION_FILE` (when the session is persistent), `PI_SESSION_CWD` (the session's
working directory), `PI_GOAL_STORE_FILE` (the authoritative goal-store path, when the
host provides it), `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL` (when set) — resolved at session start, mirroring the bash tool's
session environment contract. The values are visible to `env()`/`process.env`/`os.environ`
inside cells and are inherited by every child process a cell spawns
(`Bun.$`, `Bun.spawn`, `child_process`, `subprocess`, ...). Inherited `PI_*` values from
the launching environment are dropped first, so a child spawned from a cell sees exactly
what a child spawned from the bash tool sees. The values snapshot at kernel start, so a
mid-session model switch updates the bash tool's next command but not already-running
kernels; a new session starts fresh kernels with fresh values.

### Working directory

Every kernel runs in the session's working directory, the same directory the read,
edit, and bash tools use. Python, Ruby, and Julia start their interpreter there. The
JavaScript kernel is a worker thread, which cannot change directory, so it applies the
session directory itself: `process.cwd()`, `path.resolve`, `node:fs` and
`node:fs/promises`, `node:child_process`, `Bun.file`, `Bun.write`, `Bun.$`,
`Bun.spawn`/`Bun.spawnSync`, `Bun.Glob` scans, and relative `import()` all resolve a
relative path inside the session directory, never the host process directory. The host
process and the bash tool keep their own directory. When the session directory is
missing or deleted, the next cell fails with `CodemodeSessionCwdUnavailableError` naming
the directory instead of running somewhere else. A new session (including a switch to
another project) starts fresh kernels in its own directory.

`PI_GOAL_STORE_FILE` is supplied by the host's optional `ExtensionContext.goalStoreFile`
getter and may name a file that does not exist yet. It honors session-directory overrides
and in-memory sessions; it cannot be derived reliably from `PI_SESSION_FILE`. If the host
omits the getter, the variable is unset rather than inherited from the launching process.

### Python packages

A Python cell whose only line is `%pip install <requirements>` installs packages
without restarting the kernel: variables, the process and its working directory
stay as they were. The cell runs in the kernel's queue like any other cell (it waits
for the cell ahead of it, can be cancelled while queued, and detaches past the
foreground window), but the install runs on the host, so its time does not count
against the run budget. The next cell imports the new packages; modules a cell
already imported stay cached until `reset`.

Packages go into the session's own environment, never into the interpreter's
site-packages or the user site: pip always runs as
`<kernel interpreter> -m pip install --target <environment>`, and flags that pick
another destination (`--target`, `--user`, `--prefix`, `--root`, `--home`,
`-e`) are refused. Each install builds a new revision of the environment and
publishes it only when pip succeeds, so a failed or cancelled install leaves the
previous packages active and importable. A cell that mixes `%pip` with code is
refused; put `%pip` on its own cell.

`%environment managed` (the default) keeps the environment under the session's
artifacts directory, or `environments.managedRoot` when set; `%environment project`
installs into `<cwd>/.senpi/python-packages` instead, shared by every session in
that project, with concurrent installs serialised by a lock. Setting
`environments.autoProvision` to `false` turns installs off
(`environment_installer_unavailable`). Failures carry pip's error output and one
of `environment_install_failed`, `environment_install_cancelled`,
`environment_installer_unavailable` or `environment_resolution_conflict`.

## Settings

Configuration is loaded in this order:

1. `.senpi/codemode.json` in the session working directory
2. `~/.senpi/agent/codemode.json`
3. Built-in defaults

```json
{
  "languages": {
    "py": true,
    "js": true,
    "rb": false,
    "jl": false
  },
  "cellTimeoutSeconds": 30,
  "foregroundWindowSeconds": 60,
  "runBudgetSeconds": 300,
  "hardLimitSeconds": 1800,
  "maxDetachedCells": 15,
  "parallelPoolWidth": 4,
  "taskTools": {
    "task": "task",
    "output": "task_output"
  },
  "outputSink": {
    "headBytes": 20480,
    "maxColumns": 768
  },
  "statusEvents": true,
  "memory": {
    "gcWatermarkMb": 256,
    "noticeMb": 1024,
    "ceilingMb": 8192,
    "retainedResultsMb": 32,
    "retainedImagesMb": 256
  }
}
```

| Key | Default | Effect |
| --- | --- | --- |
| `languages` | `py`/`js` enabled; `rb`/`jl` disabled | Selects desired languages before interpreter detection. |
| `cellTimeoutSeconds` | `30` | Idle time an interactive call blocks the turn before the cell detaches. Print/json calls never detach. |
| `foregroundWindowSeconds` | `60` | Submission-based foreground limit, including queue and bridge pauses. The cell detaches if capacity is available; otherwise it is cancelled with `eval_background_capacity_reached`. Env override: `SENPI_CODEMODE_FOREGROUND_SECONDS`. |
| `runBudgetSeconds` | `300` | Kill deadline for a cell's own execution time - child processes, network, timers, CPU. Time queued or parked in host tool calls (`agent()`, `tool.*`) is not charged, and the budget keeps counting after the cell detaches. A per-call `timeout` replaces it for that cell. Env override: `SENPI_CODEMODE_RUN_BUDGET_SECONDS`. |
| `hardLimitSeconds` | `1800` | Wall-clock kill deadline from submission, including queue and parked time; a per-call `timeout` above it raises it. Env override: `SENPI_CODEMODE_HARD_LIMIT_SECONDS`. |
| `maxDetachedCells` | `15` | Global detached-cell capacity across all kernels, including queued cells. At capacity, interactive cells stay foreground until completion or the foreground window elapses. Env override: `SENPI_CODEMODE_MAX_DETACHED_CELLS`. |
| `parallelPoolWidth` | `4` | Maximum concurrent `parallel()` thunks. |
| `taskTools.task` | `"task"` | Registered tool name used by `agent()`. |
| `taskTools.output` | `"task_output"` | Registered tool name used by `output()`. |
| `outputSink.headBytes` | `20480` | Bytes retained from the beginning of a middle-truncated preview; `0` disables it. |
| `outputSink.maxColumns` | `768` | Maximum columns per printed output line; `0` disables column clamping. A cell's return value is never column-clamped (the byte and line budgets still apply). |
| `statusEvents` | `true` | Enables kernel status-event forwarding and rendering. Each cell retains at most 100 status rows; after overflow, one omitted-count row precedes the latest 99 events. |
| `memory.gcWatermarkMb` | `256` | JavaScript kernel: a finished cell whose heap reached this size and grew runs a full collection before its result; whenever at least this much stays live, an idle full collection runs about a second after the cell, so dropped globals return their memory without a reset. Python kernel: a finished cell whose process footprint reached this size and grew runs `gc.collect()` (plus glibc `malloc_trim(0)` on Linux) before its result, and while at least this much stays live the next cells collect too (at most 1/20 of the time), so `del rows` returns its memory. `0` disables. Env override: `SENPI_CODEMODE_MEMORY_GC_WATERMARK_MB`. |
| `memory.noticeMb` | `1024` | When live memory (JS heap or Python footprint after a collection; Ruby and Julia interpreter footprint read by the host after each cell) reaches this size (first time, or 25% more than at the last notice), the result gets one bracketed notice naming the largest globals and how to drop them (`rows = undefined`, `del rows`, `rows = nil`, `rows = nothing`), plus `details.memory`. `0` disables. Env override: `SENPI_CODEMODE_MEMORY_NOTICE_MB`. |
| `memory.ceilingMb` | a quarter of physical memory, 2048-8192 | Every kernel (JS heap and Python footprint after a collection; Ruby and Julia interpreter footprint read by the host after each result, without a globals list): when live memory reaches this size, the result says so and the kernel restarts once no cell is running or queued on it; the next result says it was restarted (`details.memory.recycled`). `0` disables. Env override: `SENPI_CODEMODE_MEMORY_CEILING_MB`. Non-zero memory thresholds must satisfy watermark <= notice <= ceiling, otherwise all three use their defaults. |
| `memory.retainedResultsMb` | `32` | In-memory byte budget (MiB) for the settled cells kept for `peek`/`list`, on top of the 32-cell count cap; the oldest go first and the newest is always kept. `0` keeps only the count cap. Env override: `SENPI_CODEMODE_RETAINED_RESULTS_MB` (a non-negative integer). |
| `memory.retainedImagesMb` | `256` | Disk budget (MiB) for settled-cell images. Images of settled cells (foreground and detached) are written as base64 files under `<session artifacts>/settled-images/` instead of staying in memory, and `peek` reads them back, so it returns the full result. Beyond the budget the oldest files are deleted first; an evicted cell's files are deleted with it; the directory is removed when the session ends. A `peek` whose image file is gone returns the text plus a one-line note. `0` keeps only the count cap. Env override: `SENPI_CODEMODE_RETAINED_IMAGES_MB` (a non-negative integer). |
| `memory.idleParkMinutes` | `0` | Off by default. When greater than 0, a kernel with no cell running or queued for this many minutes is closed to give its memory back, and the next cell for that language starts a fresh one; that cell's result says the kernel was restarted and every earlier global is lost. Applies to every language. |
| `languages.pyInterpreter` | unset | Explicit Python interpreter path. Unset keeps today's `PATH` detection. |
| `environments.managedRoot` | unset | Root directory for managed per-session environments; unset uses the session's default location. |
| `environments.autoProvision` | `true` | Lets installs provision a managed environment. `false` makes installs refuse with `environment_installer_unavailable`. |
| `environments.js.installer` | `auto` | Installer for the managed JavaScript environment: `auto`, `bun` or `npm`. |
| `environments.py.installer` | `pip` | Installer for the managed Python environment. |
| `isolation.js` | `worker` | JavaScript kernel isolation: `worker` (today's worker thread) or `process`. Env override: `SENPI_CODEMODE_JS_ISOLATION`. |
| `sandbox.enabled` | `false` | Allows sandbox cells. While `false` the sandbox option is neither accepted nor advertised. |
| `sandbox.memoryMb` | `64` | Memory cap (MiB) for a sandbox cell. Env override: `SENPI_CODEMODE_SANDBOX_MEMORY_MB` (a positive integer wins). |
| `sandbox.timeoutSeconds` | `300` | Time limit for a sandbox cell. |
| `prompt.advertiseHelpers` | `false` | When `true`, one pointer line to `tool_schema('eval:helpers')` is appended to the eval description. |
| `kernelTools.enabled` | `true` | Allows cells to define kernel tools (`tool(fn)`, `@tool`). `false` makes them refuse with `tools_unavailable`. |

The `languages.pyInterpreter`, `environments.*`, `isolation.*`, `sandbox.*`, `prompt.*` and `kernelTools.*` keys are accepted and validated now, with the defaults shown, which match today's behaviour. The effect each of those rows describes takes effect when its feature ships; until then, setting a key changes nothing.

`SENPI_CODEMODE_PY`, `SENPI_CODEMODE_JS`, `SENPI_CODEMODE_RB`, and
`SENPI_CODEMODE_JL` override the corresponding file setting. `1` or `true`
enables; `0` or `false` disables. Any other value leaves the file setting in
effect.

A top-level key this version does not know is ignored with one warning naming it, and the rest of the file still applies, so a settings file written for a newer senpi keeps working. Malformed JSON, or an invalid value or an unknown key inside a known setting, falls back to all defaults with a warning.
The detached-cell environment override uses the run-budget parser: a positive
base-10 integer wins over the file value; zero, negative, and malformed values
leave the file value in effect.

## Cell helpers

Python, JavaScript, Ruby, and Julia expose the same conceptual helpers. Python,
Ruby, and Julia use trailing keyword options; JavaScript uses one trailing
options object and asynchronous helpers are `await`-able.

| Helper | Contract |
| --- | --- |
| `display(value)` | Emits text, structured JSON, markdown, or image display data. Images reach the model only through `display`: pass a figure, raw image bytes (PNG/JPEG/GIF/WebP/BMP sniffed), a `data:` URL, a `Blob`-like or `Bun.Image` value, a marshalled tool result, or one of its `images[i]` frames. |
| `print(value, ...)` | Emits text output. |
| `read(path, offset?, limit?)` | Reads text with 1-indexed line slicing. `local://` paths resolve under the session artifact root. |
| `write(path, content)` | Creates parent directories and writes text. `local://` paths persist in the session artifact root. |
| `env(key?, value?)` | Reads all kernel environment values, one value, or sets one value. Includes the session's `PI_*` values (see [Session environment](#session-environment)). |
| `tool.<name>(args)` | Invokes an active Senpi tool through the normal `pi.executeTool` pipeline and returns `{ text, images?, details?, hasError? }` in every kernel; image blocks arrive as `images[i] = { mimeType, dataBase64 }`. |
| `tool_schema(name?)` | Returns a tool's parameter schema without calling it; omit `name` to list tool names. |
| `completion(prompt, model?, system?, schema?)` | Requests a one-shot host completion; `schema` asks the host to parse structured output. |
| `agent(prompt, ...)` | Delegates to the configured active `taskTools.task` tool. Supports background handles and structured JSON results. |
| `workpool(agent, name, mode?)` | Creates a thin adapter over the normal host `workpool` tool; exposes `pool_id`, `push(items)`, `close()`, `inspect()`, and `cancel()`. JS awaits creation and operations. |
| `output(ids, format?, offset?, limit?)` | Delegates transcript retrieval to the configured active `taskTools.output` tool. |
| `parallel(thunks)` | Runs thunks through the configured bounded pool while preserving input order. |
| `pipeline(items, ...stages)` | Applies stages left to right with a barrier between stages. |
| `log(message)` / `phase(title)` | Emits progress text and starts a status phase. |

When a `tool.<name>()` call fails argument validation, the error delivered back
into the cell carries the tool's expected parameters, so the cell can correct the
arguments and retry instead of falling back to one-at-a-time tool calls.
`tool_schema()` exposes the same catalog up front.

A tool may also contribute globals of its own through `ToolDefinition.kernelPrelude`
(JavaScript and Python snippets that call the ordinary `tool.<name>()`, one
documentation line, and the exported names). While the tool is active, each
JavaScript and Python cell installs any missing export first and the eval prompt
lists the documentation line; once the tool is deactivated, the next cell deletes
those names. Exports that shadow a built-in helper are rejected by the host.

`agent()` is available only when the configured task tool is active in the
session. `output()` similarly requires the configured task-output tool and
returns immediately: a running task reports its current status, while completed
tasks return the requested transcript. Missing tools produce a clear
availability error instead of importing an orchestration package. `agent()`
delegates through the tool contract, so task-engine permissions, progress
updates, and transcripts remain owned by that engine.
`isolated` and `apply` accept booleans; `merge` accepts `"patch"` or `"branch"`
(and `false`/`true` aliases respectively). The bridge checks the configured task
parameter schema once per bridge, using the same host catalog as `tool_schema()`.
If it advertises `isolated`, these options are forwarded; otherwise they are
omitted with the existing warning. Senpi does not implement isolation itself.
A foreground host result with `details.isolation.changes_applied === false`
raises `AgentIsolationNotAppliedError` (`isolation_not_applied`), including any
`patch_path`, `branch_name`, and `manual_command` recovery fields in its message.
The bridge retains host `details.isolation`; successful foreground helpers still
return text or parsed JSON.

Background `agent()` handles retain `id` and `agent://<id>` and include `run_epoch`.
The host must return structured `details.task_id` (`st_` plus lowercase hex) and
an integer `details.run_epoch >= 0`. Missing or malformed details raise
`invalid_task_handle`; prose IDs are never used. Handles return immediately,
so final isolation results are not available on the initial handle: await the
completion notification or read `task_output` (via `output()`) after completion.
Any isolation metadata supplied by the host on a handle is preserved as
`details.isolation`, not interpreted as a foreground apply failure.

`workpool` takes exactly one of `{category, prompt, model?}` or
`{subagent_type, prompt, model?}` as its plain-data agent spec. Mode is `fresh`
or `keep_alive`: pass `{mode: "fresh"}` in JS, `mode="fresh"` in Python/Julia,
or `mode: "fresh"` in Ruby. Omission is forwarded unchanged to the engine;
hosts without an approved default still require an explicit mode. Custom tool
names are not enabled by this adapter.

`push` forwards `[{key, input}]` and returns the host receipt without waiting
for admission. Operations return the same `{text, details, images?, hasError?}`
envelope as direct tool calls. Creation refuses host errors instead of returning
a broken adapter; a missing host raises `workpool_unavailable`. The host owns
workers, keyed yields, cancellation, and aggregate delivery after explicit
`close()`; none is implemented in a kernel. Aggregate support requires a host
that implements it. Reset only removes kernel variables: save `pool_id` and use
`tool.workpool({op: "inspect", pool_id})` from a new JS cell (equivalent keyword
arguments in other languages). An open pool's adapter can be recreated with the
same name/spec/mode; no worker state is reconstructed in the prelude.

## Required run fields

Every `eval` run call MUST include a `language` (the kernel that runs the
cell, one of the enabled languages), the `code` cell body, and a `summary` —
one line in the language the
user writes in: a progress update saying what the agent is doing and why, not
a label for the code. The
summary is shown in the TUI while the cell runs and in the finished result, so
you can always tell what is running and why. It has no length limit; a
collapsed block shows its first three lines. The schema requires all three
for runs, including when `action` is omitted. Control actions (`peek`, `stop`,
`list`) do not require run fields. Each action branch declares its own fields
so providers can interpret it independently.

## Detached cells

`eval` accepts `on_timeout: "detach"|"error"`. The default is `"detach"` in
interactive TUI, RPC, and app-server sessions; print and JSON one-shot runs
default to `"error"` so their result is never silently detached. A detached
cell keeps only its own language kernel busy. New same-language cells are admitted
into its FIFO queue; calls in other languages continue normally. Queued cells may
also detach, within the global `maxDetachedCells` cap. At capacity, the first idle
detach attempt leaves the cell foreground and re-arms one wait for the remaining
submission-based foreground window. At the window, it detaches if a slot is now
free; otherwise it settles `cancelled` with `eval_background_capacity_reached`,
listing the live cells and a stop-or-wait remedy. Cells that complete inside the
window return normally. Cancelling a queued cell never interrupts its predecessor.
Do not re-run a detached or queued cell; each detached cell completes as one notification.

Queued steering also detaches an eligible interactive foreground call, including
one paused in a host tool bridge, without cancelling its computation. If the
global detached cap is reached, steering leaves the call waiting. Follow-up
messages, explicit `on_timeout: "error"`, and print/JSON calls do not trigger this
transition; caller abort and existing deadlines retain their cancellation behavior.

Every cell, detached or not, is bounded by two kill deadlines. The run budget
(`runBudgetSeconds`, or the call's `timeout`) charges only the cell's own
execution time and is paused while queued or while a host tool call is in flight, so a cell
waiting on `agent()` survives while a runaway child process or loop does not.
The hard limit (`hardLimitSeconds`, raised by a larger `timeout`) is wall-clock
from submission and bounds queued and parked cells too. A cell killed by either deadline reports which one
in its result or completion notification, together with whether kernel state
survived; the tool schema states the configured numbers. The `timeout` value
never changes the idle detach deadline: that is `cellTimeoutSeconds` capped by
`foregroundWindowSeconds`; queued steering can detach the call earlier.

While any cell is detached, the interactive footer shows a highlighted
`↗ <language> · <summary>` status on the extension status line (the cell id
when the call had no summary), clearing as soon as the last detached cell settles.
Queued entries are labelled `queued`; an all-queued footer shows `(queued)` instead
of an elapsed duration. Elapsed time counts only from execution start.

Use `eval({ action: "list" })` without a language or cell id to see live and
recently settled cells across languages. Each line includes the id, language,
state, elapsed execution seconds, queue predecessors, and summary (or a short code
preview); `details.cells` carries the typed cell metadata. Listing never consumes
completion notifications.

A run with `reset: true` resets only its selected language and is refused with
`eval_kernel_busy_reset_refused` while any other cell in that language is live,
including queued cells. The requesting cell fails without changing the kernel or
cancelling existing work. Stop those cells explicitly or wait for their completion
notifications before resetting; live cells in other languages do not block reset.

Use `eval({ action: "peek", cell_id })` for its state and buffered output, or
`eval({ action: "stop", cell_id })` to cancel it. Stopping a queued cell removes it
without interrupting the active cell; kernel state is retained. Python running-cell stop interrupts the
existing kernel and preserves variables. JavaScript stop is cooperative first:
the worker rejects the cell's pending bridge `tool.*` calls and kills the
`Bun.spawn` children it started, and a cell that settles within the 2 s grace
keeps the worker and every global. Only a cell that stays unsettled (a
never-resolving promise, an un-abortable `fetch`, a `Bun.$` command) costs the
worker VM. A worker blocked in a synchronous call (`Bun.spawnSync`,
`child_process.spawnSync`) cannot be stopped at all; after a 3 s termination
deadline a fresh worker replaces it, the cell output gains a stderr line naming
the blocked synchronous call, and the blocked call keeps running until it
returns. Kernel-level timeouts follow the same path. Stop results and detached
completion messages report the real outcome - variables preserved, worker
restarted, or outcome unknown - never a per-language assumption; oversized
buffered output is written under the session local root and referenced as
`local://…`.

When Stop restarts a kernel waiting on `Bun.$`, the result explicitly says that
the kernel restarted and its variables were cleared. Use `Bun.spawn` or the
bash tool for long-running commands you may want to stop. Native `Bun.$`
cancellation is tracked in [Bun #11868](https://github.com/oven-sh/bun/issues/11868);
the shell's interpretation and object redirects are not replaced.

When a Python, Ruby, or Julia interpreter dies on its own (a crash, an OOM kill,
`os.kill(os.getpid(), 9)`), the cell it was running fails once and is never run
again: its side effects may already have happened. Cells queued behind it keep
their order, callbacks, and deadlines and run on one fresh interpreter started
for that death; the first result there carries
`[<language> kernel was restarted after <reason>; every global is lost]`. If the
fresh interpreter dies too before it finished a cell, the queued cells fail with
`eval_kernel_unavailable` naming the reason, and the next cell you run starts
another. An interpreter whose exit cannot be confirmed is reported, never
replaced by a second one. The JavaScript worker keeps its own restart path.

Commands a cell runs through `Bun.$` never read the host's terminal: the worker
thread shares the TUI's stdin, so the shell wrapper hands every template an
empty pipe (`true | ( … )`) while a cell is active. Output, exit codes, `cwd`,
`env`, and explicit `< ${input}` redirects are unchanged; `Bun.spawn` and
`Bun.spawnSync` already default stdin to `/dev/null`.

## Output and artifacts

Cell output is streamed while the cell runs. Large streams spill to an absolute
file after the default 50 KiB threshold or when the output column cap drops
bytes. With a session file such as `/path/session.jsonl`, artifacts live in
`/path/session-artifacts/`; sessions without a file use a unique temporary
directory. A truncated result tells the model so in its text: the kept and
original sizes, then a plain-path notice such as
`[Full output: /absolute/path/eval-….log]`.

## Deliberate differences from oh-my-pi

- There is no `budget` helper.
- There is no `artifact://` protocol. Spill references are ordinary absolute
  file paths.
- `agent()` and `output()` compose registered task tools through
  `pi.executeTool`; this package does not import a task-engine workspace
  package.
- Task transcript formats are limited to full (`raw`) and trailing (`tail`)
  output. Query, JSON, and stripped metadata formats are task-engine concerns.

## Security and lifecycle

Kernels run locally with the invoking user's permissions. The bridge listens on
loopback only and authenticates each session with a random bearer token.
Session generations fence retired kernels and callbacks; each cell settles once
across completion, errors, cancellation, timeout, bridge failure, or a kernel
crash.

GPT models use the same JavaScript `eval` worker trust boundary as other JavaScript cells;
there is no separate execution runtime. `eval` is excluded from the nested tool
namespace to prevent recursive execution.

## Validation

The regression gate compares full prompt content (240 dialect/capability/runtime/host
combinations), schemas, helper census, live helper witnesses and eager imports,
and runs the legacy contracts. It requires Bun, Node, Python, Ruby and Julia; a missing
interpreter fails rather than skipping a runtime. It does not gate wall-clock
timing or absolute memory footprints; those belong to the paired benchmark.
Ruby 3.4 and later also require the `base64` gem (`gem install base64 --version 0.3.0 --no-document`).

The eager-import probe starts without third-party validation modules loaded.
It validates observer records only after measurement, so a target sharing the
harness dependency tree has the same cold census as a separate checkout.
Module IDs are package-relative. The exact census covers codemode, its non-virtual
dependency closure and Node builtins. The observer records parent edges and reads
both loader `VIRTUAL_MODULES` tables: their backing packages and dependencies
reachable only across virtual edges belong to the host and are excluded from
set equality. Every observed edge and classification remains in the report.
Workspace imports resolve through built `dist` entries. The gate build records
the source file set, inherited build configs and content hashes after a successful
build; preflight rejects missing, changed or deleted inputs. Unchanged content
remains valid after timestamp refreshes. Each ignored `.senpi-gate-inputs.json`
certificate sits beside its workspace manifest, outside the published `dist` tree.

```bash
bun packages/senpi-codemode/scripts/gate-build.ts
bun run --cwd packages/senpi-codemode gate --baseline test/gate/baseline.json
bun run --cwd packages/senpi-codemode test -- test/gate
```

The package test script already selects `test/`, so the last command intentionally
runs the full package suite. For a focused gate-only run, invoke Vitest directly:

```bash
bun run --cwd packages/senpi-codemode vitest run test/gate
```

Install and build both the head checkout and a clean checkout of the PR merge
base with `bun install --ignore-scripts --frozen-lockfile`. Build each target with
the head harness, `bun packages/senpi-codemode/scripts/gate-build.ts <checkout>`.
Record the baseline with the **head harness** against that freshly built base
checkout, not by running an older harness:

```bash
bun run --cwd packages/senpi-codemode gate --target <base-checkout> \
  --baseline test/gate/baseline.json --write-baseline
```

Record with the canonical runtimes, so the baseline's runtime observations do not
flip between recordings: Bun 1.4.2, Python 3.14, Julia 1.12 and Ruby 4.x from
Homebrew (put `/opt/homebrew/opt/ruby/bin` first on `PATH`; macOS's system Ruby
2.6 records a different runtime). Check `ruby --version` and `python3 --version`
before `--write-baseline`.

The report is gitignored `gate-report.json` by default (`--report <path>` overrides it).
`test/gate/allowlist.json` contains reviewed additive changes keyed by plan node;
it cannot authorize removal or modification of a legacy entry. The test-only
`SENPI_CODEMODE_GATE_MUTATE=drop-phase` report mutation proves that helper removal
is rejected. `SENPI_CODEMODE_GATE_MUTATE=leak-kernel` leaves the real kernel
alive at the teardown witness, then closes it in `finally`; nonzero process,
worker, socket, handle, subscription and active-resource listener counts fail
by name. Constructors are observed because Bun's active-handle/report APIs
return empty arrays even for live workers.
Live timers are observed independently of the import census, including unref'd
global timers, named and namespace imports from `node:timers`,
`node:timers/promises` (including interval iterators and the scheduler), and
self-rearming `AbortSignal.timeout` polls. Failures name the timer API and its
creation site. The gate installs delegating wrappers before the kernel graph
loads; on Bun its module-replacement API also updates builtin ESM bindings.
These wrappers run only in gate processes and keep the native timer behavior.
The only production-source additions are an inert gate observer at the existing
worker, interpreter-process and bridge-server constructors. It is undefined in
normal execution. This hook is necessary because Bun does not refresh named
builtin exports when `syncBuiltinESMExports()` runs; patching their default
exports alone otherwise reports zero resources even for a leaked real kernel.

| Inert hook site | Measured resource | Verification |
| --- | --- | --- |
| `src/kernels/js/worker-host.ts` | Worker exit | Real Bun kernel close/leak tests |
| `src/kernels/py/process.ts` | Python child close | Five-runtime gate and kernel-leak mutation |
| `src/kernels/shared/subprocess-process.ts` | Ruby/Julia child close | Five-runtime gate and kernel-leak mutation |
| `src/bridge/http-server.ts` | Server close and accepted sockets | Real Bun bridge close/leak tests |

The gate-only `leak-bridge` mutation leaves the real bridge server open for the
witness and closes it in `finally`; the real-runtime test must observe an open
handle. Neither mutation is read by production code.

Legacy scenario identities are compared exactly, so deleting or renaming a
test cannot make the gate green. Platform-dependent skip outcomes remain
visible in the report. Driver tests await child close events, with a generous
hang watchdog; the infinite-loop timeout uses an injected clock after the
worker announces execution. No deadline tests are excluded from the gate.
The held-child probe advances the parent clock past all former startup
deadlines three times before releasing the child's IPC barrier.

```bash
cd packages/senpi-codemode
bun run test

cd ../..
bun run check
```

Direct real-surface QA drivers live in `scripts/qa-*.ts`: kernel cells
(`qa-py-cell.ts`, `qa-js-cell.ts`, `qa-rb-cell.ts`, `qa-jl-cell.ts`), end-to-end
extension execution (`qa-e2e-eval.ts`), and renderer output
(`qa-render-dump.ts`).

### Nested tool-call widgets

When an eval cell invokes `tool.<name>(...)`, the result panel can render a
nested widget for the invoked tool. The widget captures bounded args, duration,
and a sanitized 160 code points result preview; the rendering path is
always-on and does not depend on any toggle or session flag.

The capture budget is fixed at 30 enriched calls per cell, with a 4096-character
serialized args budget. Previews are capped at 160 code points, and collapsed
widgets stay within the 8 lines collapsed widget budget.

Entries without args — including old sessions, reserved/completion rows, and
calls past the cap — render as plain rows. Edit renders a fallback row by
design, even when its args are present.
