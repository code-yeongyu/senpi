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

## 2026-11-24 - PR review fixes: system prompt, cmd.exe candidate, stream error contract

### What changed

- `cmd-cli/index.ts`: `streamSimple` now wraps the provider transcript with `toBuiltinProviderContext` (the same adapter the anthropic-subscription and cursor-cli-oauth lanes use) so the leading system message — AGENTS.md instructions and permission framing — is replayed into `systemPrompt` and reaches the flattened cmd prompt instead of being dropped.
- `cmd-cli/executable.ts`: PATH resolution no longer probes `cmd.exe`. A `cmd.exe` in a PATH directory is the Windows shell far more often than Command Code; spawning it with `-p --output-format json` would pipe the conversation (including untrusted tool-result content) to the shell. Windows users point `cmdCliProvider.executablePath` or an env override at the real binary.
- `cmd-cli/stream.ts`: every failure path (pre-abort, executable/spawn errors, child error, abort close, non-success result subtype, non-zero exit, missing result line) now terminates with an `error` stream event carrying an AssistantMessage with `stopReason` `"error"`/`"aborted"` and `errorMessage`, per the StreamFunction contract; `stream.fail()` is gone.
- `cmd-cli/stream.ts`: `normalizeStopReason` maps `tool_use`/`toolUse` to `"stop"` (cmd executes its own tools, so a tool_use result is a completed turn, never a host tool-call handoff); `rawStopReason` still preserves the provider-native value.
- `test/cmd-cli/stream.test.ts`: short `/tmp` mkdtemp for the Unix-socket test (a long TMPDIR pushed `server.listen` past the ~107-byte socket-path limit), a `server.on("error")` handler that rejects, and all failure-path assertions rewritten to the error-event contract plus a new tool_use→stop regression.
- `test/cmd-cli/provider.test.ts`: new regression — the transcript's leading system message reaches the spawned cmd's stdin (fails pre-fix).
- `test/cmd-cli/executable.test.ts`: new contract test — a PATH whose only match is `cmd.exe` must not resolve.

### Why

- Maintainer review of PR #5543 (HIGH: dropped system prompt; HIGH: Windows-shell hijack via cmd.exe; plus the StreamFunction error contract, the tool_use stop mapping, and the hanging socket test).

### Why an extension could not handle it

- The fixes live inside the cmd-cli builtin itself; no public extension API changes.

### Expected merge conflict zones

- LOW: all files are new in this PR; only this PR touches them.
