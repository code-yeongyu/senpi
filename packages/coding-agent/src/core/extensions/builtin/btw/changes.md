## 2026-09-23 - /btw authenticates as the session's account

### What changed

- `index.ts` passes `sessionId: <this session>` to `getApiKeyAndHeaders`, so the key it sends belongs to the account the session's own turns use instead of the flat credential.

### Why

See "Auxiliary requests authenticate as the session's account" in `src/core/changes.md`.

### Why an extension could not handle it

This is the builtin's own auth call.

### Expected merge conflict zones

- LOW: the single `getApiKeyAndHeaders` call.

# changes — btw

## 2026-09-13 - Explicit off switch: bare /btw and kitty-safe Escape

### What changed

- `packages/coding-agent/src/core/extensions/builtin/btw/index.ts`: bare `/btw` (no question) dismisses the active panel and aborts an in-flight side query instead of only printing usage; the usage hint remains when nothing is active. The panel's Escape listener matches through pi-tui `matchesKey(data, "escape")` instead of comparing against the raw `\x1b` byte.
- `packages/coding-agent/src/core/extensions/builtin/btw/panel.ts`: the streaming and settled footers name `/btw` and Esc as the way to close the panel.

### Why

- Users had no discoverable way to turn the panel off: the settled footer only said it clears on the next message, and Escape also interrupts a streaming main turn. Under the kitty keyboard protocol (Ghostty, kitty, WezTerm) Escape arrives as `CSI 27 u`, so the raw byte comparison never matched and Escape silently did nothing.

### Why an extension could not handle it

- Both are internal to the builtin command and its widget; an external extension cannot reach the panel's input listener or the command's empty-argument branch.

### Expected merge conflict zones

- LOW: `index.ts` command handler head and the `onTerminalInput` callback; `panel.ts` `repaint()` footer strings.

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
