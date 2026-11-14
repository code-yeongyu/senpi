<!-- changes-log: packages/coding-agent/src/core/changes.md -->
## 2026-11-14 - An interrupt can stop the background jobs of the turn it interrupted

### What changed

- `packages/coding-agent/src/core/run-background-jobs.ts` (new): `RunBackgroundJobs`, the background jobs each turn started, keyed by the turn id (`turn_epoch`) running when the job became background. `stop(turnId)` stops that turn's jobs in start order and answers `{ stopped, failed }`, a failure carrying the job's own rejection reason.
- `packages/coding-agent/src/core/agent-session.ts`: `registerRunBackgroundJob(job)` records a job under `currentTurnId` (nothing outside a turn) and `stopRunBackgroundJobs(turnId)` stops them; the context action `registerRunBackgroundJob` is bound to it.

### Why

- An RPC `interrupt` stopped the turn, but a bash command that turn had auto-detached kept running, and its exit notice woke the session about a minute later, which then replied as if never interrupted (measured on a remote thread through omo's `thread_interrupt`). Background sessions belonged to the session, never to the turn that started them, so nothing could tell which ones to stop.

### Why an extension could not handle it

- The turn id and the moment a turn ends are `AgentSession` state; the RPC `interrupt` that has to stop the jobs runs in the host, not in an extension.

### Expected merge conflict zones

- LOW: the `currentTurnId` neighbourhood and the `releaseRunFence` context action in `agent-session.ts`.

<!-- changes-log: packages/coding-agent/src/core/extensions/changes.md -->
## 2026-11-14 - `ctx.registerRunBackgroundJob`

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionContext.registerRunBackgroundJob?(job)` and the matching `ExtensionContextActions` member; `RunBackgroundJob` is `{ kind: "bash", id, description?, stop(turnId) }`.
- `packages/coding-agent/src/core/extensions/runner.ts`: binds the action and exposes it on every runner-built context behind `assertActive`; an unbound runner answers a no-op release.

### Why

- An RPC `interrupt { background: "stop" }` must reach the jobs an extension started for that turn (the terminal builtin's background sessions).

### Why an extension could not handle it

- The job has to be recorded against the session's running turn, which only the host knows.

### Expected merge conflict zones

- LOW: next to `releaseRunFence` in `ExtensionContext`, `ExtensionContextActions` and the runner's context builder.

<!-- changes-log: packages/coding-agent/src/core/extensions/builtin/terminal/changes.md -->
## 2026-11-14 - Background sessions belong to the turn that started them

### What changed

- `packages/coding-agent/src/core/extensions/builtin/terminal/extension-state.ts`: every background session (`run_in_background` or auto-detached) is recorded with `ctx.registerRunBackgroundJob` as a `bash` job whose stop is the bundle's.
- `packages/coding-agent/src/core/extensions/builtin/terminal/session-bundle.ts`: `stopForInterrupt(id, turnId)` tree-kills the session through `manager.stop` and fails typed when it lives on the tool child or is still running after the stop; `trackRunJob` holds the release, dropped at the session's exit or the bundle's teardown; the exit of a session an interrupt stopped carries `stoppedByInterrupt`.
- `packages/coding-agent/src/core/extensions/builtin/terminal/tools/context.ts`: `TerminalExitView.stoppedByInterrupt?: { turnId }`.
- `packages/coding-agent/src/core/extensions/builtin/terminal/notify.ts`: such an exit's notice reads `was stopped when turn <id> was interrupted` and is sent `nextTurn` with no `triggerTurn`, so it reaches the next turn and starts none; the notifier's `sendMessage` dependency accepts `deliverAs: "nextTurn"`.

### Why

- Stopping the interrupted turn's background bash must not itself wake the session: its exit notice is what woke it before.

### Why an extension could not handle it

- This is the terminal builtin; the change is inside it.

### Expected merge conflict zones

- LOW: `onBackgroundStart` in `extension-state.ts`, `notifyBackgroundExit` and `teardown` in `session-bundle.ts`, `buildNotice`/`deliverCompletion` in `notify.ts`.

<!-- changes-log: packages/coding-agent/src/modes/rpc/changes.md -->
## 2026-11-14 - `interrupt { background: "stop" }`

### What changed

- `packages/coding-agent/src/modes/rpc/method-classes-schema-session.ts`, `rpc-session-command-types.ts`, `pause-command-validation.ts`: `interrupt` takes `background?: "stop"`; any other value is refused.
- `packages/coding-agent/src/modes/rpc/session-control-actions-data.ts`: `interruptRunningTurn` takes the field; once the turn stopped it calls `session.stopRunBackgroundJobs(turnId)` and answers `background: { stopped, failed }`, both lists empty for an idle session or another turn's id. `InterruptOutcome` carries it.
- `packages/coding-agent/src/modes/rpc/connection-handler.ts`: both `interrupt` branches (plain and `intent: "stop"`) pass the field.
- `packages/coding-agent/src/modes/rpc/rpc-mutation-response-types.ts`: the `interrupt` response data is `InterruptOutcome`.

### Why

- A client that interrupts a remote thread needs the work that turn left running stopped too, and to be told what was stopped.

### Why an extension could not handle it

- `interrupt` is an RPC host command.

### Expected merge conflict zones

- LOW: the `interrupt` case in `connection-handler.ts` and `interruptRunningTurn`.

<!-- changes-log: packages/coding-agent/src/modes/interactive/changes.md -->
## 2026-11-14 - The terminal control endpoint's `interrupt` takes `background: "stop"`

### What changed

- `packages/coding-agent/src/modes/interactive/session-control-session-commands.ts`: the control endpoint's `interrupt` passes `background` to the shared `interruptRunningTurn`, so a terminal session answers the same shape as a host session. Esc in the TUI is unchanged: it is a user Stop, which holds automatic wakes, and it leaves background sessions running.

### Why

- One interrupt contract for every endpoint `thread_interrupt` reaches.

### Why an extension could not handle it

- The control endpoint is interactive-mode code.

### Expected merge conflict zones

- LOW: the `interrupt` case of `runSessionControlCommand`.

<!-- changes-log: packages/coding-agent/CHANGELOG.md -->
### Added
- RPC `interrupt` takes `background: "stop"`: the background bash sessions the interrupted turn started are stopped after it, named in the answer as `background: { stopped, failed }`, and their exit no longer wakes the session.
