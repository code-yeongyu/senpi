# changes.md — compaction

## Ideal-pipeline settings split out of the compaction module (2026-08-29)

### What changed

- `compaction.ts` no longer declares the compaction settings surface inline. `CompactionSettings`
  and `DEFAULT_COMPACTION_SETTINGS` move to `compaction-settings.ts`, and the knobs this branch adds
  (grace band, tool admission, reminder, reserve scaling, speculative lead) live in
  `ideal-compaction-settings.ts`, which that type composes. `compaction.ts` re-exports both names, so
  every existing importer keeps its path.

### Why

- `compaction.ts` was already far past the module size ceiling, and the project rule forbids growing
  a file that is already over it. Splitting the settings surface by responsibility keeps the added
  knobs out of an oversized module instead of appending to it.

### Why an extension could not handle it

- The settings shape is the contract the builtin compaction extension and the session manager both
  resolve against; an external extension cannot introduce fields that core admission reads before
  any extension runs.

### Expected merge conflict zones

- Upstream edits to the `CompactionSettings` interface or to `DEFAULT_COMPACTION_SETTINGS` now land
  in `compaction-settings.ts` rather than in `compaction.ts`.

## Compaction re-diverges from upstream dcd4619 (2026-08-25)

### What changed

- `packages/coding-agent/src/core/compaction/compaction.ts` keeps the fork compaction pipeline:
  image/text content handling in summaries, the retry surface (policies plus callbacks), and the
  fork's transport-aware message conversion, re-asserted after this sync's resolution regressed it.

### Why

These are fork-owned product surfaces (senpi branding, provider wire behavior, fork runtime features) that upstream does not carry; the sync must re-assert them on top of upstream's tree.

### Why this lives in the fork

The divergence lives in core wiring, package identity, or build plumbing that executes before any extension loads, so no extension hook can express it.

### Expected merge conflict zones

- The summarization request assembly and retry wiring inside
  `packages/coding-agent/src/core/compaction/compaction.ts`.

## 2026-08-20 - Ignore implausible billed usage for compaction threshold

### What changed

- `packages/coding-agent/src/core/compaction/compaction.ts`: adds `resolveThresholdContextTokens`. If the local estimate is at least 50k and billed usage is more than 8× that estimate, compact against the estimate; otherwise use `max(usage, estimate)`.

### Why

- Cursor dashboard-cumulative cacheRead can be millions while the live window is ~150k. Folding that into the threshold forced a useless compact and a 0-token `resource_exhausted`.

### Why an extension could not handle it

- Compaction threshold math runs in core before any extension compaction hook is consulted.

### Expected merge conflict zones

- `packages/coding-agent/src/core/compaction/compaction.ts` `resolveThresholdContextTokens`

## Summarization request identity, watchdog, and summary-safe filtering after the 59a71b23 pin (2026-08-19)

### What changed

- `packages/coding-agent/src/core/compaction/compaction.ts`: `completeSummarization()` keeps the fork's
  affinity/request-identity split instead of upstream's single routing id. Upstream (pin
  `59a71b235dadb4ad0d67557a8abb0aaa093e68b4`) sets `sessionId: options.sessionId ?? uuidv7()`; the fork sets
  `affinitySessionId: options.affinitySessionId ?? options.sessionId` and always mints a fresh `sessionId` per
  request, so provider affinity follows the caller's session while each summary request stays its own identity.
  The same function keeps the fork's request-local `AbortController` plus `consumeStreamWithIdleTimeout()`
  (`DEFAULT_SUMMARIZATION_IDLE_TIMEOUT_MS` / `DEFAULT_SUMMARIZATION_MAX_DURATION_MS`) over `streamSimple`, so a
  stalled summarization is torn down without aborting the caller's signal.
- `compaction.ts` also keeps: `extraBody`/`sessionId`/`transformContext` parameters through `generateSummary()`,
  `generateSummaryWithUsage()`, `compact()`, and `generateTurnPrefixSummary()`; `contentTextForSummary()` in place
  of `contentText()`; context-excluded custom-message filtering (`contextMessagesForCompactionEntry()`,
  `filterContextExcludedMessages()`) across cut-point scanning and token estimation; base64-run weighting in
  `estimateTokens()`; `prepareCompaction(forceProgress, allowSummaryOnly)`; and the fork compaction settings
  (speculative, restoration, idle) on `CompactionSettings`/`DEFAULT_COMPACTION_SETTINGS`.
- `packages/coding-agent/src/core/compaction/branch-summarization.ts`: keeps the `session_before_compact`
  emission for branch summaries (`reason: "branch"`, fresh `requestId`, synthesized `CompactionPreparation` via
  `createBranchCompactionPreparation()`, cancel and precomputed-summary handling), `extraBody` on
  `GenerateBranchSummaryOptions` with the env-carrying `BranchSummaryStreamOptions`, context-excluded custom
  entries skipped in `getMessageFromEntry()`, and `contentTextForSummary()` for the produced summary text.

### Why

- Upstream's centralized summary-request path reuses the caller's session id as the routing id; the fork's
  providers key prompt-cache affinity and per-request identity separately, so collapsing them would either move a
  summary onto the main turn's cache identity or lose affinity entirely. The watchdog, summary-safe content
  extraction, and context-exclusion filters exist because fork sessions carry provider-native replay blocks and
  fork-only custom messages that must never enter or stall a summarization request.

### Why an extension could not handle it

- These are the core fallback summarization paths: they run exactly when no extension returned a compaction
  result, and the branch-summary hook is emitted from inside `generateBranchSummary()` itself.

### Expected merge conflict zones

- MEDIUM: `completeSummarization()` request-option construction and the produce/watchdog body — upstream edits
  this function whenever it changes caching or routing; keep `affinitySessionId` plus the fresh `sessionId`.
- LOW-MEDIUM: the trailing parameter lists on the four public summary functions; the
  `session_before_compact` block in `branch-summarization.ts`.

## Repository audit baseline for the compaction tracker (2026-08-17)

### What changed

- This entry is the canonical inventory for the repository-wide changes.md audit (`scripts/audit-changes-md.mjs`, pin
  `914cf1472e715297caa30db4b9535d534a9eb718`). The audited production paths whose exact nearest tracker is this file:
  `packages/coding-agent/src/core/compaction/compaction.ts`,
  `packages/coding-agent/src/core/compaction/branch-summarization.ts`, and
  `packages/coding-agent/src/core/compaction/utils.ts`.

### Why

- The audit requires every upstream-owned production divergence to be covered by one entry with all four canonical
  sections in its exact nearest tracker; `utils.ts` divergence predated the gate and had no entry naming it.

### Why an extension could not handle it

- Tracker coverage is repository policy enforced by repository scripts before any extension loader exists.

### Expected merge conflict zones

- NONE: this tracker merges to `ours`; the inventory names pin-relative paths so it survives edits below.

## Summary content normalization and apply_patch file operations (2026-08-17)

### What changed

- `utils.ts`: new `contentTextForSummary()` extracts text from content that may retain provider-native replay blocks
  by filtering `providerNative` blocks out of a copy before `contentText()`; `serializeConversation()` uses it for user,
  assistant, and tool-result arms. Provider-native blocks stay on the persisted message for same-provider replay and
  are never mutated.
- `utils.ts`: `extractFileOpsFromMessage()` recognizes `apply_patch` calls — patched paths extracted from the patch
  text via `extractPatchedPaths()` are recorded as edited — and each tool arm validates its own argument shape
  instead of sharing one pre-checked `path` variable.

### Why

- Provider-native blocks are outside `pi-ai`'s portable `contentText` contract, so summarization either cast them
  away or crashed; apply_patch mutations were invisible to the file-operation lists that summaries use to describe
  what the compacted history changed on disk.

### Why an extension could not handle it

- These helpers run inside the core compaction fallback (`compact()` with no extension result) and inside branch
  summarization before any extension hook can substitute content.

### Expected merge conflict zones

- LOW: `utils.ts` `extractFileOpsFromMessage()` switch and the `contentTextForSummary()` helper; the
  `gpt-apply-patch` import is a fork-only dependency direction.

## Summarization request options: extra body, session affinity, env (2026-08-17)

### What changed

- `compaction.ts`: `generateSummary()`, `generateSummaryWithUsage()`, `compact()`, and `generateTurnPrefixSummary()`
  accept `extraBody` (merged into the outgoing provider payload) and `sessionId`; `createSummarizationOptions()`
  passes `extraBody` and sets `affinitySessionId` from the session id.
- `compaction.ts`: `completeSummarization()` keeps summary requests standalone — `cacheRetention: "none"`, a fresh
  `sessionId` per request, affinity inherited from the caller's session — and its option type is
  `SimpleStreamOptions & { env }` so provider-scoped environment values ride the request.
- `branch-summarization.ts`: `GenerateBranchSummaryOptions` gains `extraBody` alongside `env`, and the branch-summary
  stream options carry the same environment typing.

### Why

- Summaries are one-shot requests: they must not write cache entries nothing will reuse, they must be attributable
  to the session that produced them, and fork providers need per-request body fields (routing, affinity) applied to
  the summarization request exactly as to main turns.

### Why an extension could not handle it

- The core fallback summarization request is dispatched inside `compact()` where extensions that returned no result
  never see the request; option plumbing at this seam is the only path those requests have.

### Expected merge conflict zones

- LOW-MEDIUM: the option-parameter lists on the four public functions (upstream adds parameters here periodically);
  re-apply the trailing `extraBody`/`sessionId` parameters on sync.

## Cut-point fallback, forced progress, and summary-only regeneration (2026-08-17)

### What changed

- `compaction.ts`: `findCutPoint()` falls back to the last valid cut point when the token budget is exceeded before
  any cut point exists at or after the scan index (previously it returned the boundary start and prepared nothing);
  the backward cut-extension scan also stops at context-excluded custom entries.
- `compaction.ts`: `prepareCompaction()` accepts `forceProgress` — when the natural cut point equals the boundary
  start, it advances to the next valid cut point and recomputes the split-turn window — and `allowSummaryOnly`, which
  permits regeneration of an existing summary even when no new messages would otherwise be summarized.

### Why

- Overflow recovery and retry-fallback model switches need a compaction that provably shrinks the next prompt:
  without the fallback, a session whose kept-window landed before the first cut point could not compact at all, and a
  model switch to a smaller context window could not regenerate an oversized summary.

### Why an extension could not handle it

- Cut-point selection and preparation are pure core functions feeding both the extension hook
  (`session_before_compact`) and the core fallback; the admission gates compare against these results.

### Expected merge conflict zones

- MEDIUM: `findCutPoint()` scan loop and `prepareCompaction()` cut-point block; keep the fallback and the
  `forceProgress`/`allowSummaryOnly` parameters together with their admission callers in `agent-session.ts`.

## Extension context transform for summarization sources (2026-08-17)

### What changed

- `compaction.ts`: `generateSummaryWithUsage()` and `compact()` accept `transformContext`; `transformSummarySource()`
  runs it over the previous summary (injected as a sentinel message with a unique negative timestamp) plus the current
  messages, then splits the transformed previous summary back out and re-serializes it for the `<previous-summary>`;
  untransformed paths are unchanged.

### Why

- Providers and extensions that rewrite context (sanitization, format conversion, provider-native replay) must apply
  the same transform to what compaction summarizes, or the summary and the kept window diverge from what the provider
  actually saw.

### Why an extension could not handle it

- The transform must wrap the exact message array handed to the summarization request inside core; the
  `session_before_compact` hook replaces summary content but cannot transform the source window itself.

### Expected merge conflict zones

- LOW: `transformSummarySource()` and the two call sites; the sentinel-timestamp scheme is fork-owned.

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
