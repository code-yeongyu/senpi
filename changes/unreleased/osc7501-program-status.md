<!-- changes-log: packages/tui/src/changes.md -->
## 2026-11-01 - OSC 7501 Program Status encoder (senpi#5321)

### What changed

- `packages/tui/src/index.ts` exports `encodeProgramStatus` and the `ProgramStatus`, `ProgramStatusState` and `ProgramStatusKind` types from the new fork-only `program-status.ts`. The encoder builds `OSC 7501 ; state=…[:kind=…][:app=…][:msg=<base64>] ST` per revision 0.4 of the proposal: `kind` only with `blocked`, an `app` outside the protocol charset or 32-character limit left out, the message stripped of C0/DEL/C1 controls and bidi or invisible formatting, truncated to 2048 bytes on a UTF-8 boundary, and `undefined` encoded as `state=clear`.

### Why

- Terminals such as herdr-core read a program's state only from OSC 7501, so omo panes there showed as a plain shell. The TUI package already owns the other terminal OSC writes (title, OSC 9;4 progress) and their sanitizing.

### Why an extension could not handle it

- The barrel is the only public import path of the TUI package; the encoder is pure and shared by the coding agent's interactive mode.

### Expected merge conflict zones

- LOW: one export block after `terminal-text.ts` in `packages/tui/src/index.ts`.

<!-- changes-log: packages/coding-agent/src/core/extensions/changes.md -->
## 2026-11-01 - `ctx.ui.setProgramStatus` reports OSC 7501 program status (senpi#5321)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionUIContext.setProgramStatus(status: ProgramStatus | undefined): void` next to `setTitle`, and `ProgramStatus` re-exported from the TUI package. `undefined` clears the status.
- `packages/coding-agent/src/core/extensions/runner.ts`: `noOpUIContext.setProgramStatus` is a no-op, so print, JSON and headless contexts report nothing.
- `packages/coding-agent/src/core/extensions/index.ts`: re-exports the `ProgramStatus` type.

### Why

- The builtin herdr reporter (and any extension) needs a way to tell the terminal whether the agent is idle, working or blocked on the user without writing to stdout, which the TUI takes over.

### Why an extension could not handle it

- Raw terminal writes belong to the host's TUI terminal; an extension has no handle on it and its stdout is redirected. The UI context contract is core.

### Expected merge conflict zones

- MEDIUM: `ExtensionUIContext` next to `setTitle` in `types.ts` when upstream adds UI methods.
- LOW: `noOpUIContext` in `runner.ts`; one type in the `index.ts` export list.

<!-- changes-log: packages/coding-agent/src/changes.md -->
## 2026-11-01 - Export `ProgramStatus` (senpi#5321)

### What changed

- `packages/coding-agent/src/index.ts`: re-exports the `ProgramStatus` type used by `ctx.ui.setProgramStatus`.

### Why

- Extensions type the status they pass to the new UI method from the public package.

### Why an extension could not handle it

- The package's public type surface is defined only here.

### Expected merge conflict zones

- LOW: one name in the extension type export list.

<!-- changes-log: packages/coding-agent/src/modes/interactive/changes.md -->
## 2026-11-01 - The TUI writes OSC 7501 program status (senpi#5321)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: the extension UI context implements `setProgramStatus` by writing `encodeProgramStatus(status, APP_COMMAND)` through `this.ui.terminal.write`, only when stdout is a TTY. An identical consecutive report, or a clear with no active status, writes nothing. `stop()` writes `state=clear` when a status is active and ignores later reports, so a quit never leaves a `working` or `blocked` record behind in the terminal.

### Why

- herdr-core and other OSC 7501 terminals learn the agent's state only from this sequence. The app name is the branded command, so OmO reports `omo` and standalone Senpi `senpi`.

### Why an extension could not handle it

- The extension UI context and the TUI terminal are owned by interactive mode; extensions cannot write around the stdout takeover.

### Expected merge conflict zones

- LOW: the `setTitle` neighbourhood of the extension UI context, `updateTerminalTitle`, the field list beside `extensionTerminalTitle`, the `@earendil-works/pi-tui` import list, and the progress clear at the top of `stop()`.

<!-- changes-log: packages/coding-agent/src/core/extensions/builtin/herdr/changes.md -->
## 2026-11-01 - Program status binds in every TUI session (senpi#5321)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/herdr/index.ts` binds state tracking to the first top-level TUI session whatever the `HERDR_*` environment and user-reporter deferral, and reports each `selectHerdrReport` result through `ctx.ui.setProgramStatus` (deduplicated). The herdr socket client keeps its preconditions (`HERDR_ENV=1`, socket path, pane id, no user reporter) and its exact request transcript. A blocked report carries `kind: "question"` when the first pending id was announced by `ask-user:asked`; host dialogs carry no kind, because their ids are random and nothing marks a permission prompt. Quit clears the status; reload and session navigation leave it for the successor runtime.

### Why

- herdr-core panes set only `HC_TERMINAL_ID`/`HC_TERMINAL_SOCKET`, so the reporter never bound there and omo panes showed as a plain shell. They read OSC 7501 instead.

### Why an extension could not handle it

- This is the builtin reporter; it uses the public `ctx.ui.setProgramStatus` API.

### Expected merge conflict zones

- LOW: `session_start` binding order and `publish` in `index.ts`.

<!-- changes-log: packages/coding-agent/CHANGELOG.md -->
### Added
- `ctx.ui.setProgramStatus` reports idle, working, blocked, done or error to terminals that implement the OSC 7501 Program Status Protocol, forwarded over RPC as a fire-and-forget `setProgramStatus` request. The builtin herdr reporter now publishes its state this way in every TUI session, so herdr-core panes show omo as working or blocked on a question ([#5321](https://github.com/code-yeongyu/senpi/issues/5321))

<!-- changes-log: packages/tui/CHANGELOG.md -->
### Added
- `encodeProgramStatus` builds a sanitized OSC 7501 Program Status report ([#5321](https://github.com/code-yeongyu/senpi/issues/5321))
