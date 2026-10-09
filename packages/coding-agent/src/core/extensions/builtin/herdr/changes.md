# Herdr builtin reporter changes

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
