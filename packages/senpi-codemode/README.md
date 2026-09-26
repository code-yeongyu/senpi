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

Every `eval` run must explicitly select an enabled `language` (`js`, `py`, `rb`,
or `jl`); there is no default kernel, even when only one language is enabled.
Omitting `action` means `run`, so it also requires `language`. Control requests
with `action: "peek"` or `action: "stop"` use `cell_id` and do not require a
language.

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

`PI_GOAL_STORE_FILE` is supplied by the host's optional `ExtensionContext.goalStoreFile`
getter and may name a file that does not exist yet. It honors session-directory overrides
and in-memory sessions; it cannot be derived reliably from `PI_SESSION_FILE`. If the host
omits the getter, the variable is unset rather than inherited from the launching process.

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
  "statusEvents": true
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
| `outputSink.maxColumns` | `768` | Maximum rendered output columns; `0` disables column clamping. |
| `statusEvents` | `true` | Enables kernel status-event forwarding and rendering. Each cell retains at most 100 status rows; after overflow, one omitted-count row precedes the latest 99 events. |

`SENPI_CODEMODE_PY`, `SENPI_CODEMODE_JS`, `SENPI_CODEMODE_RB`, and
`SENPI_CODEMODE_JL` override the corresponding file setting. `1` or `true`
enables; `0` or `false` disables. Any other value leaves the file setting in
effect.

Malformed JSON or invalid settings fall back to defaults with a warning.
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
collapsed block shows its first three lines. The schema marks all three
optional only because the control actions (`peek`, `stop`, `list`) share it; a
run request missing any of them fails with a teaching error that names what to
add.

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
directory. Truncated results include a plain-path notice such as
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
