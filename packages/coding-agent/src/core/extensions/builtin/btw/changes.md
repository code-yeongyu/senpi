# changes — btw

## Parallel side questions via `/btw` (2026-07-21)

### What changed

- New builtin extension `btw` registering `/btw <question>`: runs a read-only side
  LLM query against a snapshot of the current conversation, in parallel with any
  in-flight main turn, without writing anything back to session history.
- `side-query.ts`: builds the side context (session system prompt plus a
  side-question instruction, snapshot history, question as the final user
  message, `tools: []`) and streams it through `streamSimple` with an
  establishment timeout (default 30s), abort propagation, and text-delta
  callbacks. Provider `sessionId` is suffixed `:btw:<uuid>` so provider-side
  session affinity never collides with the main turn.
- `index.ts`: the command handler captures the context snapshot synchronously
  (entries + leaf at invocation time) before its first await, so a concurrent
  main turn or compaction cannot create a mixed-generation request. A new
  `/btw` aborts and replaces the previous one; `session_before_switch` aborts
  any active query.
- `panel.ts` (TUI only): renders the question and streaming answer in a widget
  above the editor. Escape always passes through to the main TUI untouched; as a
  side effect it also dismisses the panel and aborts the side query, so one
  Escape cancels in-flight side work without ever stealing the main interrupt.
  A settled panel auto-dismisses on the next submitted message.
  Non-TUI modes skip the widget and deliver the answer through `ctx.ui.notify`.
- `builtin/index.ts`: registers the extension after `goal` and before `mcp`.
- Coverage: `test/suite/btw-side-query.test.ts` proves no history pollution,
  parallel execution with an in-flight main turn, synchronous snapshot
  isolation, previous-query abort, provider error propagation, establishment
  timeout, and pre-aborted signals — all on the faux provider, zero tokens.

### Why

- Users need a way to ask questions about the ongoing session (or anything
  else) without derailing or polluting the main agent's context, and without
  waiting for the main turn to finish.

### Known limitations

- Escape is matched as the raw terminal key; the extension API exposes no
  keybinding lookup from command contexts, so a remapped `app.interrupt` key
  is not honored by the widget.
- The side query streams through `streamSimple` directly (same pattern as core
  compaction): auth resolution goes through the model runtime, but session
  `before_provider_request` hooks and retry policy do not apply to side calls.

### Merge-conflict zones

- `builtin/index.ts` import block + `builtinExtensions` array (single added
  line each; keep the `btw` entry ahead of `mcp`).