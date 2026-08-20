# changes — btw

## 2026-08-20 - Replace the BTW widget with a switchable side conversation

### What changed

- TUI `/btw` and `/side` now open one focused, side-only conversation overlay
  instead of a one-shot below-editor widget. The overlay contains branch-local
  side history, the current streamed answer, an editor for follow-ups, parent
  working/idle status, and configured key hints.
- Ctrl+/ hides the side and returns focus to the parent editor; Ctrl+/ from the
  parent restores the same overlay and draft. The configured `app.clear`
  binding (Ctrl+C by default) closes the side, while the configured
  `app.interrupt` binding (Escape by default) cancels only the current side
  answer.
- Legacy and Kitty keyboard protocols both recognize Ctrl+/. The 80-column
  footer prioritizes one configured switch, close, cancel, and scroll binding.
- Long questions wrap instead of truncating silently. Transcript paging clamps
  at both ends, while PageUp/PageDown remain available to a non-empty draft.
  Tall editors preserve their top scroll indicator, cursor end, and terminal
  height bound.
- The parent keeps running while a side answer streams. Parent session
  replacement, tree navigation, shutdown, and extension removal abort and
  close the side exactly once.
- Completed side exchanges continue to persist as `btw-history` custom
  entries. They remain excluded from the parent model conversation. RPC and
  print mode retain the prior one-shot answer and bare-history notification.
- An open side keeps the parent-context snapshot and model selected when it was
  opened, matching fork semantics. Close and reopen the side to branch from
  newer parent progress or a newly selected model.
- The old `BtwPanel` and read-only `BtwHistoryPanel` surfaces were removed.
  `BtwSideController` owns request/lifecycle state, while `BtwSidePanel` owns
  focused input and bounded rendering.

### Why

- The previous widget answered only one question and dismissed on the next
  parent input, so it did not match the switchable side-thread interaction
  users expect from Codex.
- A direct side-query stream already provides isolation without a second
  persisted session. Reusing it avoids server-session adoption, deletion,
  cache, and navigation races while still giving the TUI a multi-turn side
  surface.

### Verification anchors

- `btw-side-controller.test.ts`: open/submit ordering, hide/show, exact-once
  close, request-only interrupt, late completion rejection, and busy submit.
- `btw-side-panel.test.ts`: isolated rendering, focus/draft preservation,
  configured clear/interrupt keys, Ctrl+/, terminal bounds, and sanitization.
- `interactive-custom-overlay.test.ts`: a completing custom overlay closes its
  own handle instead of a newer topmost overlay.

### Merge-conflict zones

- `index.ts` command registration and lifecycle handlers.
- Interactive custom-overlay completion in
  `modes/interactive/interactive-mode.ts`.

## 2026-08-19 - Register /side as an alias of /btw

### What changed

- `/side` is registered as an exact alias of `/btw`. A single shared handler in `index.ts` backs both names, so the
  `<question>` form and the bare history-viewer form behave identically for both spellings and cannot drift. No
  behavior of the existing `/btw` command changed.
- User-facing notifications name the spelling that was actually invoked. The shared handler receives the invoked
  command name, so a failure raised by `/side` reads `/side failed: ...` rather than `/btw failed: ...`.
- The two context-budget errors thrown from `side-query.ts` are now command-neutral (`the side question does not fit
  ...`, `the side context is too large ...`). They are re-emitted by the handler under the invoked command name, so
  the previous hardcoded `/btw` text can no longer leak into a `/side` notification.

### Why

- Codex exposes the same capability under both `/side` and `/btw` as aliases of one another (pinned commit
  `fa595fbab8`; `codex-rs/tui/src/slash_command.rs` writes every dispatch and capability branch as
  `SlashCommand::Side | SlashCommand::Btw`). Users arriving from Codex reach for `/side`. A single shared
  registration is the lightest way to give senpi that parity.
- Codex's ephemeral child-thread fork, thread switching (`Ctrl+/`), close-and-destroy semantics, hidden boundary
  developer instruction, and side-mode slash-command allowlist are intentionally NOT ported. senpi keeps the
  one-shot query plus branch-local replay. `SIDE_QUERY_INSTRUCTION` is unchanged.

### Why an extension could not handle it

- This changes builtin command registration inside the builtin that already owns side-query dispatch, snapshot
  construction, provider streaming, and the history surface. An external extension cannot register a second name
  against that builtin's private handler without reimplementing all of it.

### Expected merge-conflict zones

- The shared `registerCommand` call site in `index.ts`.
- The three notification strings in `index.ts` that interpolate the invoked command name.
- The two context-budget error strings in `side-query.ts` `boundSideQueryMessages`.
- `test/suite/btw-side-query.test.ts` around the extension-command describe block.
- The `[Unreleased]` changelog entry.

## 2026-08-13 - Persist branch-local side-question history

### What changed

- Completed `/btw` questions and answers are stored as custom session entries, and bare `/btw` opens a keyboard-driven
  history viewer without calling the provider.
- Questions, streamed answers, errors, and persisted history are stripped of terminal escape and non-printing control
  sequences at every `/btw` display boundary, while stored content and follow-up context remain unchanged.
- The history overlay resolves selection, scrolling, and cancel input through the configured TUI keybindings while
  retaining the default Left/Right, Up/Down, and Escape behavior.
- In-flight side queries abort before session-tree navigation so a completed answer cannot persist onto the newly
  selected leaf.
- Continuity includes only the newest ten `/btw` entries from the active branch. The full main conversation snapshot,
  prior side answers, and current question still pass through the model-aware side-query context budget together.
- Side-query answers are instructed to use the same language as the current side question.

### Why

- Side questions need durable continuity and review without polluting the main model conversation or leaking entries from
  sibling branches.

### Why an extension could not handle it

- The builtin owns side-query dispatch, snapshot construction, provider streaming, and the focused TUI command surface.

### Expected merge-conflict zones

- `index.ts` command handling and side-query completion.
- `display-text.ts`, `panel.ts`, and `history-panel.ts` display sanitization, key handling, and non-TUI notification
  formatting in `index.ts`.
- `index.ts` session-navigation abort handlers.
- `side-query.ts` instruction and bounded message assembly.
- `history.ts`, `history-view-model.ts`, and `history-panel.ts` are feature-owned additions.

## 2026-08-13 - Preserve provider-header deletion markers

### What changed

- `/btw` passes model-registry `ProviderHeaders` directly into the runtime stream options, including `null`
  values that delete inherited provider headers.

### Why

- The upstream auth contract widened during this merge. Materializing headers early would make a side query
  retain a header that the active provider configuration explicitly removed.

### Why an extension could not handle it

- This is the builtin command's private registry-to-stream boundary; an external hook cannot restore a deletion
  marker after it has been dropped.

### Expected merge-conflict zones

- LOW: `index.ts` auth forwarding and `side-query.ts` `SideQueryAuth`.

## Model-aware side-query context budgeting (2026-08-12)

### What changed

- `/btw` now budgets the complete side-query prompt against the selected model's context window, including output
  reserve, the session system prompt, the side-query instruction, captured history, and the final question.
- Oversized captured snapshots run through the existing deterministic context reducer, orphaned tool-result repair, and
  oldest-first pruning before provider dispatch. Small snapshots remain unchanged.
- If mandatory prompt content cannot fit, `/btw` fails locally with an actionable `/compact` suggestion instead of
  sending a provider request that is guaranteed to be rejected.

### Why

- `/btw` previously bypassed the main-turn context pipeline and replayed the full captured session snapshot directly to
  the provider. Large sessions could therefore fail with `Your input exceeds the context window of this model` even
  while normal main turns continued successfully.

### Why an extension could not do this

- The failure is inside the builtin command's private snapshot-to-provider path. An external extension cannot intercept
  and structurally budget that ephemeral provider payload without replacing the builtin command.

### Expected merge-conflict zones

- `index.ts` around captured snapshot construction and side-query dispatch.
- `side-query.ts` around context assembly and model runtime options.
- `test/suite/btw-side-query.test.ts` around the builtin command and context-builder regression coverage.

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
