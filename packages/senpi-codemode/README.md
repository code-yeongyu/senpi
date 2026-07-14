# @code-yeongyu/senpi-codemode

`@code-yeongyu/senpi-codemode` is Senpi's source-only persistent-kernel
`eval` extension. It registers `eval`, owns one persistent kernel per enabled
language, and re-registers the tool at session start after configuration,
interpreter availability, and active task-tool names are known.

## Capabilities

- Persistent JavaScript, Python, Ruby, and Julia cells. State survives later
  cells in the same language until reset, restart, or session disposal.
- Loopback, bearer-authenticated kernel bridge with bounded JSONL frames.
- Structured status events for file operations, environment access, phases,
  bridge activity, and delegated task progress.
- Bounded streaming output with head/tail previews, column clamping, and
  session-adjacent spill files for large streams.
- TUI and HTML-export rendering for syntax-highlighted cells, status rows,
  task progress, structured display values, truncation warnings, and image
  fallbacks.
- JavaScript import rewriting for supported local modules and package imports
  in the persistent Node.js worker.

## Kernels

| Language | Default | Runtime | Notes |
| --- | --- | --- | --- |
| `js` | enabled | Node.js worker | Requires Node.js 24 or newer; supports top-level `await` and `return`. |
| `py` | enabled | `python3` or `python` | Optional interpreter detected at session start. |
| `rb` | disabled | `ruby` | Optional interpreter detected at session start. |
| `jl` | disabled | `julia` | Optional interpreter detected at session start. |

A missing optional interpreter removes that language from the session's `eval`
schema; it is not an installation failure.

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
| `cellTimeoutSeconds` | `30` | Idle timeout for one cell unless the call supplies `timeout`. |
| `parallelPoolWidth` | `4` | Maximum concurrent `parallel()` thunks. |
| `taskTools.task` | `"task"` | Registered tool name used by `agent()`. |
| `taskTools.output` | `"task_output"` | Registered tool name used by `output()`. |
| `outputSink.headBytes` | `20480` | Bytes retained from the beginning of a middle-truncated preview; `0` disables it. |
| `outputSink.maxColumns` | `768` | Maximum rendered output columns; `0` disables column clamping. |
| `statusEvents` | `true` | Enables kernel status-event forwarding and rendering. |

`SENPI_CODEMODE_PY`, `SENPI_CODEMODE_JS`, `SENPI_CODEMODE_RB`, and
`SENPI_CODEMODE_JL` override the corresponding file setting. `1` or `true`
enables; `0` or `false` disables. Any other value leaves the file setting in
effect.

Malformed JSON or invalid settings fall back to defaults with a warning.

## Cell helpers

Python, JavaScript, Ruby, and Julia expose the same conceptual helpers. Python,
Ruby, and Julia use trailing keyword options; JavaScript uses one trailing
options object and asynchronous helpers are `await`-able.

| Helper | Contract |
| --- | --- |
| `display(value)` | Emits text, structured JSON, markdown, or supported image display data. |
| `print(value, ...)` | Emits text output. |
| `read(path, offset?, limit?)` | Reads text with 1-indexed line slicing. `local://` paths resolve under the session artifact root. |
| `write(path, content)` | Creates parent directories and writes text. `local://` paths persist in the session artifact root. |
| `env(key?, value?)` | Reads all kernel environment values, one value, or sets one value. |
| `tool.<name>(args)` | Invokes an active Senpi tool through the normal `pi.executeTool` pipeline. |
| `completion(prompt, model?, system?, schema?)` | Requests a one-shot host completion; `schema` asks the host to parse structured output. |
| `agent(prompt, ...)` | Delegates to the configured active `taskTools.task` tool. Supports background handles and structured JSON results. |
| `output(ids, format?, offset?, limit?)` | Delegates transcript retrieval to the configured active `taskTools.output` tool. |
| `parallel(thunks)` | Runs thunks through the configured bounded pool while preserving input order. |
| `pipeline(items, ...stages)` | Applies stages left to right with a barrier between stages. |
| `log(message)` / `phase(title)` | Emits progress text and starts a status phase. |

`agent()` is available only when the configured task tool is active in the
session. `output()` similarly requires the configured task-output tool. Missing
tools produce a clear availability error instead of importing an orchestration
package. `agent()` delegates through the tool contract, so task-engine
permissions, progress updates, and transcripts remain owned by that engine.
`isolated`, `apply`, and `merge` are accepted for compatibility but emit a
warning because this task-engine integration has no isolation model.

## Output and artifacts

Cell output is streamed while the cell runs. Large streams spill to an absolute
file after the default 50 KiB threshold. With a session file such as
`/path/session.jsonl`, artifacts live in `/path/session-artifacts/`; sessions
without a file use a unique temporary directory. Truncated results include a
plain-path notice such as `[Full output: /absolute/path/eval-….log]`.

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

## Validation

```bash
cd packages/senpi-codemode
npm test

cd ../..
npm run check
```

Direct real-surface QA drivers live in `scripts/qa-*.ts`: kernel cells
(`qa-py-cell.ts`, `qa-js-cell.ts`, `qa-rb-cell.ts`, `qa-jl-cell.ts`), end-to-end
extension execution (`qa-e2e-eval.ts`), and renderer output
(`qa-render-dump.ts`).
