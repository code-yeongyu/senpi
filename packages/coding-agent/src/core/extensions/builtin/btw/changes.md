# changes — btw

## Session-scoped `/btw` history, review viewer, language matching, continuity (2026-08-07)

### What changed

- `history.ts` (new): `/btw` question/answer pairs are persisted per session as
  `pi.appendEntry("btw-history", { question, answer, timestamp })` custom
  entries. `readBtwHistory()` reads them back oldest-first and skips malformed
  payloads; `buildBtwHistoryMessages()` renders the newest
  `BTW_HISTORY_CONTEXT_LIMIT` (10) pairs as labeled user messages.
- `index.ts`: a settled side query now appends one history entry. Errored and
  aborted queries write nothing.
- `index.ts`: bare `/btw` (no argument) no longer prints a usage warning. It
  opens a history viewer of the current session's side questions. With no
  history it notifies instead; outside the TUI it notifies a plain-text list.
  It never calls the provider and never disturbs an in-flight side query.
- `history-view-model.ts` (new): pure selection/scroll state machine. LEFT and
  RIGHT move between entries (no wrap, scroll resets), UP and DOWN scroll the
  selected answer, all clamped.
- `history-panel.ts` (new): the `Component` shown through `ctx.ui.custom()`,
  which grants it keyboard focus. Renders the question list with the active row
  in `accent` and the rest `muted`, then the selected answer, then a key hint
  footer. `computeBtwHistoryLayout()` derives the row budget from the shared
  `BTW_HISTORY_OVERLAY_OPTIONS` so the footer can never be clipped by the
  overlay's `maxHeight`. All widths go through `visibleWidth` /
  `truncateToWidth` / `wrapTextWithAnsi` so CJK questions and answers align.
- `side-query.ts`: `SIDE_QUERY_INSTRUCTION` gained one sentence asking the model
  to reply in the same language as the side question, and
  `SideQueryContextInput` gained an optional `priorBtw` spliced between the
  session history and the final question.
- Coverage: `btw-history.test.ts`, `btw-history-view-model.test.ts`,
  `btw-history-layout.test.ts`, plus new cases in `btw-side-query.test.ts` for
  persistence, no-write on error and abort, bare `/btw`, and the last-10
  continuity window. The pre-existing empty-argument test was rewritten, since
  bare `/btw` is now a feature rather than a usage error; it still asserts that
  no provider call happens.

### Why

- A side question is most useful when it can be re-read. Previously a `/btw`
  answer vanished on the next message with no way to recall it.
- A follow-up side question had no memory of the previous one, so users had to
  restate context they had already given.
- Korean and other non-English side questions frequently came back in English,
  because nothing in the side instruction pinned the reply language.

Custom entries were chosen for storage because they are session-scoped, survive
a restart, and are explicitly excluded from LLM context
(`session-manager.ts`: "Does NOT participate in LLM context"), so the `/btw`
isolation guarantee holds by construction rather than by convention.

### Known limitations

- Escape is still matched as the raw terminal key. While the history viewer is
  open over an in-flight side query, one Escape both closes the viewer and
  cancels that side query, consistent with the pre-existing pass-through
  behavior documented below.
- Prior `/btw` answers are re-injected into later side queries as text. A side
  answer is model output rather than trusted input, so the usual prompt
  injection caveat applies within the isolated side context.
- History is per session by design. It is not shared across sessions or forks.

### Merge-conflict zones

- `index.ts`: the command handler's early-return block and the side-query
  context construction.
- `side-query.ts`: the `SIDE_QUERY_INSTRUCTION` array and
  `buildSideQueryContext`'s `messages` composition.

## Runtime provider dispatch for side queries (2026-07-30)

### What changed

- `/btw` now passes a stream function backed by `ctx.modelRegistry.modelRuntime`
  into the side-query runner instead of allowing it to fall back to the compat
  API registry.
- Added issue #488 regression coverage with a provider whose API id exists only
  in Senpi's runtime registry.

### Why

- Providers registered through `pi.registerProvider()` work in the main loop but
  may not exist in compat's built-in API registry. `/btw` therefore failed before
  invoking their registered stream implementation.

### Merge-conflict zones

- `index.ts` side-query dependency construction only.

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
