# Herdr builtin reporter changes

## 2026-11-07 - A pane idles after its turn while only a monitor or background session is live (senpi#6150)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/herdr/herdr-state.ts`: `selectHerdrReport` keeps `working` for a running turn and for bounded wake sources (subagents, DAG runs, detached eval cells, loop-guard recovery, unknown sources, and one-shot monitors with a deadline), and reports `idle` when only open-ended sources are live: monitors with no deadline (persistent watches, or watches without a timeout, counted by the new `openEndedMonitors` from the `terminal_monitor_state` per-watch `persistent`/`deadlineMs`) and background terminal sessions. The message names the live sources in both states. This partly reverses the 2026-09-24 entry in this tracker (senpi#2077), which folded every wake source into `working`: bounded sources keep that behaviour, open-ended ones no longer do.
- `packages/coding-agent/src/core/extensions/builtin/herdr/index.ts`: passes the open-ended watch count with each monitor snapshot.

### Why

- A persistent monitor or a background server kept the pane `working` forever after the turn ended, so front ends drawing the OSC 7501 state showed a spinner on an idle agent.

### Why an extension could not handle it

- The builtin herdr reporter is the extension that owns this report; the change is inside it.

### Expected merge conflict zones

- LOW: the `selectHerdrReport` body, the `monitors` reducer event and `OPEN_ENDED_WAKE_SOURCES`; the monitor subscription in `index.ts`.

## 2026-11-04 - Name the product command in an app pane token (omo#12395, senpi#5817)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/herdr/index.ts` adds `tokens: { app: APP_COMMAND }` to its title metadata report. On quit it clears the token with `tokens: { app: null }` before `pane.release_agent`. Every lifecycle, session and release report still sends `agent: "pi"`.

### Why

- Tools built on herdr's API could not tell an OmO pane from a Pi pane. herdr 0.9.5 bases prompt delivery and restore on agent labels it knows. With an `omo` label, `agent prompt` and `agent send-keys` are refused with `agent_not_ready`, and the reported `resume_argv` is dropped when detection says `pi`. Pane tokens are display-only, and herdr's pane and agent APIs expose them. herdr keeps tokens after release and process exit, so quit clears the token.

### Why an extension could not handle it

- This is the builtin reporter that owns the pane's herdr metadata.

### Expected merge conflict zones

- LOW: the `reportTitle` params and the `session_shutdown` quit branch in `index.ts`.

## 2026-11-01 - Program status binds in every TUI session (senpi#5323)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/herdr/index.ts` binds state tracking to the first top-level TUI session whatever the `HERDR_*` environment and user-reporter deferral, and reports each `selectHerdrReport` result through `ctx.ui.setProgramStatus` (deduplicated). The herdr socket client keeps its preconditions (`HERDR_ENV=1`, socket path, pane id, no user reporter) and its exact request transcript. A blocked report carries the `kind` of the oldest open block (`selectHerdrBlockedKind`), which `herdr:blocked` now carries: `question` from ask-user, `permission` from a host dialog about a tool call; other dialogs carry none. Quit clears the status; reload and session navigation leave it for the successor runtime.
- The reporter calls `ctx.ui.setProgramStatus` optionally, so an outside SDK host whose UI context predates the method keeps its herdr socket reporting (senpi#5344).
- `herdr-state.ts` keeps `{ label, kind }` per open block instead of the label alone; `isHerdrBlockedEvent` accepts the optional `kind`.
- `packages/coding-agent/src/core/extensions/builtin/ask-user/tool.ts` emits `kind: "question"` on its active `herdr:blocked` event.

### Why

- herdr-core panes set only `HC_TERMINAL_ID`/`HC_TERMINAL_SOCKET`, so the reporter never bound there and omo panes showed as a plain shell. They read OSC 7501 instead.

### Why an extension could not handle it

- This is the builtin reporter; it uses the public `ctx.ui.setProgramStatus` API.

### Expected merge conflict zones

- LOW: `session_start` binding order and `publish` in `index.ts`; the `blocked` case of `reduceHerdrState`.

## 2026-10-21 - Restore the branded launcher after Herdr restart (senpi#3849)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/herdr/index.ts` sends `resume_argv` with the existing `APP_COMMAND` brand command and the exact reported session path, falling back to the reported session ID when no path exists.
- `packages/coding-agent/src/core/extensions/builtin/herdr/index.ts` waits for the initial state report before sending the session report: Herdr rejects resume commands from reporters that do not yet hold the pane.

### Why

- Without an explicit command Herdr restores every `pi`-kind pane through the ambiguous `pi` executable. OmO already supplies its `omo` command in the brand profile; standalone Senpi resolves to `senpi`. The protocol agent remains `pi` so detection, lifecycle reporting, and managed integration compatibility stay intact.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/builtin/herdr/index.ts` is the builtin reporter that owns the session report.

### Expected merge conflict zones

- LOW: the `pane.report_agent_session` payload and one config import.

## 2026-09-24 - Every wake source keeps the pane working (senpi#2077)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/herdr/index.ts` subscribes to `wake_source_state` beside the terminal-monitor snapshot and folds each payload through the reducer.
- `packages/coding-agent/src/core/extensions/builtin/herdr/herdr-state.ts` carries a `wakeSources` map, a `wake-source` event, and labels for the known sources in `selectHerdrReport`; `terminal-monitors` and `senpi-task` are already represented (the child count is the max of polled records and the published count) and `ask-user` belongs to the blocked state.

### Why

- A pane whose turn ended with a DAG run, a background bash session, or a detached eval cell live reported `idle` because only monitors and polled child-task records counted; the session-wide activity contract (`wake_source_state`) already names all of them. The report stays event-driven, so the pane idles when the last source clears without another turn.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/builtin/herdr/index.ts` and `herdr-state.ts` ARE the reporter.

### Expected merge conflict zones

- LOW: one subscription in `session_start` and the `selectHerdrReport` body.

## 2026-09-14 - Wire the registered factory to the host context (senpi#1645)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/herdr/index.ts` exports the default factory, reads `ctx.loadedExtensionPaths` at session start, and reads at most 400 bytes from matching files with a finally-closed file descriptor. Injected dependencies remain available for deterministic protocol tests.

### Why

- `packages/coding-agent/src/core/extensions/builtin/herdr/index.ts` must defer to actually loaded user-authored reporters, including event-only extensions, without mistaking the managed integration for one or reading entire extension files.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/builtin/herdr/index.ts` is the extension implementation. Its required host discovery handoff is documented in `core/extensions/changes.md`; it does not inspect user settings or modify installed extensions.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/builtin/herdr/index.ts`: default factory dependencies and session-start deferral. The reducer and transport are unchanged.

## 2026-09-13 - Isolated lifecycle reporter foundation (senpi#1645)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/herdr/index.ts` exports
  `createHerdrExtension` with injected loaded-extension paths, header reads, clock,
  socket connection and optional debug logging. It binds to the first TUI session,
  reports session metadata and references, observes turns and terminal monitors,
  polls running/pending child task records every four seconds with an unref timer,
  and consumes request-id-keyed `herdr:blocked` events.
- `packages/coding-agent/src/core/extensions/builtin/herdr/herdr-state.ts` reduces
  immutable state with FIFO blocked labels and idempotent arrivals/settlements.
  Pending input wins over working turns, child tasks and live monitors.
- `packages/coding-agent/src/core/extensions/builtin/herdr/herdr-client.ts` sends
  `custom:senpi` NDJSON through a single drain queue, retries with 500/1500 ms
  bounds, validates acknowledgements, maps Windows pipe endpoints and keeps
  sequence numbers increasing across runtime replacements. Every shutdown drains
  and silences its old runtime; only quit releases the pane, as the final request.
- `packages/coding-agent/test/suite/herdr-reporter.test.ts` exercises synthetic
  extension events against a real local socket and injected transport failures.
- This increment deliberately does not register the builtin or add the host's
  loaded-path handoff. Those integration changes and real herdr-pane QA belong to
  the subsequent increment after the ask-user event emitters land.

### Why

- `packages/coding-agent/src/core/extensions/builtin/herdr/index.ts` makes one
  senpi-side reporter authoritative without competing with a loaded user-authored
  `herdr-*` reporter. Managed headers containing `HERDR_INTEGRATION_ID=` in the
  first 400 bytes do not trigger deferral; that coexistence contract still needs
  the subsequent real-pane integration verification.
- `packages/coding-agent/src/core/extensions/builtin/herdr/herdr-state.ts` keeps
  duplicate or out-of-order question settlements from clearing another question.
- `packages/coding-agent/src/core/extensions/builtin/herdr/herdr-client.ts` prevents
  racing socket writes or late reports from reclaiming an already released pane.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/builtin/herdr/index.ts`,
  `packages/coding-agent/src/core/extensions/builtin/herdr/herdr-state.ts` and
  `packages/coding-agent/src/core/extensions/builtin/herdr/herdr-client.ts` ARE the
  extension implementation. This increment adds no core API or host changes.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/core/extensions/builtin/herdr/index.ts`,
  `packages/coding-agent/src/core/extensions/builtin/herdr/herdr-state.ts` and
  `packages/coding-agent/src/core/extensions/builtin/herdr/herdr-client.ts` are new
  fork-only modules. Registration, shared trackers and the public context handoff
  are intentionally deferred; no existing production file is changed here.
