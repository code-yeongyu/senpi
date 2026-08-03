# Builtin compaction extension changes

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
- Recovery is accepted only with a real non-empty retained boundary whose fully reconstructed context fits `contextWindow - reserveTokens`, including the exact cap boundary. An absent or unfit suffix cancels without appending a compaction entry or dropping the latest request.
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
