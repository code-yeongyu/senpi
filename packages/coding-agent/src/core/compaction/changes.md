# changes.md — compaction

## Wall-clock budget includes final result settlement (2026-08-01)

### What changed

- Core and extension summarization keep `responseStream.result()` inside the same watched async iterator as stream
  acquisition and event consumption.
- A provider whose iterator closes while its final result promise remains pending now reaches the existing 120-second
  `StreamDurationBudgetError` path instead of leaving the TUI on `Compacting...` indefinitely.

### Why

- The affected session showed a provider error and an ended event iterator, then remained in compaction for more than
  seven minutes because final result settlement happened after the watchdog had cleared its timer.
- The existing caller-abort and deterministic required-compaction fallback paths remain unchanged.

### Expected merge conflict zones

- LOW: `compaction.ts` around `completeSummarization()` stream consumption.
- LOW: `extensions/builtin/compaction/speculative.ts` around `generateSummaryMessage()`.

## Wall-clock budget includes provider stream acquisition (2026-07-28)

### What changed

- `stream-watchdog.ts`: `consumeStreamWithIdleTimeout()` now accepts a promised stream and starts its absolute
  duration budget before waiting for that promise to resolve.
- `compaction.ts`: `completeSummarization()` passes the provider stream promise directly into the watchdog instead of
  awaiting connection setup outside the protected interval.

### Why

- A provider adapter that never returned its event stream left compaction permanently stuck before either the idle or
  wall-clock watchdog existed. The request-local abort controller and normal compaction failure cleanup now run after
  the same 120s bound whether the provider stalls before or after stream creation.
- Session `019fa809-5ef4-7db3-bdc3-048da7e0fd9d` exposed the user-visible failure mode: the TUI stayed in compaction
  long enough to appear permanently frozen while provider-side summarization work held the session lifecycle open.

### Expected merge conflict zones

- LOW: `stream-watchdog.ts` around promised-stream acquisition.
- LOW: `compaction.ts` around the `completeSummarization()` stream setup.

## Wall-clock budget for summarization streams (2026-07-28)

### What changed

- `stream-watchdog.ts`: `consumeStreamWithIdleTimeout()` accepts an optional `maxDurationMs` and throws the new
  `StreamDurationBudgetError` when one stream outlives it. The budget is a single absolute deadline for the whole
  stream, not a per-read timer, and it is cleared alongside the idle timer. Caller aborts still win over the budget.
- `DEFAULT_SUMMARIZATION_MAX_DURATION_MS` = 120s, applied by `compaction.ts` `completeSummarization()` and the
  extension's `speculative.ts` request path. `retryAssistantCall` applies it per attempt.

### Why

- The idle watchdog only catches a *silent* connection. A summarization stream that keeps trickling events stays
  under the 300s idle budget indefinitely, and that work is serialized on `AgentSession`'s agent-event queue, which
  `beforeToolCall` waits on before every tool prepare. A live-but-slow summarization therefore froze a whole session:
  tool results withheld at the parallel-batch barrier, typed input queued, TUI stuck on "Working", recoverable only by
  ESC (which releases compaction before the run signal in `_abortActiveAgentAndRetry`).
- Observed in a real session: two freezes of 241s and 208s, both under the idle cap, on a session whose earlier
  auto-compaction had already blocked the same queue for 44s.

### Expected merge conflict zones

- LOW: `stream-watchdog.ts` around the contender race in `consumeStreamWithIdleTimeout()`.
- LOW: `compaction.ts` around the `consumeStreamWithIdleTimeout` call in `completeSummarization()`.

## Lifecycle ownership and required-admission safety (2026-07-23)

### What changed

- `lifecycle.ts` now owns the active compaction controller together with reducer transitions, so feedback from an older
  generation cannot progress or terminate a newer one. Feedback-only cancellation emits one terminal
  `compaction_end`, and accepted compactions emit their terminal event before `session_compact` handlers can start
  another generation.
- Extension contexts retain the signal returned by `beginCompaction()` and supply it to legacy `updateCompaction()` /
  `endCompaction()` calls that omit one. Core accepts feedback mutations only from the current signal.
- Provider admissions now share one required-compaction gate for prompt preflight, extension-triggered turns, and
  next turns. Silent provider overflow and threshold-required compaction synchronously stop agent-core's
  post-`agent_end` queue drain so only an accepted `AgentSession` recovery may resume queued work, and overflow can
  force a split-turn preparation when keeping the only oversized prompt would otherwise leave no compactable source.
- Compaction rejects stale source snapshots with `stale-revision` before the durable entry append.
- Retry fallback model changes invalidate prior-model compaction and re-check the selected model's context window.
  Summary-only re-compaction is allowed only for this retry boundary.
- Assistant history is classified around the latest compaction by persisted branch order; an older payload timestamp
  cannot hide a message whose entry was appended after the compaction boundary.
- Execution routes pass their own controller into core compaction; an auto request supersedes unrelated feedback
  instead of inheriting/promoting its controller and leaving outer compaction state stuck.
- The one-turn post-compaction and post-retry stale-usage exemptions are shared across synchronous queue ownership,
  asynchronous checking, and admission resampling, while explicit provider overflow is never exempt.

### Why

A late extension completion could overwrite fresh feedback, and some continuation routes skipped required compaction.
Compacting a source that changed during summary generation could also append a stale checkpoint over intervening work.

### Expected merge conflict zones

- LOW: `lifecycle.ts` and the compaction admission calls in `agent-session.ts`.

## Operation lifecycle reducer (2026-07-23)

### What changed

- `lifecycle.ts` adds the pure `idle` / `running` / `completed` / `failed` / `aborted` transition model used by
  `AgentSession`, including monotonic generations, feedback-to-execution promotion, and stale terminal-event rejection.

### Why

- Compaction completion must remain observable after controllers are released, while delayed work from an older
  generation must not overwrite the active operation.

### Expected merge conflict zones

- NONE: `lifecycle.ts` is a new fork-owned module.

## Summarization stream idle watchdog (2026-07-21)

### What changed

- `stream-watchdog.ts` (new, fork-owned): `consumeStreamWithIdleTimeout()` drains an event stream
  and throws `StreamIdleTimeoutError` when no provider event arrives within the idle budget
  (default 300s, `DEFAULT_SUMMARIZATION_IDLE_TIMEOUT_MS`, matching the agent stream idle-timeout
  default). On trip it aborts a request-local controller and returns the iterator; caller aborts
  end the wait quietly so ESC still reads as the stream's own aborted result.
- `compaction.ts` `completeSummarization()`: both the `streamSimple` and custom-`streamFn` routes
  now consume the summarization stream through the watchdog under a request-local
  `AbortController` linked to the caller's signal, instead of awaiting `completeSimple()` /
  `stream.result()` with no bound.

### Why

Local compaction summarization had no timeout at any layer: a stalled provider/gateway connection
hung the session on "Compacting…" forever (observed: 11+ minutes, recovered only by ESC abort).
The agent loop has had this protection for main turns (`StreamIdleTimeoutError` in
packages/agent); this ports the same guarantee to compaction requests.

### Why extension system couldn't handle this

- The core `compact()` fallback route (`session_before_compact` handlers returning no result)
  dispatches its own summarization request inside core; extensions cannot bound a request they
  never see.

### Expected merge conflict zones

- MEDIUM: `compaction.ts` around `completeSummarization()` and the pi-ai/compat import
  (`completeSimple` → `streamSimple`).
- NONE: `stream-watchdog.ts` is a new file.

## Base64-aware token estimation (2026-07-18)

### What changed

- `compaction.ts`: `estimateTokens()` now weights long unbroken base64-ish runs (512+ chars of `[A-Za-z0-9+/=_-]`) at
  ~1 token per character instead of the chars/4 prose heuristic. Applied to string/text-block content, tool-call
  arguments, and bash output via a shared `weightedChars()` helper.

### Why

- Providers tokenize base64 near 1 token/char. A tool result carrying a ~1 MB inline screenshot data URL estimated at
  ~256K tokens while Anthropic counted ~1M, so pre-flight compaction never triggered and the provider rejected the
  request (`prompt is too long: 1029893 tokens > 1000000 maximum`). Real reproducer: session
  `019f711b-587a-75ba-9eda-48fd5b2c2c01` (compaction recorded `tokensBefore: 319506` for a context the provider
  counted at 1.03M).

### Why extension system couldn't handle this

- `estimateTokens()` is core and feeds `estimateContextTokens()`, which `agent-session.ts` uses for the pre-prompt
  compaction gate before any extension sees the turn.

### Expected merge conflict zones

- LOW: `compaction.ts` around `estimateTextAndImageContentChars()` and the `estimateTokens()` switch arms. Keep the
  weighting applied to every text surface the estimator counts.

## Split-turn compaction serialization sync (2026-07-02)

### What changed

- `compaction.ts`: accepted upstream serialization of split-turn compaction summaries so single-concurrency providers do
  not receive overlapping generations.

### Why

- Split-turn compaction can be triggered while the session is still processing summary work. Serializing those summaries
  avoids provider-side 429/concurrency failures and keeps compaction state deterministic.

### Why extension system couldn't handle this

- The serialization boundary is inside core compaction preparation/execution. Extensions can provide or observe
  summaries, but they cannot serialize the underlying core summary request queue from outside.

### Expected merge conflict zones

- LOW: `compaction.ts` around summary generation scheduling and split-turn helper calls.

## Plugsuit-style Threshold Foundation (2026-04-28)

### What changed

- `compaction.ts`: Added speculative compaction settings fields (`speculativeEnabled`, `speculativeFraction`, `speculativeCooldownMs`) to `CompactionSettings` and defaults.
- `extensions/builtin/compaction/policy.ts`: Removed the 0.78 OMO threshold floor. Effective threshold now follows the adaptive plugsuit-style tiers directly (0.45/0.50/0.55/0.60/0.65), with yield adjustment clamped to the existing 0.4-0.7 adaptive range.
- `extensions/builtin/compaction/policy.ts`: Added `SPECULATIVE_FRACTION`, `shouldStartSpeculativeCompaction()`, `computeEffectiveKeepRecentTokens()`, and `isAtHardLimit()` for later speculative/emergency phases.
- `settings-manager.ts`: Resolved compaction settings now include speculative and restoration fields.
- `extensions/builtin/compaction/index.ts` and `speculative.ts`: Builtin compaction uses resolved settings from `ExtensionContext` instead of hardcoded defaults for before-turn threshold checks and snapshot preparation.

### Why

- Plugsuit starts compaction much earlier than the OMO 78% floor. Keeping the floor made senpi's auto-compaction late and mostly reactive.
- Removing the floor alone is unsafe for small context windows because the default `keepRecentTokens` (20000) can exceed the useful compactable range. The effective keep-recent cap prevents early thresholds from producing empty preparations.
- Speculative and emergency phases need stable policy functions and settings keys before they can be wired safely.

### Why extension system couldn't handle this

- The policy constants live in the builtin compaction extension and must be shared by unit tests, speculative snapshots, and future emergency pruning.
- Resolved settings are owned by core `SettingsManager`; builtin extensions needed a typed `ExtensionContext` reader to avoid bypassing user `settings.json`.

### Modified upstream files

- `compaction.ts` — additive `CompactionSettings` fields and defaults.
- `settings-manager.ts` — resolved setting defaults for new compaction fields.

### Expected merge conflict zones

- LOW: `compaction.ts` settings interface/defaults.
- MEDIUM: `settings-manager.ts` `CompactionSettings` and `getCompactionSettings()` if upstream changes settings shape.

### Migration notes

- Preserve the invariant that adaptive threshold and effective keep-recent cap are updated together. Do not reintroduce a hard floor without also proving small-context compaction can still prepare non-empty summaries.

## prepareCompaction Rejects Empty Summarization (2026-04-28)

### What changed

- `compaction.ts`: `prepareCompaction()` now returns `undefined` when both `messagesToSummarize` and `turnPrefixMessages` are empty.
- `_executeCompaction()` (unchanged) reaches its existing "Nothing to compact (session too small)" error path, which surfaces as a clear failure instead of silently invoking the LLM with an empty `<conversation>` block.

### Why

When `keepRecentTokens` (default 20000) is larger than the total session token count, `findCutPoint` defaults to the first valid cut point and then `findCutPoint`'s backward scan extends the cut all the way to entry 0 (model_change / thinking_level_change). The result was a preparation with `messagesToSummarize: []`, `turnPrefixMessages: []`, and `firstKeptEntryId` pointing at the very first non-message entry. The new builtin compaction extension then called the LLM with an empty `<conversation></conversation>` block and the 9-section prompt's R2 rule ("If a section has no content, write 'None.'") forced the model to emit `None.` for every section. That all-`None.` summary was persisted as a real compaction entry, **destroying the conversation that should have been summarized**.

A real reproducer: `~/.senpi/agent/sessions/--Users-yeongyu-local-workspaces-senpi-mono--/2026-04-28T01-50-51-950Z_*.jsonl` contains two consecutive compactions on a tiny Kimi K2.6 hello session, both stored as all-`None.` summaries with `tokensBefore` of 11527 and 11690.

### Why extension system couldn't handle this

`prepareCompaction()` is core; it computes the cut point, the messages to summarize, and the previous summary. Extensions can override the summary content via `session_before_compact`, but they cannot decide whether the core preparation step itself should reject the request. Without this guard in core, every extension and the upstream fallback `compact()` call would have to repeat the same emptiness check.

### Modified upstream files

- `compaction.ts` — `prepareCompaction()` returns `undefined` when there is nothing to summarize.

### Expected merge conflict zones

- LOW: `compaction.ts` `prepareCompaction()` is rarely changed upstream. The guard is a small additive check immediately before the final return; conflict resolution is to keep the guard and apply it after upstream's preparation logic computes `messagesToSummarize` / `turnPrefixMessages`.

### Migration notes

If upstream changes `prepareCompaction()` to compute additional summary inputs (for example a separate "trailing reminders" array), extend the emptiness guard to include them. The invariant: never return a defined `CompactionPreparation` whose total summarizable content is empty.

## Branch Summarization Routes Through Compaction Hook (2026-04-27)

### What changed

- `branch-summarization.ts`: `generateBranchSummary()` now emits `session_before_compact` with `reason: "branch"` before the default branch prompt path when an extension runner is provided.
- `branch-summarization.ts`: Branch entries are converted into an equivalent `CompactionPreparation` object for extensions.
- `branch-summarization.ts`: Extension `{ compaction: CompactionResult }` responses override the branch summary; `{ cancel: true }` aborts branch summarization.

### Why

- Branch summary was a separate route with a different prompt and no Critical Context section, causing the 9 inconsistencies the user listed.
- Routing through `session_before_compact` lets the builtin extension provide one canonical 9-section prompt across all 6 routes.
- The existing `BRANCH_SUMMARY_PROMPT` remains the fallback when no extension overrides.

### Why extension system couldn't handle this

The branch summarization path did not emit a compaction event before building its default prompt. Extensions can only replace branch summary content after this seam exists in core.

### Modified upstream files

- `branch-summarization.ts` — emits `session_before_compact` for branch summaries and accepts extension-provided compaction summaries.

### Expected merge conflict zones

- LOW: `branch-summarization.ts` is rarely touched upstream. If upstream changes branch summary preparation, keep the hook emission before default prompt construction and update the `CompactionPreparation` mapping to match the new data flow.

### Migration notes

If upstream changes branch summary preparation or adds new branch summary data sources, keep the `session_before_compact` hook emission before default prompt construction and update the `CompactionPreparation` mapping to match the new data flow. The `BRANCH_SUMMARY_PROMPT` fallback must remain intact for sessions without the compaction extension.
