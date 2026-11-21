# cmd-cli extension changes

## 2026-11-02 - Add Command Code CLI builtin provider extension

### What changed

- Added `packages/coding-agent/src/core/extensions/builtin/cmd-cli/`:
  - `executable.ts`: resolves `cmd` binary location from environment (`SENPI_CMD_CLI_EXECUTABLE`, `CMD_EXECUTABLE`), settings (`executablePath`), or PATH; throws typed `CmdCliNotInstalledError` (`kind = "binary_missing"`).
  - `models.ts`: defines `STATIC_CMD_CLI_MODELS` and provides `resolveCmdCliModels` to probe `cmd --list-models` with ANSI stripping, comment filtering, bullet point stripping, and deduplication.
  - `spawn-args.ts`: serializes command-line arguments for invoking `cmd` with `-p` (prompt on stdin), `--output-format json`, and optional model, effort, max-turns, and permission mode flags.
  - `stream-parser.ts`: incremental NDJSON line parser for Command Code CLI stdout, handling text delta and result events with validation and malformed line diagnostics.
  - `stream.ts`: flattens the system prompt, earlier turns, tool calls and tool results plus the request into one prompt (`flattenContextPrompt`) written to stdin, spawns detached `cmd` process in its own process group (`detached: true`, `killProcessGroup`), maps `text_delta` events to senpi text streaming (`text_start`, `text_delta`, `text_end`), maps `result` line usage to senpi usage counters (`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `cost`), surfaces non-zero exit and non-success result errors as typed errors (`CmdCliProcessExitError` with `kind = "process_exit"`, `exitCode`, `stderr`; `CmdCliResultError` with `kind = "result_error"`, `subtype`), fails a run with no result line, and handles abort escalation from `SIGTERM` to `SIGKILL` on timeout or as soon as the group leader closes.
  - `index.ts`: registers `cmd-cli` provider with display name `"Command Code CLI"`, guarded by disabled-by-default check (`cmdCliProvider.enabled: true`), hooking up model discovery and streaming.
- Registered in `packages/coding-agent/src/core/extensions/builtin/index.ts` in `builtinExtensions`.
- Registered display name in `packages/coding-agent/src/core/provider-display-names.ts`.
- Added comprehensive unit and integration tests in `packages/coding-agent/test/cmd-cli/`.

Note: cmd executes its own tools; senpi does not execute them. Do not pretend otherwise in code or comments.

### Why

- Enables integration with Command Code CLI (`cmd`), allowing users to run turns through their local Command Code CLI setup.
- Enforces disabled-by-default behavior to ensure ambient host tools are never invoked without explicit opt-in.

### Why an extension could not handle it

- Builtin provider registration and standard CLI integration require builtin extension indexing and core provider display name registration.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/builtin/index.ts`: import line and `builtinExtensions` array.
- `packages/coding-agent/src/core/provider-display-names.ts`: `BUILT_IN_PROVIDER_DISPLAY_NAMES` record entry.
