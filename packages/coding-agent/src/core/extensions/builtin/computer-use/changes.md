# computer-use builtin changes

## 2026-09-27 - Register computer_actions behind computer.cuaAdapter (senpi#2128)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/computer-use/index.ts`: with `computer.cuaAdapter: true`, session_start also registers `computer_actions` and its permission parser on the same handle.

### Why

- Opt-in second surface for OpenAI computer-use action prompting (plan todo 45).

### Why an extension could not handle it

- The builtin owns the computer session both tools share.

### Expected merge conflict zones

- None: fork-only builtin.

## 2026-09-25 - The `computer-use` builtin: registration, permission parser, activation, rpc stop/resume, engine diagnostics (senpi#2128)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/computer-use/index.ts` (new): `createComputerUseExtension({platform, engineChild})`. The default export uses `process.platform` and `engineChildFactory` from `@code-yeongyu/senpi-desktop-service`.
  - On `session_start`, it registers the `computer` tool from `@code-yeongyu/senpi-desktop-tool` when the host is supported and `computer.enabled` is true. The tool is `exposure: "search"`, so it starts inactive, and the engine does not start.
  - At the same point, it registers `computerPermissionParser` with the permission-system through `registerToolParser`. The permission-system `tool_call` hook remains the only place a tier is evaluated.
  - On `tool_activated` (see `core/extensions/changes.md`), it activates the handle: it opens the engine session and arms `computer.stopHotkey` through `ensureStopPath`. A by-name call, a tool_search promotion followed by a call, and `pi.setActiveTools` all arm the chord once. `/computer on` and `/computer off` go the other way, through `onActivationChange`, into the active tool set. Codemode then installs or removes the `computer` global in the next eval cell, based on the tool's `kernelPrelude`. Nothing is passed to codemode.
  - `/computer on|off|status|stop|resume` delegates to `runComputerCommand`. `status` appends `engine: <state>` and `prelude: active|inactive`. On a session without the tool, every subcommand prints `Computer use is unavailable in this session.`
  - Stop and resume need no TUI. Over rpc, a `prompt` whose message is `/computer stop` or `/computer resume` reaches the command through `AgentSession.prompt` -> `_tryExecuteExtensionCommand`. That is the non-TUI extension-command dispatch in `agent-session.ts` (the extension-command branch of `prompt()` and `_tryExecuteExtensionCommand`). No tool call can reach that path, and the tool's parameter union has no `resume` action.
  - `session_shutdown` closes the engine.
- `packages/coding-agent/src/core/extensions/builtin/computer-use/engine-status.ts` (new): `TrackedDesktopService` records whether `open` started the engine. It reports `native-unavailable` or `quarantined` from `DesktopEngineUnavailableError`, and `abi-mismatch` from the `-engine` handshake error's `code`. The error it rethrows is `ComputerEngineUnavailableError`, whose message names the diagnostic. Before the first activation, the state is `not started`: coding-agent may import only `-tool` and `-service`, so status cannot locate the binary without starting it.
- `packages/coding-agent/src/core/extensions/builtin/computer-use/settings.ts` (new): reads the `computer` block of the global and trusted project `settings.json`, with project keys over global ones. It resolves the block with `resolveComputerSettings`.

### Why

- senpi#2128 (GAP-7, IS-1, IS-8): the desktop packages supply the `computer` tool, its permission tiers, and the eval-kernel facade. A session needs one owner that registers them, arms the user's stop chord when the tool becomes active, and gives the user a stop and resume that work without a TUI.

### Why an extension could not handle it

- This is an extension. It ships as a builtin because the tool, its permission parser, and the stop surface must be present in every senpi session on a supported host.

### Expected merge conflict zones

- None in this directory: it does not exist upstream.
