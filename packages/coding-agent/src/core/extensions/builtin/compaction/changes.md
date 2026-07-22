# Builtin compaction extension changes

## OpenAI remote compaction gated on provider capability, not history provenance (2026-07-22)

- `openai-remote-convert.ts` (new, extracted from `openai-remote.ts`): the remote-compaction route no longer
  requires the entire session branch to be OpenAI Responses-native. The route gate is now provider capability
  only (current model is `provider "openai"` + `api "openai-responses"`, matching codex's
  `supports_remote_compaction()`), and branch conversion is total: entries flow through the same
  `sessionEntryToContextMessages` + `convertToLlm` pipeline the normal context path uses, so foreign-provider
  assistant messages, bash executions, branch summaries, custom messages, and prior LOCAL compaction entries
  degrade to their canonical text form instead of forcing a local-summarization fallback. Prior OpenAI remote
  compaction entries still splice their native `replacementInput` in order.
- Image-bearing tool results now mirror the Responses payload builder: structured `input_text`/`input_image`
  parts for image-capable models, `(see attached image)` placeholder otherwise.
- `rewriteOpenAiPayloadWithRemoteCompaction` no longer silently skips the rewrite when post-compaction history
  is not OpenAI-native (previously the session then sent the full uncompacted context on the next turn).
- The `session-not-openai-native` fallback reason is gone; request building can only decline on an empty input
  (`empty-compaction-input`).
- Tests: `test/compaction/openai-remote-compaction.test.ts` — degradation cases for mixed providers, bash
  executions, local compaction entries, branch/custom entries, image tool results, a mixed-history remote run
  through `runOpenAiRemoteCompaction`, and the post-compaction payload rewrite with a non-native tail.

Expected upstream conflict zones: `builtin/compaction/openai-remote.ts` request building and payload rewrite;
`builtin/compaction/openai-remote-convert.ts` (new file, no upstream counterpart).

## Skip placeholder synthesis for errored/aborted assistants (2026-07-22)

- `repair-tool-pairs.ts` no longer synthesizes placeholder tool results for toolCalls declared by
  assistant messages with `stopReason "error" | "aborted"`. `transformMessages`
  (`packages/ai/src/api/transform-messages.ts`) drops those assistants from every provider request, so a
  synthesized placeholder became a `role:"tool"` message whose `tool_call_id` no assistant declared —
  strict providers (apitopia/kimi openai-completions) answered `400 tool_call_id ... is not found` and the
  session's compaction was permanently rejected. The primary fix lives in `transformMessages` (results of
  dropped assistants are no longer emitted); this guard is defense in depth. The sibling copy
  `packages/ai/src/utils/tool-pair-repair.ts` received the identical change; the files remain verbatim
  copies, so the "duplicated verbatim" comments still hold.
- Tests: `test/compaction/tool-pair-repair.test.ts` asserts no synthesis for errored/aborted assistants.

Expected upstream conflict zones: `builtin/compaction/repair-tool-pairs.ts` dangling-call synthesis loop
and the shared `packages/ai/src/utils/tool-pair-repair.ts` copy.

## Omit non-"fc" item ids in remote-compaction tool-call replay (2026-07-22)

- `openai-remote.ts` `convertToolCall()` now spreads the replayed item `id` only when it
  begins with "fc", matching the Responses API item-id rule. A custom tool call stored as
  `<call_id>|custom` previously produced `id: "custom"` in remote-compaction input, which
  the API rejects with `Invalid 'input[N].id': 'custom'`.
- Tests: `test/compaction/openai-remote-compaction.test.ts` (sentinel omission in the
  remote request input) and `test/compaction/custom-tool-call-id-replay.test.ts`
  (wire-level: drives `runExtensionCompaction` against a local Responses server that
  enforces the id rule, proving the poisoned history compacts successfully).

Expected upstream conflict zones: `builtin/compaction/openai-remote.ts` `convertToolCall()`.

## Diagnosable summary-generation failures + thinking headroom (2026-07-21)

- `speculative.ts` `runExtensionCompaction()` no longer collapses every non-summary
  outcome into a silent `undefined` (which the handler could only report as
  "compaction generator returned no summary"). It now resolves `undefined` **only
  for aborts** and throws a typed `SummaryGenerationError` otherwise:
  - missing/unresolvable credentials → `kind: "auth"`,
    `summarization credentials unavailable: <registry error>`.
  - a completed response with zero text blocks (adaptive-thinking models can burn
    the whole output budget on thinking; tool-forwarding means a model can also
    answer with a bare tool call) → `kind: "empty-summary"`,
    `summarization response contained no text (stopReason: <reason>)`.
- `index.ts` `session_before_compact` handler maps outcomes precisely:
  - `SummaryGenerationError` → `{ cancel: true, reason: error.message }` so
    `/compact` shows the real diagnosis via `compaction_end.errorMessage`.
  - aborted generation with `event.signal.aborted` → `{ cancel: true }` with **no
    reason**, letting agent-session's aborted branch render the plain
    "Compaction cancelled" instead of the misleading "returned no summary"
    (core hardcodes `aborted: true` for extension cancels and suppresses
    `errorMessage` only when no extension reason is present).
  - any other `undefined` keeps the legacy "compaction generator returned no
    summary" reason as a defensive fallback.
- `index.ts` `applyBlockingCompaction()` catches `SummaryGenerationError` and
  degrades to the legacy "unavailable" outcome, so automatic routes
  (hard-limit/proactive/turn-end recovery/degradation monitor) behave exactly as
  before instead of erroring the turn; the precise reason still surfaces when the
  hook route runs.
- Summarization output budget: the flat `MAX_SUMMARY_TOKENS = 8192` became
  `summaryMaxTokens(model, contextWindow)` =
  `min(32768, model.maxTokens, floor(contextWindow / 2))` (the headroom cap
  applies when the model reports no output cap). Adaptive-thinking models emit
  reasoning tokens before the summary text, so the 8192 cap could be consumed
  entirely by thinking and end the stream with zero text — the exact "returned
  no summary" failure this change diagnoses. The half-window clamp reserves
  half the window for input so providers enforcing input + output <=
  contextWindow no longer reject requests up-front (catalog models with
  contextWindow == maxTokens); oversized conversations still flow through the
  existing overflow-retry prune. Models with `maxTokens < 8192` also stop
  receiving an over-cap request.
- Abort precedence: `runExtensionCompaction()` checks the caller signal before
  and after credential resolution, so a user abort can never surface as a
  "summarization credentials unavailable" rejection.
- Tests: `test/compaction/speculative-compaction.test.ts` (typed errors, token
  caps) and `test/compaction/before-compact-error-surfacing.test.ts` (handler
  reason mapping, abort-without-reason).

Expected upstream conflict zones: `builtin/compaction/speculative.ts` around the
auth check, `getSummaryText` consumption, and stream options;
`builtin/compaction/index.ts` `session_before_compact` cancel paths and
`applyBlockingCompaction`.

## Idle watchdog on local summarization streams (2026-07-21)

- `speculative.ts` `generateSummaryMessage` now drives the summarization stream through a
  request-local `AbortController` (linked to the caller's signal) and
  `consumeStreamWithIdleTimeout()` (`core/compaction/stream-watchdog.ts`,
  `DEFAULT_SUMMARIZATION_IDLE_TIMEOUT_MS` = 300s, matching the agent stream idle-timeout default).
  A provider connection that goes silent mid-summary — previously an unbounded "Compacting…"
  stall recoverable only by ESC — now tears the request down and throws `StreamIdleTimeoutError`,
  which the existing failure paths surface as `compaction generator failed: Summarization stream
  stalled …` (manual/blocking route) or reject the speculative job. Caller aborts still read as
  the stream's own aborted result, unchanged from the pre-watchdog behavior.
- This stays in the builtin extension because the summarization request lifecycle is
  extension-owned; the shared helper and the core `compact()` route live in
  `core/compaction/` (see `core/compaction/changes.md`).

Expected upstream conflict zones: `builtin/compaction/speculative.ts` around
`generateSummaryMessage`.

## Structured rejection reasons on session_before_compact (2026-07-20)

- `index.ts` cancel paths now attach a structured `rejectionCause` plus a
  human-readable `reason` on the `SessionBeforeCompactResult`:
  - per-turn cap → `{ rejectionCause: "per-turn-cap", reason: "per-turn compaction cap reached for this turn" }`.
  - tripped circuit breaker → `{ rejectionCause: "circuit-breaker", reason: "compaction circuit breaker cooling down (Ns left)" }` with the real remaining cooldown.
  - summarization threw → `{ reason: "compaction generator failed: <message>" }` (no `rejectionCause`; core defaults to `cancelled-by-extension`).
  - summarization returned no summary → `{ reason: "compaction generator returned no summary" }`.
  Core threads these into `compaction_end.errorMessage` so `/compact` produces a
  specific line instead of the bare "Compaction cancelled" the plan flagged.
- `ctx.ui.notify("Compaction rejected: ...", "warning")` was removed from the
  `session_compact` `!accepted` branch and `ctx.ui.notify("Compaction failed: ...", "error")`
  was removed from the provider-throw cancel path. Both facts now travel through
  the canonical `compaction_end` event; duplicating them as toasts produced
  double surfaces while the compaction status indicator was still animating
  (plan §1 Q3). `breaker.recordFailure` in the `!accepted` branch stays live now
  that core actually emits the rejection event.

## Native-form summarization requests and honest compaction errors (2026-07-20)

- `speculative.ts` no longer serializes the conversation into one `<conversation>` text dump for the
  summarization request. Anthropic's anti-distillation classifier deterministically refuses large
  serialized transcripts ("reverse engineering or duplicating model outputs"), which made `/compact`
  fail with a bare "Compaction cancelled" on big sessions (reproduced at ~340k tokens; the same
  content passes as native blocks). `generateSummaryMessage` now sends the conversation as native
  LLM messages (via `convertToLlm` + `repairOrphanedToolResults`) with the merged compaction prompt
  as a trailing user message, plus the agent's system prompt and tool definitions on the request so
  it matches normal agent traffic.
- `runExtensionCompaction` stops swallowing provider failures: an `error` stop reason now throws
  with the provider's message, an `aborted` stream returns undefined (a partial summary is never
  applied), and the post-generation `COMPACTION_BUDGET_RATIO` rejection is gone — it measured the
  size of the *discarded* input, deterministically rejecting successful summaries of large sessions;
  the core `_wouldCompactionOverflow` check still guards the applied result.
- `index.ts` surfaces generation failures on the manual/blocking `session_before_compact` route via
  `ctx.ui.notify(..., "error")` before cancelling, and the fire-and-forget `turn_end` recovery
  compaction now catches rejections so a thrown summarization error cannot become an unhandled
  rejection.
- This stays in the builtin extension because the summarization request shape and failure policy are
  extension-owned; core compaction (`core/compaction/compaction.ts`) is untouched.

Expected upstream conflict zones: `builtin/compaction/speculative.ts` around
`generateSummaryMessage`/`runExtensionCompaction`, and `builtin/compaction/index.ts` around the
`session_before_compact` handler and snapshot construction.

## Truncation-recovery error placeholders for incomplete tool calls (2026-07-17)

- A truncated text-protocol tool call that the middleware could only partially recover now reaches
  history as an `incomplete`-flagged `ToolCall`. `repair-tool-pairs.ts` previously synthesized a
  successful (`isError: false`) placeholder for any dangling `tool_use`, which would bless a
  never-executed truncated call as if it had run. The local compaction copy now emits an
  `isError: true` retry-diagnostic placeholder for flagged dangling calls (reusing the call's
  `errorMessage` when present) so the model is asked to re-issue the call rather than seeing a
  phantom success.
- The matching `packages/ai/src/utils/tool-pair-repair.ts` helper is updated identically; both
  copies are idempotent and legacy (non-flagged) placeholders are not upgraded, so histories written
  before this change are not silently rewritten.

Expected upstream conflict zones: `builtin/compaction/repair-tool-pairs.ts` around the
dangling-call placeholder synthesis and the shared `packages/ai/src/utils/tool-pair-repair.ts` copy.

## Threshold-first emergency tool-result pruning (2026-07-09)

- `index.ts` no longer mutates live `tool_result` events with head/tail truncation before they enter session
  history. Tool outputs stay byte-identical until the assembled provider context exceeds the emergency threshold.
- `speculative.ts` now checks the original message estimate against the 0.95 context-window target before calling the
  existing tool-result prune/truncate helpers. Once over target, the emergency valve still uses the existing
  truncate-then-old-message-prune behavior.
- This stays in the builtin extension because provider-context pressure is extension-owned policy; core only assembles
  and retries provider requests.

Expected upstream conflict zones: `builtin/compaction/index.ts` around event hook wiring and
`builtin/compaction/speculative.ts` around `hardLimitEmergencyPrune`.

## Running token total for emergency prune trimming (2026-06-16)

- `speculative.ts` prunes the compaction budget with a running token total instead of re-tokenizing the retained
  window on every trim step, cutting emergency-prune cost on long sessions (benchmarked in
  `bench/compaction-trim.ts` against `bench/baseline/compaction-trim-baseline.json`).
- This stays in the builtin extension because trim policy and its cost model are extension-owned compaction policy.

Expected upstream conflict zones: `builtin/compaction/speculative.ts` around budget accounting and trim loops.

## Honor the runtime restorationEnabled setting (2026-06-10)

- `index.ts` reads `ctx.getCompactionSettings().restorationEnabled` at gate time instead of the compile-time
  `DEFAULT_COMPACTION_SETTINGS.restorationEnabled` constant (hardcoded `true`), so disabling
  `compaction.restorationEnabled` in settings actually turns post-compact context restoration off. Previously the
  setting was parsed by settings-manager but never consumed.

Expected upstream conflict zones: `builtin/compaction/index.ts` around the restoration gate and
`getCompactionSettings()` call sites.

## Speculative compaction invalidation on abort and model switch (2026-05-23)

- `index.ts` now invalidates the in-memory speculative compaction job on `model_select` and on assistant
  `message_end` events with `stopReason: "aborted"`.
- This prevents a summary generated under the old context-window assumptions from being reused by the next blocking
  compaction route after the user aborts or switches models.
- This stays in the builtin extension because speculative generation ownership lives in the extension closure; core only
  owns the visible compaction abort controllers and message revision.

Expected upstream conflict zones: `builtin/compaction/index.ts` around speculative job lifecycle events and
`message_end` degradation-monitor wiring.

## OpenAI remote compaction timeout fallback (2026-05-19)

- Added a bounded timeout around both OpenAI Responses WebSocket compaction and `/responses/compact` remote compaction.
- When the remote route does not respond, the extension emits a `remote_fallback` event with `remote-compaction-timeout` and lets normal local compaction proceed.
- This stays in `openai-remote.ts` because endpoint selection, timeout, and fallback are provider-native compaction policy, not core session lifecycle.

Expected upstream conflict zones: `builtin/compaction/openai-remote.ts` around remote route execution and fallback events.

## OpenAI remote compact API path (2026-05-15)

- Added `openai-remote.ts` as a builtin-extension module that can compact with OpenAI provider-native history when the
  current session branch is entirely representable as OpenAI Responses input.
- WebSocket-capable OpenAI Responses models use the Codex-style `context_compaction` streaming route first. The
  `/v1/responses/compact` endpoint remains the fallback for non-WebSocket models or failed WebSocket compaction attempts.
- The extension stores the returned native compacted input on `CompactionResult.details`, then rewrites later OpenAI
  Responses provider payloads so the compacted session can continue from the provider-native history.
- The extension emits `senpi:compaction` events for remote start, completion, fallback, and payload rewrite points so other
  extensions can observe which compaction route was used.
- This remains in the builtin extension because provider compatibility, endpoint selection, fallback, and provider-payload
  rewriting are all extension-hookable. Core only needs to carry opaque compaction details to the renderer.

Expected upstream conflict zones: `builtin/compaction/openai-remote.ts`, `builtin/compaction/index.ts` around
`session_before_compact`, and `before_provider_request` hook wiring if upstream changes compaction extension policy,
remote compaction protocol, or provider request events.

## Blocking compaction feedback scope

- Changed `index.ts` so blocking extension compaction calls `ctx.beginCompaction()` before awaiting an in-flight speculative job or generating a fresh summary.
- The feedback signal is linked to speculative generation aborts, and `ctx.endCompaction()` is used only when no compaction entry is applied.
- This remains in the builtin extension because the policy deciding when to await speculative work or generate a fresh summary is extension-owned; the core only provides the visible feedback/cancellation scope.

Expected upstream conflict zones: `builtin/compaction/index.ts` around `applyBlockingCompaction()` and `core/agent-session.ts` around extension compaction context actions.

## 2026-05-12 - Local tool-pair repair for packaged senpi

### What changed
- Added `repair-tool-pairs.ts` to keep compaction's tool-call/tool-result repair logic inside the coding-agent package.
- Switched `builtin/compaction/index.ts` and the compaction repair tests to use the local helper instead of importing `repairOrphanedToolResults` from `@earendil-works/pi-ai`.

### Why
- The published `@code-yeongyu/senpi` package depends on the registry `@earendil-works/pi-ai@^0.74.0`, but the fork-only `repairOrphanedToolResults` export is not present in that published dependency.
- That mismatch makes `senpi` crash during module loading with `SyntaxError: The requested module '@earendil-works/pi-ai' does not provide an export named 'repairOrphanedToolResults'` before any command can run.

### Why extension system couldn't handle this
- The failure happens at ESM module evaluation time while loading a builtin extension, before runtime hooks or settings can intervene.

### Expected merge conflict zones
- LOW: `builtin/compaction/index.ts` import block and any future attempt to re-share this helper from `pi-ai`.

## Post-compact restoration tracker

- Added `restoration-tracker.ts` as a builtin-extension module so file and skill context can be restored without modifying core session flow.
- Added compaction extension hooks for `tool_call`, accepted `session_compact`, and one-shot `before_agent_start` injection.
- Added optional restoration settings to `CompactionSettings` and state storage for the tracker.
- Extension system is sufficient because the feature only needs tool-call observation, compaction lifecycle events, and custom-message injection.

Expected upstream conflict zones: `builtin/compaction/index.ts`, `builtin/compaction/state.ts`, and `core/compaction/compaction.ts` if upstream changes compaction settings or extension hook wiring.
