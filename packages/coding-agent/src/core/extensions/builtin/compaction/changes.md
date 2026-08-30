# changes.md — builtin compaction policy

## Deliver retry-safe ephemeral budget reminders (2026-08-30)

### What changed

- `before_agent_start` now arms a one-user-turn reminder lease keyed to the accepted-compaction epoch instead of returning a custom reminder message or consuming an undelivered generation.
- The context projection prepends the leased reminder to the real user message without persisting or adding a turn. Repeated provider projections reuse that shape, so retry/model fallback sees one reminder while the next user turn, disablement, or accepted compaction clears the lease.
- Restoration custom messages remain separate and unchanged.

### Why

- Ordinary turns had no restoration payload for the reminder to ride on, so the previous state advanced without delivering anything. Returning a standalone custom message fixed delivery but suppressed model fallback. A context-only lease reaches every attempt of the same logical turn without entering session history or changing retry dispatch.

### Why an extension could not handle it

- The lease coordinates this builtin's private compaction epoch, reminder policy, restoration payload, and context transform. Another extension cannot safely observe or mutate that state.

### Expected merge conflict zones

- MEDIUM: `index.ts` around accepted `session_compact`, `before_agent_start`, and `context` handlers.
- LOW: `token-budget-reminder.ts`, `orchestration.ts`, and `context-pipeline.ts` around reminder state/projection.

## Preserve structured tool-result content during admission (2026-08-30)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/compaction/orchestration.ts` now projects oversized text
  blocks in place while preserving every image/non-text block and the original mixed-content ordering.
- The real OpenAI replay pipeline is characterized with an oversized checkpoint-owned tool result: the extension
  runner's enumerable session-entry identity survives admission and authorizes native replay without extra identity
  copying in production.

### Why

- Replacing an admitted mixed tool result with one synthesized text block silently discarded images. The separate
  replay-loss report was incorrect because the extension runner materializes session-entry identity as an enumerable
  request-local property before context handlers run, and the existing message spread retains it.

### Why an extension could not handle it

- Admission is the builtin compaction extension's first context transform; later extensions cannot recover structured
  blocks that this handler has already removed.

### Expected merge conflict zones

- LOW: the tool-result content mapping in `orchestration.ts`.

## Deterministic diskless tool admission (2026-08-30)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/compaction/tool-admission.ts` now replaces oversized tool
  results with a deterministic in-memory head/tail projection instead of synchronously writing full results to
  random spill files. Projection keeps shrinking until its estimated text is at or below the configured admission
  cap, and visible marker text is never interpreted as trusted state.
- `packages/coding-agent/src/core/extensions/builtin/compaction/orchestration.ts` no longer allocates a shared
  temporary spill directory or bypasses admission when tool output contains a marker-shaped line.

### Why

- Context projections are rebuilt from persisted original messages on every provider request. Random spill names
  therefore caused unbounded duplicate files with umask-dependent permissions, while synchronous filesystem
  failures could abort this context handler and skip downstream compaction transforms. A forgeable marker also
  allowed oversized output to bypass the cap.

### Why an extension could not handle it

- This is the builtin compaction extension's context-admission boundary itself. An external extension cannot make
  an earlier builtin handler deterministic or recover downstream transforms after that handler throws.

### Expected merge conflict zones

- LOW: the admission call in `orchestration.ts` and the projection format and cap loop in `tool-admission.ts`.
# Builtin compaction extension changes

## Preserve replay-safe Gemini signed state in deterministic fallback recovery (2026-08-18)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/compaction/retained-message-safety.ts`: Replaced blanket rejection of `thoughtSignature`, `thinkingSignature`, and `textSignature` with format-aware validation (`isValidProviderSignature`). Allowed valid base64 signatures on assistant blocks while continuing to fail closed on malformed values.
- `packages/coding-agent/src/core/extensions/builtin/compaction/deterministic-fallback.ts`: Added `hasValidToolChains` validation to guarantee retained tool results are never orphaned from their preceding tool calls. Implemented backward boundary search to find earlier safe cut points when the initial cut point would fragment an atomic tool chain. Added structured diagnostic reasons (`DeterministicFallbackRejectionReason`) and telemetry fields for rejection observability without logging secret/signature payloads.

### Why

- During required compaction recovery under Gemini 3+, legitimate assistant turns often contain `thoughtSignature` on tool calls with empty text, or signed thinking/text blocks without visible text. Unconditionally rejecting these valid provider states prevented deterministic fallback recovery from succeeding on valid sessions, causing hard failure.

### Why an extension could not handle it

- The deterministic fallback recovery path and its message-safety validation are internal sub-policies of the builtin compaction extension (`retained-message-safety.ts` and `deterministic-fallback.ts`).

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/builtin/compaction/retained-message-safety.ts`
- `packages/coding-agent/src/core/extensions/builtin/compaction/deterministic-fallback.ts`

## Align idle warm lifecycle with compaction lane ownership (2026-08-30)

### What changed

- `index.ts` enrolls newly started sub-threshold idle warm jobs in the same bounded transient-failure retry lifecycle as above-threshold idle jobs. Retry admission now re-checks the warm-generation floor instead of requiring the apply threshold; the idle apply still requires a fresh above-threshold decision.
- Sub-threshold local warming is skipped for OpenAI remote-compaction-capable models. Above-threshold idle generation and apply remain local, and the existing remote-first blocking route still falls back to local generation when remote compaction is unavailable.
- `idle-retry.ts` names its retry gate for warm eligibility rather than threshold eligibility.

### Why

- The half-window idle path started a speculative job without arming its retry watcher. One transient failure therefore left a failed job for later threshold admission to inherit, even though the established idle lifecycle had bounded retries for the same failure class.
- A completed sub-threshold local summary cannot be consumed by OpenAI remote compaction. Successful remote threshold admission aborted that already-paid local work, so warming it had cost without a viable owner.

### Why an extension could not handle it

- Speculative job ownership, idle retry registration, and remote/local route ordering are private state inside this builtin. Another extension cannot attach lifecycle watchers or transfer a warm job between these routes.

### Expected merge conflict zones

- MEDIUM: `index.ts` around `armIdleWarmupRetry` and the `agent_end` warm-action branch.
- LOW: `idle-retry.ts` retry decision naming.

## Model usability budget admission (2026-08-30)

### What changed

- `model-usability-budget.ts` projects one typed minimum context budget from the assembled system
  prompt, active tool schemas, model output reserve, effective compaction reserve, speculation lead,
  a data table of model-family safety margins, and (for a downswitch) the current live context.
- `agent-session.ts` rejects an unusable model during direct or favorite-cycle selection before any
  model, history, or default mutation; `sdk.ts` applies the fixed-budget check after session setup has
  assembled the runtime prompt and active tools. A live-context rejection carries compact, revalidate,
  and retry guidance, while a successful explicit compaction lets the caller retry the same switch.
- Disabling compaction removes both its reserve and speculation lead from the projection, while
  disabling speculation removes only the lead. Reserve-scaling opt-out continues to use the exact
  configured reserve.

### Why

- Small-context models could have a speculation lead at or beyond their compaction threshold and
  enter permanent compaction before the prompt and tool surface left any room for useful work.
  A measured rejection explains the exact shortfall instead of silently degrading.
- A statically usable target could still be too small for a transcript accumulated on a larger model;
  committing that downswitch deferred the failure until the next provider request. The live projection
  now refuses that invalid state and makes compaction an explicit, revalidated recovery step.

### Why an extension could not handle it

- Initial session creation and model mutation must reject before a provider request is admitted;
  an extension cannot atomically guard every core model-selection and runtime-creation path.

### Expected merge conflict zones

- LOW: the projection imports shared compaction geometry and output-reserve helpers; keep those
  dependencies aligned if either helper moves.

## Apply idle warm compaction during the idle gap (2026-08-26)

### What changed

- `index.ts` adds an idle-apply watcher (`armIdleApply`) on the speculative job started by the
  `agent_end` idle trigger (and by the idle warm-up retry timer). When generation completes while
  the session is still idle and over threshold, the summary is applied immediately through the
  shared `applyGeneratedCompaction` guards instead of being held warm until the next
  `before_agent_start`. A new `sessionIdleSinceAgentEnd` flag fences the watcher; it is cleared by
  `before_agent_start` and `session_shutdown`. Stale or refused applies keep the warm hold, so the
  next prompt consumes the job exactly as before.
- `log.ts` adds the `idle_applied` debug event.
- `test/compaction/idle-compaction.test.ts` updates the two idle warm-up tests to the new contract:
  one apply at idle, never replayed on the following prompt.

### Why

- Holding the warm summary until the next submit made the user watch their own prompt wait behind
  a compaction they could not see coming; the [compaction] block rendered at submit time even
  though generation had finished minutes earlier. Applying during the idle gap renders the block
  first and lets the next message stack below it.

### Why an extension could not handle it

- The speculative job registry, idle retry timer, and apply admission are private policy inside
  this builtin; external extensions cannot observe or consume the warm job.

### Expected merge conflict zones

- MEDIUM: `index.ts` `agent_end` / `before_agent_start` handlers during upstream syncs.

## Bound todo snapshots and keep successful compaction admission open (2026-08-25)

### What changed

- `todo-bridge.ts` now snapshots only the latest todo phases from the active branch instead of
  persisting every historical `senpi.todo-state` session envelope. Restore checks use the same
  branch-local current state, and legacy snapshots containing raw custom entries are normalized
  to their latest todo payload before any restore message is emitted.
- `per-turn-cap.ts` retains successful-compaction counters as telemetry but no longer rejects a
  long-lived session after ten accepted compactions. The independent circuit breaker remains
  responsible for repeated failed or ineffective attempts.

### Why

- Repeated snapshots recursively retained the full todo-state history, growing from kilobytes to
  megabytes and immediately refilling context after compaction.
- The absolute success cap then permanently rejected threshold, overflow, manual, and pre-prompt
  compaction routes after ten effective compactions, leaving no in-session recovery path.

### Why an extension could not handle it

- Snapshot capture/restore and admission accounting are private policy inside this builtin.
  External extensions cannot replace the persisted metadata payload or override this builtin's
  pre-compaction rejection decision.

### Expected merge conflict zones

- LOW: `todo-bridge.ts` around snapshot parsing, current-state capture, and restore suppression.
- LOW: `per-turn-cap.ts` around the former absolute-cap exports and admission predicate.

## Skip Cursor compaction while the session is not idle (2026-08-19)

Blocking and generated apply refuse `cursor` / `cursor-cli-oauth` when `!ctx.isIdle()`. Mid-run Cursor compact poisons `conversationId`. Idle `agent_end` / `pre_prompt` still compact.

Conflict zone: `applyBlockingCompaction`, `applyGeneratedCompaction`.

## Stand down silently when a compaction request is aborted (2026-08-16)

### What changed

- The `session_before_compact` handler returns immediately when `event.signal` is already aborted,
  before touching warm-job ownership, and converts an abort-driven throw from
  `runOpenAiRemoteCompaction` into a silent stand-down (`return undefined`) instead of letting the
  raw `Request was aborted` escape through `ExtensionRunner.emit` as a stack-bearing extension
  error ([#886](https://github.com/code-yeongyu/senpi/issues/886)).
- `applyBlockingCompaction`'s catch treats an aborted feedback signal as a cancellation: it ends
  feedback with `aborted: true` and no `errorMessage`, records no circuit-breaker failure, and
  returns `{ applied: false, reason: "rejected" }` instead of painting
  `Compaction failed: Request was aborted` and rethrowing out of `before_agent_start`. This
  matches the faux-route contract already pinned by
  `blocking-compaction-review-hardening.test.ts` ("degrades silently with no error message").

### Why

- Compaction claims are last-writer-wins in core (`_claimCompactionController`), so a resumed
  session where a queued extension message races the user's prompt routinely aborts the loser's
  in-flight remote compaction. The remote route deliberately rethrows on abort
  (`openai-remote.ts` abort guard, `openai-remote-timeout.ts` entry guard); without handler-level
  containment every such race rendered `Extension "<builtin:compaction>" error: Request was
  aborted` with a full async stack.
- The stand-down must NOT use the `{cancel: true}` path: a cancel emits `session_compact` with
  `accepted: false`, which records a circuit-breaker failure — aborts are not failures.
- CONTRACT CHANGE: an aborted-at-entry request previously returned `{cancel: true}` without a
  reason (pinned by `before-compact-error-surfacing.test.ts` and
  `required-compaction-deterministic-fallback.test.ts`, both updated). The rendering is
  unchanged — core's aborted classification still shows the plain "Compaction cancelled" — but
  the abort no longer debits the circuit breaker through the rejected-compaction path.

### Why an extension could not handle it

- The defect is inside this builtin's own handlers; no core change is involved in this half of
  the fix (the admission-side half lives in `core/agent-session.ts`, see `src/core/changes.md`).

### Expected merge conflict zones

- `index.ts` `session_before_compact` handler entry and the core-route `runOpenAiRemoteCompaction`
  call site; `applyBlockingCompaction`'s catch block.

## Survive provider body-size rejections and strict turn alternation in summarization requests (2026-08-16)

### What changed

- Gateway HTTP 413 body-size rejections ("Request body too large", "Request Entity Too Large")
  now flow into the existing overflow shrink-retry: the summarization input halves across
  attempts and exhaustion throws the classifiable `SummarizationOverflowExhaustedError`, so
  threshold/overflow compactions degrade through the deterministic fallback instead of wedging
  the session on `Compaction rejected: compaction generator failed: 413 ...`
  ([#884](https://github.com/code-yeongyu/senpi/issues/884)).
- New `summarization-turn-order.ts` normalizes the final summarization message list at the
  `generateSummaryMessage` seam (after `convertToLlm` + pair repair, where roles are final):
  adjacent assistant messages merge, and content before the first user message is dropped.
  Gemini's 400 `function call turn must come immediately after a user turn` fired twice in the
  incident because sessions carry adjacent assistants (split turns, retries) and budget pruning
  can drop the leading user message.
- `overflow-retry.ts` request sizing now adds a CJK density correction (weight 3, mirroring the
  base64-run weighting) to the chars/4 estimate: Korean text tokenizes near 1 token per 1.5
  characters, and the 4.00 chars/token estimate let Korean-heavy sessions send first attempts
  far over provider size limits. The correction rides `estimateTotalTokens`, so it also reaches
  `hardLimitEmergencyPrune` and the `/btw` side-query bound — both prune Korean-heavy sessions
  slightly earlier, which is the same undercount corrected in the safe direction.

### Why

- A live session hit all three defects in one compaction: two gateway 413 shapes never reached
  the shrink path (unclassified), gemini-3.7-flash-high rejected the request's turn order twice,
  and the final model stalled the 120s wall-clock on the oversized input. Every fallback model
  retried the same payload and failed identically, permanently wedging the session.

### Why an extension could not handle it

- The shrink-retry classification, the request message construction, and the input sizing all
  live inside this builtin's summarization pipeline; an external extension observes only the
  final cancel reason.

### Expected merge conflict zones

- LOW: `speculative.ts` at the `requestContext` construction (one wrapped call site);
  `overflow-retry.ts` estimator internals. New module `summarization-turn-order.ts` is
  fork-only with no upstream counterpart.

## Surface the concrete reason a compaction did not apply (2026-08-14)

### What changed

- `endCompactionFeedback` now threads the remote stage's fallback reason (captured from the `remote_fallback` event) and the terminal local reason (`unavailable` / `stale`) into `ctx.endCompaction`'s `errorMessage`, so the decision log and TUI show e.g. `Compaction did not apply: remote-compaction-timeout; local fallback unavailable` instead of the bare generic string.
- An aborted compaction still renders `Compaction cancelled` downstream and carries no failure message.

### Why

- Both the remote-timeout path and the `unavailable`/`stale` fallback collapsed into the generic `Compaction did not apply`, so the actual cause was not diagnosable after the fact. The remote reason was previously emitted only on an event bus with no subscriber.

### Why an extension could not handle it

- The reason is produced inside this builtin's blocking route; an external extension cannot observe the remote stage's fallback event or the feedback call site.

### Expected merge conflict zones

- LOW: `index.ts` `endCompactionFeedback` and the remote-capture emit in `applyBlockingCompaction`; LOW in the compaction tests that pinned silent degradation.

## Report provider-owned compaction as delegated (2026-08-14)

### What changed

- The SDK-native lane's `session_before_compact` cancellation now carries the structured `external-owner` rejection
  cause while preserving its existing human-readable reason.
- The lane-policy documentation now describes the structured ownership signal instead of the former generic
  extension cancellation.

### Why

- Core admission must distinguish a provider lane that will compact inside the admitted query from an ordinary
  extension refusal. Treating both as `cancelled-by-extension` made over-threshold SDK-native sessions fail with
  `RequiredCompactionError` before the provider could run.

### Why an extension could not do this

- The builtin compaction extension owns the lane cancellation verdict and is the only layer that can identify this
  cancellation as provider ownership before core records the lifecycle failure.

### Expected merge-conflict zones

- LOW: `index.ts`, in the SDK-native lane branch of `session_before_compact`.
- LOW: `lane-policy.ts`, around `SDK_NATIVE_LANE_REJECTION_REASON` documentation.

## Stand the idle warm-up watcher down on a retired generation (2026-08-13)

### What changed

- `index.ts` gained `isContextRetired(ctx)`, and `armIdleWarmupRetry` now consults it in BOTH continuations that
  outlive the runner generation that armed them: the `job.failure` continuation and the armed retry `setTimeout`.
- `index.ts` registers a `session_shutdown` handler that cancels the pending warm-up timer, resets the attempt
  counter, and aborts the in-flight speculative job.

### Why

- `AgentSession.reload()` retires the old extension generation (`oldExtensionRunner.invalidate("stale extension
  generation after reload")`), after which every `ExtensionContext` getter throws. The warm-up watcher outlived that
  invalidation and read the retired context anyway, and neither call site had a caller left to receive the throw:
  the failure continuation is spawned with `void` (an unhandled rejection) and the timer callback throws straight
  into the timer queue. Interactive mode promotes that to `uncaughtCrash`, so a reload landing inside the warm-up
  retry window killed the CLI with:

  ```
  pi exiting due to uncaughtException:
  Error: stale extension generation after reload
      at ExtensionRunner.assertActive (core/extensions/runner.js)
      at Object.getContextUsage (core/extensions/runner.js)
      at core/extensions/builtin/compaction/index.js
  ```

- `session_shutdown` fires on the reload path BEFORE the invalidation, so tearing the watcher down there is the
  deterministic fix; `isContextRetired` remains the backstop for any path that retires a generation without
  emitting the event.
- The probe reads a getter inside `try`/`catch` because `ExtensionContext` deliberately exposes no liveness flag.
  Adding one is a public-API change that this crash does not justify.

### Why an extension could not do this

- This is the builtin extension's own private warm-up watcher. No external extension can observe, cancel, or guard
  another extension's armed timer or in-flight summarization continuation.

### Expected merge-conflict zones

- MEDIUM: `index.ts` `armIdleWarmupRetry` (both guard sites) — upstream has no such watcher, so a sync that
  rewrites this function will drop the guards.
- LOW: the trailing `session_shutdown` handler at the end of the extension factory.

## 2026-08-13 - Let the core route claim the idle warm summary

### What changed

- `session_before_compact` now attempts `claimWarmSummaryForCoreRoute()` BEFORE invalidating, and
  returns the warm result as its `compaction` when the claim holds. The claim detaches the job
  synchronously (before any `await`) so exactly one route can own it, and deliberately does NOT abort
  its controller - aborting is what threw the already-paid summarization away.
- A claim requires: no custom instructions (manual compaction keeps its own wording), a speculative
  origin, the same model identity, a valid `WarmAnchorSnapshot` against the event branch, and a
  boundary equal to the core preparation's `firstKeptEntryId`. Anything else falls through to the
  existing fresh generation, unchanged.
- The claimed job's generation is logged as `warm_consumed` with `route: "core-route"`.

### Why

On a new prompt the ordering is deterministic, not a race: `_enforceCompactionBeforeProvider` runs
before `emitBeforeAgentStart`, so the CORE route always reaches compaction first. Its handler called
`invalidateSpeculativeCompaction()` as its first statement, so the idle warm-up - whose entire purpose
is to keep summarization off the user's critical path - was destroyed and re-billed exactly when it
was needed. PR #853 fixed the extension route only; this closes the other half.

### Why an extension could not do it

The warm job lives in this extension, but the route that discarded it is the core-driven
`session_before_compact` emission; the fix has to happen inside that handler.

### Expected merge-conflict zones

- `index.ts` `session_before_compact` handler head and the block preceding core-route snapshot creation.

## 2026-08-13 - Anchor warm summaries to the summarized prefix

### What changed

- `applyGeneratedCompaction` no longer discards a warm summary on message-revision
  inequality alone. When the revision moved, it builds a warm-anchor snapshot from
  `preparation.firstKeptEntryId` (`core/compaction/warm-anchor.ts`) and applies the warm
  result while the summarized prefix is unchanged.
- That path passes `expectedWarmAnchor` instead of `expectedRevision`, and the core
  compare-and-apply gate re-validates it with the SAME shared validator before mutating the
  transcript, so the two gates cannot drift apart.
- The compaction boundary is compared by entry ID, never by array position. Compaction records
  are appended after the entries they summarize, so a valid next-generation anchor routinely
  precedes the boundary it updates, and sibling branches can hold different boundaries at the
  same index. A positional rule silently rejected every warm summary in an already-compacted
  session while still admitting a cross-branch boundary.

### Why

The idle warm-up exists to move summarization off the user's critical path, but
`_messageRevision` increments on every appended message. A session parked in a cache-warm
wait appends wait notices, monitor state, and finally the user's own prompt, so the warm
summary was guaranteed stale exactly when the blocking route needed it. Field logs showed
415 warm-ups started, 36 consumed and only 10 applied; the rest paid a second full
summarization for work already done. A summary describes the entries before its cut, so
appends after the anchor cannot invalidate it - only a rewrite of the summarized prefix can.

### Why an extension could not do it

The compare-and-apply admission gate lives in `core/agent-session.ts`; admitting a warm
summary under a content anchor requires that core option and its revalidation.

### Expected merge-conflict zones

- `speculative.ts` `applyGeneratedCompaction` and the `applyCompaction` context signature.
- `core/agent-session.ts` `applyCompaction` guard block.

## 2026-08-13 - Preserve auth-resolved local compaction endpoints

### What changed

- Local speculative and blocking compaction overlay the snapshot model with the
  base URL returned by `ModelRegistry.getApiKeyAndHeaders()` before dispatching
  summarization.

### Why

- OAuth providers such as GitHub Copilot derive account-specific enterprise
  endpoints from credentials; using the catalog model silently fell back to the
  individual endpoint.

### Why an extension could not handle it

- The builtin compaction extension owns this alternate summarization path.

### Expected merge-conflict zones

- MEDIUM: `speculative.ts`, around auth resolution and summary request snapshot
  construction.

## 2026-08-13 - Make retry-policy tests deterministic

### What changed

- Blocking compaction retry tests now advance fake time through the production
  1s/2s/4s backoff instead of waiting on wall-clock timers.

### Why

- The full retry budget is seven seconds, longer than Vitest's five-second test
  timeout. Real-time waits made the merged tests fail deterministically despite
  correct retry behavior.

### Why an extension could not handle it

- This is test-harness coverage for the builtin extension's retry policy; no
  shipped runtime behavior changed.

### Expected merge-conflict zones

- LOW: blocking compaction retry-policy tests.

## 2026-08-13 - Preserve nullable provider-header overrides

### What changed

- Speculative and OpenAI remote compaction auth contracts now accept `ProviderHeaders`, preserving `null`
  deletion markers through registry and provider-request transforms.
- Concrete compact-endpoint and WebSocket request construction remains the boundary that materializes final
  wire headers.

### Why

- Upstream widened provider headers so a later layer can explicitly remove an inherited header. String-only
  structural types introduced during merge resolution either failed compilation or silently discarded those
  deletion markers before the canonical request boundary.

### Why an extension could not handle it

- These types bridge the builtin compaction route directly to the model registry and stream runtime. An external
  extension cannot recover a deleted marker after this private structural boundary has narrowed it away.

### Expected merge-conflict zones

- MEDIUM: `speculative.ts`, `openai-remote.ts`, and `openai-remote-responses-v2.ts` auth option shapes.

## Retry transient blocking summarization failures (2026-08-12)

### What changed

- `speculative.ts` now runs the summarization request inside `retryTransientCall` from `@earendil-works/pi-ai`, with
  the budget in the new `summarization-retry.ts` (3 retries, 1s base delay, 60s total wall-clock bound).
- The provider `error` stop is raised INSIDE the retried producer, so a transient failure spends the retry budget.
  Overflow shrinking and abort handling stay in the surrounding loop and are never answered by replaying a request.
- Retry is limited to `core-route` and `blocking` snapshot origins. The speculative warm-up keeps `idle-retry.ts`,
  whose idle/breaker/threshold guards are re-evaluated between attempts against live session state, and a failed warm
  job stays inheritable so the next blocking route degrades on it instead of paying for a second request.
- `isRetryableSummaryAttempt()` refuses every class that has a deterministic zero-LLM recovery: watchdog timeouts,
  `upstream-stream-truncated`, and overflow exhaustion are rebuilt for free by the required-compaction fallback. Those
  classes are mirrored from `classifyRequiredCompactionFallbackFailure` rather than imported, because
  `deterministic-fallback.ts` imports this module.
- Exhaustion is unchanged externally: one `compaction_end` carrying the verbatim upstream message and exactly one
  circuit-breaker failure, not one per attempt.

### Why

- The core `compact()` route already retries summarization through `completeSummarization` with
  `SettingsManager.getRetrySettings()`, but the extension route had no retry at all. A real session on 2026-08-12 hit
  an upstream Cloudflare Worker OOM (`500 Worker exceeded memory limit.`, 28ms round trip, 471,441 tokens) and the
  route reported `willRetry:false` on attempt one, even though `isTransientSummarizationFailure` already classified
  that message as transient.
- The wall-clock bound exists because one attempt may hold the session for
  `DEFAULT_SUMMARIZATION_MAX_DURATION_MS` (120s); replaying a slow failure would stack deadlines, which is the freeze
  the budget and the speculative-handoff degrade path exist to prevent.

### Why an extension could not do this

- This is the builtin extension's private summarization request path. `ExtensionContext` exposes no retry-policy
  accessor, and no external extension can wrap another extension's in-flight summary generation.

### Expected merge-conflict zones

- MEDIUM: `speculative.ts` inside `runExtensionCompaction`'s request loop and its import block.
- LOW: `summarization-retry.ts` is new and fork-owned.
- LOW: blocking-route tests that express attempts against `MAX_SUMMARIZATION_ATTEMPT_RETRIES`.

## Regenerate after a warm summary goes stale (2026-08-09)

### What changed

- `applyBlockingCompaction()` now discards a stale warmed speculative result and falls through to fresh core-route summary generation while retaining the active compaction feedback signal.
- Applied warm results remain terminal, rejected results retain their existing feedback restart, and the `speculative_stale` debug event remains unchanged.
- The separate OpenAI remote blocking generation-race branch is intentionally unchanged: that path owns and advances its generation directly, while this fix targets idle/speculative warm-summary consumption after an external message-revision bump.

### Why

- Idle warm-up snapshots pin the current message revision. A hidden extension message, bash update, model reselection, tool-set change, or other idle revision bump can make the completed warm summary stale before the next threshold-triggered blocking compaction.
- Treating that stale result as terminal ended feedback as "Compaction did not apply" without reducing context, so repeated warm/stale cycles let the context keep growing. A blocking route is running because the current session requires compaction and must regenerate against current state.

### Why an extension could not do this

- This is the builtin compaction extension's private warm-job consumption and feedback lifecycle; an external extension cannot replace its in-flight speculative job or continue its blocking route.

### Expected merge-conflict zones

- `index.ts` inside `applyBlockingCompaction()` around pending speculative-job result handling.
- `test/compaction/stale-warm-blocking-repro.test.ts` is focused regression coverage for this path.

## Remove the fatal per-turn compaction soft cap (2026-08-05)

### What changed

- `per-turn-cap.ts` no longer exports `softCap`/`isOverSoftCap`; `shouldRejectByCap()` takes only the
  state and rejects solely on the absolute session cap (`hardCap = 10` accepted compactions).
- The manual/extension bypass options were removed together with the soft cap: below the absolute cap
  there is nothing left to bypass, and the absolute cap already bound every route since 2026-08-03.
- The `session_before_compact` cap rejection keeps the historical `rejectionCause: "per-turn-cap"`
  identifier for extension-API stability but now reports `absolute compaction cap reached for this
  session` and logs `acceptedAbsolute` instead of the per-turn counter.
- Turn-end zero-yield recovery is admitted again after ineffective attempts (bounded by the absolute cap
  and the circuit breaker) instead of being starved by the combined per-turn counter.
- `acceptedThisTurn`/`ineffectiveAttemptsThisTurn` remain in state as per-turn observability counters and
  still reset on `turn_end`/`agent_end`.

### Why

- The soft cap counted accepted + ineffective compactions per turn and rejected required
  (overflow/blocking) compactions once it reached 3. A long tool-heavy turn that legitimately needed a
  fourth compaction had its required compaction rejected, fatally ending the turn. First reported and
  attempted in [#728](https://github.com/code-yeongyu/senpi/pull/728) by @realsigridjin; this entry lands
  the same intent with the changelog/docs/QA gates satisfied.
- Runaway protection is preserved by the absolute session cap (10) and the failure circuit breaker.

### Why an extension could not do this

- Cap admission runs inside the builtin compaction extension's own `session_before_compact` and blocking
  routes; an external extension cannot override another extension's cancel decision.

### Expected merge-conflict zones

- `per-turn-cap.ts` (whole file), `index.ts` around the `session_before_compact` cap check, and the cap
  tests under `test/compaction/`.

## Treat caller-aborted summary stream failures as cancellation (2026-08-03)

### What changed

- `runExtensionCompaction()` now converts a summary-generation rejection to the existing
  `undefined` cancellation result when its caller signal has been aborted.
- Non-abort stream and provider failures are still rethrown unchanged.
- A focused regression test reproduces the late stream-result rejection seen after ESC and
  separately proves an ordinary stream failure remains visible.

### Why

- The compaction watchdog can stop waiting as soon as ESC aborts the caller signal, while the
  provider stream's final result rejects a moment later with
  `Assistant message stream consumption was cancelled`.
- That late rejection escaped the documented `runExtensionCompaction()` cancellation contract,
  causing the builtin extension runner to print an error and stack trace after the normal
  `Auto-compaction cancelled` notice.

### Why an extension could not do this

- This is the builtin compaction extension's own summary-stream consumption boundary. No external
  extension hook can intercept the private stream result before `runExtensionCompaction()` returns
  to the extension runner.

### Expected merge-conflict zones

- `speculative.ts` around `runExtensionCompaction()` and its call to `generateSummaryMessage()`.
- Compaction stream cancellation tests under `test/compaction/`.

## Reset the cap per provider turn and retain a safe deterministic suffix (2026-08-03)

### What changed

- `turn_end` now resets the soft compaction counters after the completed turn's degradation and
  zero-yield recovery checks. `agent_end` keeps its existing final reset, and the absolute session cap
  is checked before every manual, extension, or automatic route.
- Deterministic required recovery projects the exact post-compaction context and ignores cumulative
  assistant usage that refers to the discarded prefix.
- The fallback prefers the prepared boundary, then tries the latest meaningful persisted user boundary
  once and retains every following message in order.
- Recovery remains fail-closed for oversized suffixes, images, provider-native blocks, opaque replay
  signatures, branch summaries, malformed message envelopes or known block schemas, and empty or
  default-ignorable user boundaries.

### Why

- The previous “per-turn” counter lasted for an entire multi-tool agent run, so the fourth valid
  compaction was rejected even after three separate provider turns.
- A loaded skill is ordinary user text, but stale assistant usage could make that small suffix appear
  larger than the input cap, and the fallback had no later safe boundary to try.

### Why this cannot be expressed externally

- The behavior depends on builtin lifecycle state, canonical session reconstruction, and internal
  replay-safety metadata.

### Expected merge conflict zones

- `index.ts` `turn_end`/`agent_end` lifecycle accounting and blocking-compaction admission.
- `deterministic-fallback.ts` retained-suffix projection and metadata.
- `retained-message-safety.ts` normalized replay-envelope and content validation.

## Idle warm-up retries transient failures while the session stays idle (2026-08-03)

### What changed

- New `idle-retry.ts`: pure retry policy (`shouldRetryIdleWarmup`, `MAX_IDLE_WARMUP_RETRIES` = 2,
  `IDLE_WARMUP_RETRY_DELAY_MS` = 15s). A retry requires: transient failure, session still idle, breaker
  untripped, context still over the soft threshold, attempts under the cap.
- `index.ts` `agent_end` idle trigger arms a watcher on the warm job's `failure` promise. On a transient
  failure it schedules a delayed re-warm that invalidates the dead job and starts a fresh speculative
  snapshot (fresh message revision), then re-arms. Every path is fenced on the observed job reference,
  `ctx.isIdle()`, and a `before_agent_start` cancel, so a prompt or newer warm-up stands the watcher down.
- Retries log `idle_trigger` with `count` = attempt number.

### Why

- Since #561 the idle trigger only warms (apply is deferred to the next prompt). A transient summarization
  failure (stream stall, wall-clock budget, 429) left a dead warm job for the whole idle period, and the
  next prompt paid a full blocking summarization - or an outright failed compaction - on the user's
  critical path (2026-08-03 incident: visible "Compacting context..." stall at message time).

### Why not an extension

- This IS the builtin compaction extension.

### Merge-conflict zones

- `index.ts` around the `agent_end` idle trigger and the `before_agent_start` entry; `idle-retry.ts` is
  fork-owned.

## Compaction log actually writes; idle_trigger enters the allowlist (2026-08-03)

### What changed

- `getLogger` reads the typed `ctx.agentDir` that core now provides instead of casting for a property that
  never existed, so `logs/compaction.log` is written for the first time since the logger shipped.
- `log.ts` EVENTS allowlist gains `"idle_trigger"`; the type union already declared it, so every idle warm-up
  decision was silently dropped by the `EVENTS.has(event)` guard even with a live logger.

### Why

- The 2026-08-03 incident (session 019fc4cb, gpt-5.6-sol-fast at 63% of a 372k window) could not be diagnosed
  from logs: no compaction.log existed anywhere on the machine and the idle trigger had no logging path at all.

### Why not an extension

- This IS the builtin compaction extension; the missing context field was a core seam gap fixed via the
  public `ExtensionContext` contract (see `../../changes.md`).

### Merge-conflict zones

- LOW: `index.ts` `getLogger` definition; `log.ts` EVENTS set.

## Bounded summarization overflow retries (2026-08-03)

### What changed

- New `overflow-retry.ts`: the summarization overflow-retry policy extracted from `speculative.ts`.
  `MAX_SUMMARIZATION_OVERFLOW_RETRIES` (3), `SUMMARIZATION_OVERFLOW_TOTAL_BUDGET_MS` (240s across
  retries), `SUMMARIZATION_INPUT_BUDGET_RATIO` (0.6 of the window), `SummarizationOverflowExhaustedError`,
  `boundSummarizationInput` (pre-sizes the summarization input, prompt-token aware), and
  `shrinkSummarizationInputForOverflowRetry` (halves the estimated input per retry instead of dropping
  one history item, keeping the drop-oldest fallback when every message sits at the turn boundary).
  The old-message pruning helpers moved here unchanged.
- `speculative.ts` `runExtensionCompaction`: pre-sizes the summarization input before the first billed
  attempt and bounds the overflow-retry loop by attempt cap and cumulative wall-clock budget; exhaustion
  throws the typed error instead of looping or falling through a generic `Error`.
- `deterministic-fallback.ts` classifies the exhaustion as `summarization-overflow-exhausted`, so
  required compaction degrades to the deterministic fallback; `transient-failure.ts` treats it as a
  transient lane failure so the circuit breaker records it and the next run starts pre-sized.

### Why

- Issue #650: on openai-codex/gpt-5.6-sol a blocking compaction wedged for ~48 minutes on
  "Compacting...". The retry loop removed exactly one history item per FULL billed summarization attempt
  with no attempt cap, no cumulative budget, and no session.log evidence; the summarization input itself
  was unbudgeted (only tool results were pruned), so a session whose provider-side input exceeded the real
  window drew an overflow verdict on every completed attempt. Observed cost: ~13.5M tokens for a
  compaction that never landed; ESC was the only exit.

### Why not an extension

- This IS the builtin compaction extension; the bound belongs in the retry policy itself.

### Merge-conflict zones

- LOW: `speculative.ts` around `runExtensionCompaction`; `overflow-retry.ts` is fork-owned.

## Session-log visibility for compaction start (2026-08-03)

### What changed

- `core/agent-session.ts` `_logSessionEvent` mirrors `compaction_start` (reason only) into
  `logs/session.log`; previously only `compaction_end` was mirrored, so a wedged compaction left zero
  log evidence for its entire lifetime (issue #650).

### Merge-conflict zones

- LOW: `_logSessionEvent` early-return chain.

## Lane-policy hardening: prune stand-down, live resumeMode, boundary ledger (2026-08-01)

### What changed

- `hardLimitEmergencyPrune` now stands down when `lanePolicy.disablesSenpiCompaction(ctx)` is true, matching the
  reduction-lane gate: destructively pruning the provider context near the hard limit would break the resident
  claude-sdk-oauth session's continuity the same way the gated reduction lane would.
- `disablesSenpiCompaction` keeps the per-cwd `resumeMode` cache (the intended contract pinned by
  `lane-policy.test.ts`); a mid-session mode switch takes effect on the next cwd or session.
- SDK `compact_boundary` messages are converted into ledger entries in the lane-policy collector so native
  compactions are recorded instead of discarded.

### Why

Cubic review on PR #637: the prune path defeated the claude-sdk-oauth stand-down, and native compact_boundary
events never reached the ledger. (The cached-resumeMode concern was assessed against the pinned per-cwd contract
and left as intended.)

### Why not an extension

These are corrections to the lane-policy gate itself, not new behavior an extension could provide.

### Merge-conflict zones

- `index.ts` (prune gate), `lane-policy.ts` (resumeMode read, boundary collection).

## SDK-native lane opt-out + one-shot checkpoint directive (2026-08-01)

### What changed

- New `lane-policy.ts`: provider-scoped opt-out for the `claude-sdk-oauth` main lane. When that provider is active and
  its `resumeMode` is not the `off` escape hatch, senpi's auto-compaction and context reduction stand down: the
  `before_agent_start` triggers (hard limit, threshold, speculative), the `agent_end` idle warm-up, the `turn_end`
  degradation recovery, the `model_select` warm-up, the degradation monitor, and the `context` reduction pass all skip,
  and a requested `session_before_compact` is cancelled with the reason "the Claude Agent SDK owns compaction for this
  session". `index.ts` only gained call-site guards and `context-reduction.ts` was not touched at all: the lane verdict
  feeds its existing `shouldApplyContextReduction({ isProviderNativeCompactionPath })` gate. All net-new logic lives in
  `lane-policy.ts`.
- `lane-policy.ts` also owns the mirrored SDK compaction boundary: a `compact_boundary` system message transported as the
  `claude_sdk_oauth_compact_boundary` assistant-message diagnostic is appended to the senpi session as a
  `claude-sdk-oauth-compact` custom entry (schema `senpi.claude-sdk-oauth.compact-boundary.v1`, storing the SDK
  `compact_metadata` verbatim) from the `message_end` hook, so SDK-native compactions stay visible in UI/history.

### INTENTIONAL cross-lane change: the checkpoint restoration directive is now one-shot

- **Before**: `before_agent_start` appended the restoration directive to the *system prompt* on EVERY request while the
  latest agent checkpoint was younger than 60s. N requests inside that window carried N copies, and the base system
  prompt was not byte-identical while the window stayed open (prompt-cache churn, repeated directive).
- **After**: the system prompt is never rewritten. The directive rides the existing one-shot hidden post-compact
  restoration message (`compaction.post-compact-restoration`, `display: false`) exactly once per checkpoint; when no
  restoration payload is pending, the directive is delivered as that message on its own. A checkpoint older than 60s
  still delivers nothing.
- This applies to ALL provider lanes, not just `claude-sdk-oauth`, and is a deliberate semantic change rather than a
  behavior-preserving refactor. Both sides are pinned:
  `test/compaction/checkpoint-directive-characterization.test.ts` states each pre-change behavior next to the assertion
  that replaced it (the pre-change run was captured green before the change), and
  `test/compaction-checkpoint-oneshot.test.ts` pins the one-shot delivery.

### Why

- The `claude-sdk-oauth` lane keeps one resident SDK session per senpi session and the Claude Agent SDK runs its own
  native auto-compaction over that transcript. Senpi compacting on top of it would rewrite a history senpi no longer
  owns. The opt-out is conditional on residency: with `resumeMode: "off"` senpi flattens its own history into every
  request, so its compaction must stay fully active there.
- Repeating the checkpoint directive on every request inside the 60s window bought nothing over delivering it once with
  the restoration payload, and it mutated the system prompt (the most cache-sensitive prefix) for up to a minute.

### Scope

- Senpi compaction remains FULLY active for every non-`claude-sdk-oauth` provider; that is pinned by the
  characterization block in `test/claude-sdk-oauth-compaction-alignment.test.ts`.
- Coverage: `test/compaction/lane-policy.test.ts`, `test/claude-sdk-oauth-compaction-alignment.test.ts`,
  `test/compaction-checkpoint-oneshot.test.ts`, `test/compaction/checkpoint-directive-characterization.test.ts`.

### Expected merge conflict zones

- MEDIUM: `index.ts` around the `before_agent_start`, `context`, `agent_end`, `turn_end`, `model_select`, `message_end`
  and `session_before_compact` hooks (call-site guards only).
- LOW: `checkpoint-state.ts` around `injectRestorationDirective` (kept for its legacy overloads) and the new
  `attachRestorationDirective`.

## Blocking compaction route guards (2026-08-01)

### What changed

- Blocking compaction routes reject unsupported states before attempting a compaction transition.

### Why

- Unsupported route/state combinations otherwise strand the session or apply compaction through the wrong lifecycle.

### Why this cannot be expressed externally

- The guards depend on built-in compaction state, route ownership, and session transition timing.

### Expected merge conflict zones

- `index.ts` blocking route selection and blocking-compaction route guard tests.

## Deterministic required-compaction recovery (2026-07-31)

- Required threshold/overflow recovery may synthesize one local checkpoint after a summarization watchdog or a transient `SummaryRequestError` carrying the structured `upstream-stream-truncated` failure kind, without issuing another provider request. Generic thrown text is never fallback authorization, even when it contains truncation-like markers.
- Recovery is accepted only with a real non-empty retained boundary whose fully reconstructed context fits the effective reserve budget (`contextWindow - resolveEffectiveReserveTokens(contextWindow, settings)`), including the exact cap boundary. Acceptance therefore uses the same scaled reserve as the hard-limit valve, so a recovered context can never be admitted only to be compacted again on the next request; `reserveScalingEnabled: false` keeps the configured reserve verbatim. An absent or unfit suffix cancels without appending a compaction entry or dropping the latest request.
- The checkpoint carries parsed or inherited task intent and a UTF-8-safe bounded prior summary. Todo and agent-checkpoint snapshots remain solely in their canonical custom entries persisted after acceptance, avoiding duplicate unbounded objects in compaction details. Manual, aborted, and unrelated failures remain fail-closed.
- Local summaries now persist parsed task intent and inherit it through subsequent local compactions while ignoring remote checkpoint metadata.
- Coverage: `test/compaction/required-compaction-deterministic-fallback.test.ts`, `test/compaction/task-intent-anchor.test.ts`, and the existing blocking/runtime-provider suites.

### Expected merge conflict zones

- MEDIUM: `index.ts` around `session_before_compact`; `speculative.ts` snapshot and summary result assembly.
## Idle compaction warms without committing a transcript boundary (2026-07-31)

### What changed

- The `agent_end` idle trigger now starts speculative summary generation instead of applying compaction immediately.
- The next `before_agent_start` consumes and applies the warmed result through the existing blocking-admission path.
- Issue #561 regression coverage pins normal idle and queued-follow-up idle behavior, plus the disabled control.

### Why

- A durable compaction entry created at idle could become the branch leaf before the next user prompt. If the context
  remained near the limit, the last-entry guard prevented normal pre-prompt compaction and later recovery could place
  another compaction after the fresh prompt, corrupting the apparent boundary and risking duplicate or lost intent.
- Summary generation remains off the user's critical path, while durable apply now happens only at the admission
  boundary that includes the pending prompt and existing staleness/overflow checks.

### Scope

- The change is isolated to the builtin extension's idle trigger. Core compaction preparation, abort ordering,
  queued-message ownership, and overflow recovery are unchanged.
- Expected upstream conflict zone: `builtin/compaction/index.ts` around the `agent_end` idle trigger.

## Runtime provider dispatch for summarization (2026-07-31)

### What changed

- `speculative.ts` dispatches the summarization request through `context.modelRegistry.modelRuntime.stream()` when a registry is present, and only falls back to the compat `stream()` when a `SpeculativeCompactionContext` is built without one.
- `openai-remote.ts` resolves its stream runner the same way (`resolveRemoteStreamRunner`): an injected `dependencies.streamRunner` still wins, otherwise the model runtime serves the native remote-compaction request and compat is the last resort.
- Summarization auth now accepts a credential request header as resolved auth instead of requiring an `apiKey`, so `headers`-authenticated providers (models.json `headers`, extension `headers`) can compact.
- Issue #543 regression coverage: `test/suite/regressions/543-compaction-runtime-provider.test.ts` (runtime-only api id, plus a header-authenticated provider) and `test/suite/regressions/543-remote-compaction-runtime-provider.test.ts` (native remote route through the runtime).

### Why

- Providers registered through `pi.registerProvider()` (builtin `claude-agent-sdk`, extension providers such as `senpi-accounts`' Kiro) never land in compat's builtin api-registry, so every compaction attempt failed with `compaction generator failed: No API provider registered for api: <api>` while normal agent turns on the same model worked. Same bug class as #488 for `/btw`.
- The two follow-on holes had the same shape: a provider that senpi considers fully authenticated and fully routable for normal turns must be equally compactable. A header-only credential resolved `{ok: true, apiKey: undefined}` and died as "credentials unavailable"; an extension `openai-responses` proxy opting into `supportsRemoteCompactionV2` had its own transport bypassed on the remote route.

### Merge-conflict zones

- `speculative.ts` import block, the single `stream(...)` call site in `generateSummaryMessage`, and the auth guard at the top of `runExtensionCompaction`.
- `openai-remote.ts` `OpenAiRemoteCompactionContext.modelRegistry` shape plus the two stream-runner defaults.

## Proactive idle compaction (2026-07-30)

### What changed

- Added a proactive idle-time compaction trigger. When the agent finishes a turn (`agent_end`) and the context is over the soft threshold (`policy.shouldTriggerCompaction`), the extension runs the full compaction now via `applyBlockingCompaction` so the next user message starts without compaction latency. The handler awaits the compaction — unlike `turn_end`'s fire-and-forget ineffective-recovery — so the context is fully compacted before the next `before_agent_start`.
- Guards: skipped when the run will auto-continue (`willRetry`), was aborted, when the circuit breaker is tripped, in one-shot modes (`print`/`json`), or when `idleCompactionEnabled` is false.
- New pure module `idle.ts` (`shouldRunIdleCompaction` predicate + `IDLE_COMPACTION_INSTRUCTIONS`); `index.ts` only wires it. New setting `compaction.idleCompactionEnabled` (default `true`) on both `CompactionSettings` interfaces. New logger event `idle_trigger`. New fixture #14 `idle-trigger/over-threshold-at-idle.jsonl`.
- Expected merge-conflict zones: `compaction/index.ts` `agent_end` handler; `core/compaction/compaction.ts` `CompactionSettings` + `DEFAULT_COMPACTION_SETTINGS`; `settings-manager.ts` local `CompactionSettings` + `getCompactionSettings()` return.

## Plugsuits wave1: observability, ineffective-cap, task-intent anchor (2026-07-29)

### What changed

- `summary.v1` now carries an origin marker in `details.origin`, and compaction logging is always on via `compaction.log`; when `SENPI_COMPACTION_DEBUG` is enabled, the same log stream is mirrored to stderr for local debugging.
- Structural yield is now embedded at generation time in `details.structuralYield`, so the accept/reject path no longer has to reconstruct it later. The ineffective predicate is `savedTokens < 1024 || ratio < 0.10`; would-overflow attempts count toward the per-turn cap, while breaker and accepted-result semantics stay unchanged.
- Task intent is now anchored across compaction by extracting it, persisting it, and reinjecting it into the post-compaction prompt. The baseline is Claude, with a terse GPT preset for the compact form.

### Why

- These changes make compaction behavior observable and debuggable without changing the underlying acceptance semantics, and they preserve intent through compaction so follow-up turns stay grounded.

### Expected merge conflict zones

- `index.ts` around logger/origin/cap wiring.
- `speculative.ts` around `structuralYield`/taskIntent extraction.
- `prompts.ts` around PASS-1/family selection.

## Degrade wall-clock budget trips like stalled streams (2026-07-28)

### What changed

- `transient-failure.ts` (new): `isTransientSummarizationFailure()` owns the degrade-vs-surface decision.
  Watchdog trips (`StreamDurationBudgetError`, `StreamIdleTimeoutError`) always degrade; `SummaryRequestError`
  keeps its metadata-aware verdict; everything else falls back to `isRetryableErrorMessage`.
- `index.ts` `applyBlockingCompaction()`: uses that predicate instead of the inline classification, so a
  summarization that blows its wall-clock budget records a circuit-breaker failure and returns
  `{ applied: false, reason: "failed" }` rather than escaping to the ExtensionRunner as a raw stack on top of the
  `compaction_end` message the user already saw.
- Behavior change for the pre-existing stall path: `StreamIdleTimeoutError` now degrades the same way. Its message
  ("Summarization stream stalled: ... treating the request as dead") matches none of the transient patterns in
  `isRetryableErrorMessage`, so before this change a stalled summarization rethrew loudly - the exact double-surface
  the 2026-07-27 transient-degrade entry removed for network drops. Both watchdog trips are infrastructure slowness
  and are pinned as transient in `test/compaction/summarization-budget-degrade.test.ts`.
- `speculative.ts`: the speculative request path applies `DEFAULT_SUMMARIZATION_MAX_DURATION_MS`, so a warm-start
  summary that a blocking route later awaits cannot pin the session either.

### Why

- Without the budget the freeze class described in `core/compaction/changes.md` (2026-07-28) reached the session
  queue; with it, the trip has to land in the same quiet degrade path the transient-transport work established, or
  the fix would trade a freeze for a loud extension error.

### Also in this change

- `index.ts`: a blocking route that inherits a speculative job whose summary failed now degrades through the shared
  watchdog-failure path on that job instead of discarding it and paying for a second full-budget request. The job
  keeps its settled failure next to its result promise, so the double deadline the reviewer flagged cannot recur.
- `test/compaction/speculative-budget-handoff.test.ts`: pins the no-second-request guarantee end to end (fails as
  `SummaryRequestError: No more faux responses queued` from `applyBlockingCompaction` when the handoff is reverted).

### Expected merge conflict zones

- LOW: `index.ts` around the `applyBlockingCompaction()` catch classification.
- LOW: `speculative.ts` around the `consumeStreamWithIdleTimeout` options.

## Explicit Responses v2 compaction for verified proxies (2026-07-27)

- `openai-remote-model.ts`: official OpenAI remains eligible by default; custom `openai-responses` providers require `compat.supportsRemoteCompactionV2: true`. Persisted checkpoint identity now retains the exact custom provider id instead of coercing it to `openai`.
- `openai-remote-responses-v2.ts`: native compaction sends a standard Responses request with a `compaction_trigger` input item and the `remote_compaction_v2` beta capability header. A returned native `compaction` item becomes the durable checkpoint replacement.
- Existing WebSocket, legacy compact-endpoint, and local-summary paths remain ordered fallbacks. Endpoint and auth-tenant provenance checks remain mandatory for replay.

## Portable low-cost reasoning for compaction summaries (2026-07-27)

- `speculative.ts`: compaction summarization now starts at `low` instead of forcing `minimal`. Some OpenAI-compatible gateways expose stale or narrower capability metadata and reject `minimal` even when the local model map advertises it; `low` is the lowest portable effort across those endpoints.
- The selector still falls upward through `medium` and `high`, respects explicit `null` unsupported entries, disables Anthropic thinking, and omits the override when no low-cost level is available.
- Regression coverage exercises OpenAI Responses and Completions models that advertise both `minimal` and `low`, plus a model with every low-cost level explicitly disabled.

## Canonical remote compaction provenance and route ownership (2026-07-24)

- `openai-remote-model.ts`: provenance now hashes the normalized endpoint and every final header by default. The only excluded volatile transport headers are `content-length`, `user-agent`, `request-id`, `x-request-id`, and `x-client-request-id`; raw values are never persisted. This binds non-Codex checkpoints to authorization plus final tenant/workspace routing headers.
- Codex checkpoints instead bind to the JWT-derived `chatgpt-account-id` and every other final non-volatile header, deliberately excluding only the rotating `authorization` bearer value. Codex remote compaction now applies normal Responses header ordering: extension header transforms first, then configured authorization/account, originator, user agent, beta, and session/cache-affinity fields.
- `agent-session.ts`: each compaction execution now proves its explicit auto/manual route controller still owns the operation before beginning lifecycle state. An auto compaction superseded during async auth admission publishes no lifecycle events and cannot disturb the newer manual operation.
- Regressions: `test/compaction/canonical-routes.test.ts`, `test/suite/regressions/issue-296-openai-codex-remote-compaction.test.ts`, and `test/suite/compaction-race.test.ts` cover header routing differences, refresh-stable Codex account provenance, canonical override repair, and auth-admission supersession.

## Replay remote checkpoints from final context payloads (2026-07-24)

- `openai-remote.ts`: replay proves the checkpoint boundary by projecting the compaction-aware session prefix through
  the same OpenAI Responses converter used by the real provider request, then requiring the final payload prefix to
  match item-for-item. It only replaces a proven prefix; a context hook that inserts, removes, reorders, or changes a
  checkpoint item declines native replay and sends the final transformed full payload unchanged. The post-checkpoint
  suffix, including the in-flight prompt, always comes directly from that final payload and is never reconstructed
  from persisted raw messages.
- `openai-remote.ts`: both the direct compact endpoint and WebSocket route validate the final
  `before_provider_request` replacement as an OpenAI compact body. Invalid replacements emit
  `remote_fallback` with `invalid-compact-request-payload` and are rejected before transport, never retried with the
  pre-hook payload.
- Regressions: `test/compaction/canonical-routes.test.ts` covers a context hook that changes prefix cardinality and
  confirms final-payload fallback, while `test/compaction/openai-remote-compaction.test.ts` covers invalid downstream
  compact request replacements, final-payload redaction, and native/mixed-history provenance. The Codex regression
  exercises the same proven-prefix replay path.
- Repeated checkpoints project their prefix through the same compaction-aware branch view as normal session context,
  excluding superseded older summaries before canonical Responses conversion.
- Non-remote summarization runs context hooks on raw `AgentMessage` values before `convertToLlm`, preserving
  role/customType-based redaction contracts while leaving persisted messages byte-identical.
- Remote checkpoint provenance now records normalized endpoint/trust-domain identity plus a SHA-256 fingerprint of the
  effective auth tenant (never raw credentials). Legacy, cross-endpoint, or cross-tenant entries decline replay.
- Replay boundaries require non-enumerable message/item provenance to survive the canonical context pipeline. Missing,
  duplicated, reordered, reconstructed, or mutated provenance keeps the final transformed full payload unchanged.

## Degrade transient blocking-compaction failures instead of erroring the turn (2026-07-27)

- `index.ts` `applyBlockingCompaction()`: when the summarization request fails with a transient
  transport/provider error (classified by `isRetryableErrorMessage` from `@earendil-works/pi-ai`), the catch
  no longer rethrows. It still ends compaction feedback with `Compaction failed: <message>`, then records a
  circuit-breaker failure and returns `{ applied: false, reason: "unavailable" }`. Previously a network drop
  during blocking compaction (`before_agent_start` hard-limit/proactive routes, degradation-monitor recovery)
  escaped to the ExtensionRunner, which printed `Extension "<builtin:compaction>" error: Connection error.`
  plus a raw stack on top of the compaction_end message - two surfaces for one outage - while the turn's own
  provider request was about to report the same outage a third time through the normal retry path. Matches
  Claude Code (swallow + consecutive-failure breaker), Codex (single structured error event, session stays
  usable), and oh-my-pi (emit errorMessage, no rethrow). Non-transient failures (policy refusals, real bugs)
  still rethrow; `SummaryGenerationError` and user-abort paths are unchanged.
- `index.ts` `before_agent_start`: while the breaker cools down, the proactive blocking route and speculative
  warm start are skipped so an offline session does not pay a doomed summarization request on every prompt.
  The hard-limit emergency route still attempts unconditionally.
- Review hardening: transient failures now return `{ applied: false, reason: "failed" }` (new
  `SpeculativeCompactionResult` member) so `degradation-monitor.ts` can suppress the recovery notification
  for a failure that already surfaced its own compaction_end errorMessage; `unavailable` results keep
  notifying. The `model_select` window-shrink route also skips speculative warm starts while the breaker
  cools down. Provider `error` stops throw `SummaryRequestError` carrying `isRetryableAssistantError`'s
  metadata-aware verdict, so a refusal whose text looks retryable still surfaces loudly instead of being
  string-classified as transient.
- Tests: `test/compaction/blocking-compaction-network-degrade.test.ts` (transient degrade with a single clean
  errorMessage surface, breaker skip during cooldown, non-transient loud rethrow pin, credential-failure
  degrade pin) and `test/compaction/blocking-compaction-review-hardening.test.ts` (refusal metadata, breaker
  gating of model_select warm starts, blocking abort/empty-summary pins, recovery-notification suppression),
  sharing `test/helpers/blocking-compaction-harness.ts`.

Expected upstream conflict zones: `builtin/compaction/index.ts` around the `applyBlockingCompaction` catch
block and the `before_agent_start` route selection; LOW on `packages/ai/src/utils/retry.ts` exports.

## Reasoning-free summarization + shrink warm start (2026-07-26)

- `speculative.ts` `generateSummaryMessage` now merges `summarizationReasoningOptions(model)` into the stream
  options: `thinkingEnabled: false` for anthropic-messages and the cheapest catalog-supported effort for the
  OpenAI Responses/Completions families (minimal when legal, otherwise low/medium/high), with reasoning summaries
  disabled for Responses. Summarization requests previously inherited each provider's *default* reasoning mode;
  a hard-coded `minimal` also disappeared at adapter resolution on catalog rows where `minimal: null`, restoring
  that default. Both cases burned latency and output budget on invisible thinking before emitting the summary.
  Codex now sends `summary: "off"` while direct/Azure Responses omit the summary field; non-reasoning models are
  untouched.
- `index.ts` `model_select`: on a context-window shrink (e.g. 1M -> 256k) with usage already over the new
  window's speculative threshold, the handler now starts a speculative compaction at switch time. Previously
  nothing ran until the next turn, so the first request to the smaller-window model could overflow, surface the
  raw provider error, and only then recover. The warm-started job also lets the next turn's blocking compaction
  await a finished summary instead of generating one while the user waits.
- Duplicate `model_select` delivery for the same selected model reuses the in-flight/finished speculative job
  instead of aborting it and launching a second summary.
- Tests: `test/compaction/summarization-reasoning-options.test.ts` (per-API options),
  `test/compaction/summarization-reasoning-payload.test.ts` (final OpenAI/Codex/Azure/Kimi payloads), and
  `test/suite/model-shrink-speculative-warmstart.test.ts` (threshold start plus duplicate-event idempotency).

Expected upstream conflict zones: `builtin/compaction/speculative.ts` around the stream options in
`generateSummaryMessage`, and `builtin/compaction/index.ts` around the `model_select` handler.

## Active-tool-only summarization requests (2026-07-23)

- `index.ts`: direct local summarization requests now map the current active tool names to registered definitions.
  Inactive registered tools, including inactive MCP catalog entries, no longer consume remote compaction payload
  budget or appear as callable tools to the summarizer.
- Applied speculative summaries carry their handler's feedback signal, allowing core to reject a superseded apply
  before durable session mutation.

Expected upstream conflict zones: `builtin/compaction/index.ts` tool snapshot construction and
`builtin/compaction/speculative.ts` apply path.

## Session-owned compaction completion state (2026-07-23)

- AgentSession now records compaction as `idle`, `running`, `completed`, `failed`, or `aborted` with a monotonic
  generation and operation identity.
- Compaction snapshots the current AgentSession model at operation start. If main-thread retry fallback selected a
  different model, that active model performs compaction; there is no compaction-specific fallback policy.
- Extension feedback starts the same operation before summary generation and carries its abort signal through
  progress, application, and terminal feedback.
- Stale or duplicate terminal events cannot overwrite a newer compaction operation.
- Durable append is guarded by the current operation and controller identity.
- Required compaction remains fail-closed when generation or application fails, including provider-confirmed overflow
  that the local token estimate places below the configured threshold; rejected recovery restores the overflow
  context so a later prompt cannot bypass the same requirement.

Expected upstream conflict zones: `agent-session.ts` around compaction execution, abort handling, and status access;
`core/compaction/lifecycle.ts`.

## Sanitize Anthropic tool pairs on direct summarization requests (2026-07-23)

- `speculative.ts`: local compaction summarization now applies the existing Anthropic payload sanitizer at the direct
  `stream()` boundary. Unlike normal agent turns, this side request does not run the extension runner's
  `before_provider_request` hooks, so an orphan `tool_result` that survived message conversion previously reached
  Anthropic unchanged and permanently rejected compaction for an over-limit session.
- Regression: `test/compaction/anthropic-tool-pair-guard.test.ts` drives the real Anthropic wire adapter against a local
  endpoint that rejects orphan results, proving the summarization request is valid before it leaves senpi.

Expected upstream conflict zones: `builtin/compaction/speculative.ts` direct summary stream options.

## Support native remote compaction for OpenAI Codex models (2026-07-23)

- `openai-remote-model.ts`, `openai-remote-schema.ts`, `openai-remote.ts`, `openai-remote-convert.ts`,
  `index.ts`: native remote compaction now treats `openai-codex` / `openai-codex-responses` as a supported
  provider capability.
  Codex compaction uses the ChatGPT backend's `/codex/responses/compact` route with OAuth Bearer auth,
  the JWT-derived `chatgpt-account-id`, Codex session/window identity headers, the Responses beta flag,
  and `originator: senpi`. The compact parser accepts Codex's output-only JSON response while retaining
  strict direct-OpenAI response validation.
- Codex OAuth remote compaction is restricted to the canonical ChatGPT origin and loopback QA/proxy
  origins, preventing OAuth bearer tokens and conversation history from being sent to arbitrary remote
  custom URLs. Persisted replacement history is replayed only when its provider/API identity exactly
  matches the current model family.
- Persisted remote-compaction details retain the paired provider/API identity so the next Codex request
  replays the encrypted compaction item and in-flight prompt through the existing payload rewrite hook.
  Direct `openai` / `openai-responses` endpoint and WebSocket behavior remains unchanged.
- Regressions: `test/suite/regressions/issue-296-openai-codex-remote-compaction.test.ts` and
  `test/suite/regressions/issue-296-openai-codex-remote-compaction-boundaries.test.ts`.

## Preserve the in-flight prompt in remote-compaction payload replay (2026-07-22)

- `index.ts`, `openai-remote.ts`, `openai-remote-convert.ts`: the `before_provider_request` replay after a
  remote compaction rebuilt the payload from the persisted branch only. The in-flight user prompt is not yet
  persisted at that point, so the replayed payload silently dropped it — the model never saw the first message
  after a remote compaction. The `context` handler now stashes the not-yet-persisted tail messages
  (`pendingProviderMessages`) and the rewrite appends their conversion after the branch-derived items.
  Pre-existing on main; surfaced by the mixed-history e2e QA scenario.
- Tests: `test/compaction/openai-remote-compaction.test.ts` (pending-prompt rewrite case) and
  `.agents/skills/senpi-qa/scripts/compaction-remote-qa.mjs` (asserts the post-compaction payload carries the prompt).

Expected upstream conflict zones: `builtin/compaction/index.ts` context/provider-request handlers,
`builtin/compaction/openai-remote.ts` payload rewrite.

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

## 2026-07-28 - Emergency-prune hysteresis (prompt-cache thrash)

### What changed
- `speculative.ts`: added `EMERGENCY_CONTEXT_RELEASE_RATIO` (0.85) alongside the existing
  `EMERGENCY_CONTEXT_TARGET_RATIO` (0.95), plus `EmergencyPruneLatch` / `createEmergencyPruneLatch()`.
  `hardLimitEmergencyPrune(messages, contextWindow, latch?)` now takes an optional latch: once the prune
  engages it stays engaged until the estimate falls below the release ratio. Called without a latch the
  function keeps its exact previous single-threshold behaviour, so existing callers and tests are unaffected.
- `index.ts`: the compaction extension owns one latch per instance (per session) and passes it at the
  `context` hook call site.

### Why
A session parked near the emergency threshold alternated between the pruned and un-pruned history on
consecutive requests. Because pruning rewrites old tool results, every alternation changed the message
prefix and invalidated the provider prompt cache. Measured on a real session (`quotio-openai/gpt-5.6-sol-fast`,
372k context): `cacheRead` collapsed from ~263,000 to the 39,424-token head on 23 turns in 13 minutes,
re-billing ~226K tokens per turn at $10/M instead of $1/M — about $44 wasted in a single session. A sibling
session on the same gateway and model in the same minutes had zero misses, isolating this to the prune toggle.

### Scope
Only *when* the prune disengages changes; what gets pruned and the `needsAggressiveCompaction` signal are
untouched. Expected upstream conflict zones: `builtin/compaction/speculative.ts` around
`hardLimitEmergencyPrune`, and `builtin/compaction/index.ts` around the `context` hook.

## 2026-08-29

- Integrated ideal-compaction policy primitives into builtin event wiring: scaled reserve tokens, explicit speculative lead tokens, grace-band deferral, idle warm-floor refresh and stale warm invalidation.
- Added optional settings for grace-band deferral, tool-result admission, context reminders, reserve scaling, and a configured speculative lead override; all feature gates default to enabled.
- Tool results exceeding the admission cap are spilled to `os.tmpdir()/senpi-tool-spill` and represented by bounded excerpts, with marker-aware re-admission bypass.
- Context reminders are delivered through the existing `before_agent_start` custom-message return seam and reset after accepted compaction. Breaker trips retain deterministic context reduction rather than leaving the context untouched.

## 2026-08-30 - External lane ownership survives the circuit breaker

### What changed

- `index.ts` `session_compact`: a rejection carrying `rejectionCause: "external-owner"` returns before `breaker.recordFailure()`. Every other rejection cause still debits the breaker exactly as before. The cause is read off the event, so the lane policy is not re-consulted and no additional provider-settings read is paid.
- `context-pipeline.ts`: the breaker's deterministic context-reduction fallback is now `breakerFallback && !laneOwnsCompaction`. The reduction pass therefore stands down on an externally owned lane even when the breaker is tripped, narrowing the 2026-08-29 entry above: breaker trips retain deterministic reduction only on lanes senpi owns.

### Why

- Senpi declining to compact an SDK-native lane is a policy stand-down, not a senpi failure. Debiting the breaker for it tripped senpi's own health accounting on a perfectly healthy session after three ordinary turns.
- Once tripped, `breakerFallback` short-circuited ahead of `shouldApplyContextReduction()`, whose `isProviderNativeCompactionPath` gate already stands reduction down for owned lanes. That let senpi rewrite a history the Claude Agent SDK owns — the exact thing `lane-policy.ts` exists to prevent. The two guards are independent because a breaker tripped by earlier senpi-owned failures must still stand down once the session moves onto an SDK-native lane.

### Why an extension could not handle it

- Both the breaker counter and the context-reduction fallback are private state of the builtin compaction extension closure; no public hook observes a rejection cause before the debit or intercepts the reduction pass.

### Expected merge conflict zones

- LOW: `index.ts` around the `session_compact` rejected branch.
- LOW: `context-pipeline.ts` around the `sourceMessages` reduction predicate.
- Coverage: `test/compaction/external-owner-breaker-isolation.test.ts`.
