# changes

## Absolute-cap compaction rejection message (2026-08-05)

- `describeCompactionRejection()` for `"per-turn-cap"` now reads "absolute compaction cap reached for
  this session." The cause identifier is unchanged for extension-API stability; only the per-turn soft
  cap was removed (see `extensions/builtin/compaction/changes.md`).
- Expected merge-conflict zone: `agent-session.ts` around `describeCompactionRejection`.

## Bound provider-timeout retry continuations (2026-08-05)

### What changed

- Provider stream/transport timeout retries keep the existing first-request
  option cap, including the rule that disabled ordinary stream guards stay
  disabled.
- A separate retry-continuation watchdog now uses the same positive
  `retry.provider.streamRetryTimeoutMs` budget to abort only the Agent run whose
  signal it captured. A later prompt or low-level takeover cannot be cancelled
  by the stale timer.
- Timeout option planning and watchdog ownership live in
  `provider-timeout-retry.ts`; the oversized `AgentSession` delegates instead of
  absorbing another retry responsibility.

### Why

- A transport error such as `Request timed out.` could start a retry while both
  ordinary stream guards were disabled. If that retry emitted no provider
  events, its detached continuation held the session work barrier and retry
  promise forever, leaving the interactive session visibly Working until the
  process restarted.
- Re-enabling user-disabled stream guards would mask the wedge by changing an
  intentional policy. The retry-owned watchdog supplies liveness without
  changing provider call options.

### Why this cannot be expressed externally

- Only `AgentSession` owns the retry promise, scheduled-continuation barrier,
  active Agent signal, and settled lifecycle. An extension cannot prove that a
  timer still owns the same retry run before aborting it.

### Expected merge conflict zones

- MEDIUM: `agent-session.ts` scheduled continuation and retry admission wiring.
- LOW: `provider-timeout-retry.ts` timeout option planning and owned-run abort.
- LOW: provider timeout recovery regression file organization.

## Default fallback chains survive user chain configuration (2026-08-04)

### What changed

- `retry-fallback/settings.ts` now layers user `retry.fallbackChains` over
  `DEFAULT_FALLBACK_CHAINS` per key instead of replacing the whole map. A user
  key of the same name still replaces that default outright (never a union), and
  an explicit empty array removes a default the user does not want.
- `retry-fallback/validate.ts` no longer warns that an empty chain "must contain
  at least one entry", because an empty array is now the documented opt-out.
- The malformed-map warning names the offending value
  (`"...but got null."` / `"...but got an array."`) instead of being anonymous.
- `SettingsManager.getFallbackChainsScope()` reports which scope supplied
  `retry.fallbackChains` (project wins, since it replaces the map wholesale), and
  every `validation_warning` log record now carries that scope as `source`, so a
  single log line names the file to open. `source` is `"default"` when no scope
  configured chains and the resolved map is the shipped defaults.

### Why

- Configuring an unrelated model silently deleted every shipped default chain.
  A user who added only `apitopia/kimi-k3-*` chains lost the default
  `anthropic/claude-fable-5` chain without any warning.
- That loss then propagated into policy: with no chain for the active model,
  `hasConfiguredChain()` returned false, the 2026-08-03 server-fallback policy
  correctly disabled `abortServerSideFallback`, and Anthropic's server-side
  substitution replaced the user's intended client fallback. The policy behaved
  as designed; its input was wrong.
- The anonymous "must be a plain object" warning fired repeatedly in real logs
  with no way to identify which value produced it.

### Why this cannot be expressed externally

- Defaults-vs-user resolution happens inside settings resolution, before any
  extension observes a session. An extension can add chains through
  `setFallbackChain`, but cannot restore a default the resolver already dropped.

### Expected merge conflict zones

- LOW: `retry-fallback/settings.ts` `resolveFallbackChains()`.
- LOW: `retry-fallback/validate.ts` empty-entry branch and the malformed-map string.
- LOW: fallback settings/validate test expectations.

## Durable compaction telemetry correlation (2026-08-03)

### What changed

- `agent-session.ts` retains superseded compaction attempt IDs until their stale terminal event arrives, rather than evicting the oldest ID after 64 supersessions.
- A `compaction_end` event without a request ID is now logged as an uncorrelated skipped/no-attempt decision and cannot consume an active same-reason attempt. Request-bearing terminals still require an exact attempt-ID match.
- `test/session-log-routes.test.ts` covers an early stale accepted terminal after more than 64 supersessions and no-ID retry exhaustion while another overflow attempt remains active.

### Why

- FIFO tombstone eviction allowed a late accepted terminal from an old attempt to reappear as a committed compaction after enough supersessions.
- Reason-only fallback correlation let retry exhaustion, which starts no compaction and carries no request ID, falsely mark an unrelated active overflow attempt as failed/compact.

### Why this cannot be expressed externally

- Attempt ownership and session-log emission meet inside `AgentSession._logSessionEvent()` before external telemetry consumers receive the content-free lifecycle record.

### Expected merge conflict zones

- LOW: `agent-session.ts` compaction start/end logging correlation and `test/session-log-routes.test.ts` lifecycle telemetry coverage.

## Required-compaction continuation recovery (2026-08-03)

### What changed

- `AgentSession` marks only provenance-confirmed required-compaction admission errors as retrying.
- Accepted post-turn threshold compaction resumes the exact interrupted continuation, including queued
  steering input, without fabricating a user `continue`.
- A locally proven required-compaction error can use the persisted byte estimate when every provider
  usage sample is missing or zero.
- Rejected recovery stays terminal, provider errors with the same text do not gain retry provenance,
  and one recovery sequence persists one threshold error.

### Why

- Required admission previously surfaced as a terminal provider failure before the recovery compaction
  finished, leaving active work idle even after a successful compaction.

### Why this cannot be expressed externally

- Only the session runtime owns the interrupted continuation, compaction lifecycle, provider-admission
  ordering, and queued-input precedence.

### Expected merge conflict zones

- `agent-session.ts` required-compaction provenance, `_runAutoCompaction()`, and upstream request-ID telemetry.

## Prefer configured client fallback chains over server substitutions (2026-08-03)

### What changed

- `agent-session.ts` now enables Anthropic's server-fallback abort only when the
  current model has a configured client fallback chain.
- The policy refreshes before each prompt and after every active-model switch,
  so `/fallback` edits, manual model changes, retry fallbacks, and primary
  restoration cannot carry stale precedence into the next provider request.
- An explicit `retry.abortServerSideFallback: false` still opts out even when a
  client chain exists.

### Why

- The previous session bootstrap enabled the abort unconditionally by default.
  When Anthropic substituted `claude-opus-4-8` for `claude-opus-5` and no client
  chain existed, Senpi discarded the valid substitute response and surfaced an
  error plus a warning telling the user to configure `/fallback`.
- Server fallback should be the default recovery when the user has not selected
  a client policy; an explicit client chain should remain authoritative when it
  exists.

### Why this cannot be expressed externally

- The decision must be forwarded in request-local provider options before the
  Anthropic stream parses a fallback receipt. Extensions can configure chains
  and observe events, but cannot change the agent loop's provider option after
  model selection and before each internal retry continuation.

### Expected merge conflict zones

- LOW: `agent-session.ts` around `_promptAgent()` and `_switchActiveModel()`.
- LOW: server-fallback option/routing tests.

## Resume queued messages after non-auto compaction; retain admission-rejected custom messages (2026-08-03)

### What changed

- `agent-session.ts` gained `_resumeQueuedMessagesAfterCompaction()`, mirroring
  `_runAutoCompaction`'s accepted-path recovery, and calls it on the success
  paths of `applyCompaction()`, the extension `compact` context action, and
  manual `compact()`.
- `sendCustomMessage()`'s non-streaming `triggerTurn` path now retains the
  message in the matching agent-level queue (`followUp`/`steer`) before
  rethrowing when provider admission (`_enforceCompactionBeforeProvider` /
  `_enforceFinalProviderAdmission`) rejects, mirroring `sendUserMessage`'s
  documented retention contract.

### Why

- A custom `triggerTurn` message sent while a non-auto compaction owned the
  session (extension feedback stage via `beginCompaction`, extension `compact`
  action, manual `/compact`) was parked in the agent-level queues without a
  turn and nothing resumed it afterwards; an admission rejection dropped the
  message entirely because the fire-and-forget extension `sendMessage` action
  swallows the rejection. Hidden goal continuations were the primary victim:
  their single-flight latch clears only on `agent_start`, so the goal silently
  idled at "Pursuing goal (...)" until manual user input.

### Why this cannot be expressed externally

- Both fixes depend on internal compaction lifecycle ownership, agent-level
  queue state, and the private continuation scheduler; no extension hook can
  observe or reschedule them.

### Expected merge conflict zones

- MEDIUM: `agent-session.ts` around `compact()` / `applyCompaction()` / the
  extension `compact` action finally blocks, `sendCustomMessage()`'s
  triggerTurn branch, and `_scheduleContinuationAfterCurrentEvent()`.

## Hint-aware 429 retry tier routing (2026-08-03)

### What changed

- `agent-session.ts` retry orchestration classifies 429-class errors into three tiers using the structured
  hint from `packages/ai`: no-hint 429 falls back immediately with zero same-model retries; tier 1 (hint ≤
  `hintedWaitCapMs`, default 300 000 ms) performs in-turn half/full probes via `nextInTurnDelayMs` with
  cumulative-cap demotion; tier 2 (`hintedWaitCapMs` < hint < `probeBackMaxMs`) falls back and schedules
  at most two `ProbeBackScheduler` probes at half/deadline, clearing cooldown on success so
  `maybeRestorePrimary` reverts next turn; tier 3 (hint ≥ `probeBackMaxMs`) falls back only with a
  remaining-hint cooldown.
- `retry-fallback/probe-scheduler.ts` (new) owns the tier 2 probe schedule. `retry-fallback/controller.ts`
  and `retry-fallback/cooldown.ts` carry the tier decision and cooldown state.
  `retry-fallback/settings.ts` adds `resolveHintPolicySettings` with `hintedWaitCapMs` and `probeBackMaxMs`
  (defaults 300 000 / 3 600 000 ms).
- New session events `retry_probe_scheduled` and `retry_probe_result` surface probe lifecycle to the client.
- `retry-fallback-long-delay.test.ts` has two intentionally updated assertions: tier routing replaces the
  legacy over-budget gate for 429-class errors, so the expected retry/fallback behavior changes accordingly.

### Why

- A blind exponential backoff on 429 wastes a turn when the provider says “retry now,” and retries
  immediately when the provider says “wait an hour.” Structured hints let the agent respect the provider's
  guidance instead of guessing.

### Why this cannot be expressed externally

- The tier decision must intercept the retry sleep and fallback switch inside agent-session's orchestration
  loop, between the provider error and the retry/fallback decision. The extension API exposes no hook at that
  point — extensions see only post-decision error strings.

### Expected merge conflict zones

- HIGH: `agent-session.ts` retry orchestration (approximately lines 5380–5705).
- MEDIUM: `retry-fallback/*` (controller, cooldown, settings, probe-scheduler).
- LOW: `settings-manager.ts` for the new `hintedWaitCapMs` / `probeBackMaxMs` settings.

## Backfill: eval bridge deadlock prevention (2026-08-01)

### What changed

- Eval bridge requests no longer deadlock the session when completion and bridge delivery race.

### Why

- A blocked bridge stalls the entire agent turn and leaves no safe continuation path.

### Why this cannot be expressed externally

- The fix depends on internal agent-session bridge ordering and completion ownership.

### Expected merge conflict zones

- Agent-session eval bridge handlers, pending request state, and completion/error cleanup.

## Deduplicate high-reasoning warnings per session model (2026-07-31)

### What changed

- `agent-session.ts` now remembers every sensitive provider/model identity that
  already displayed the high-reasoning warning during the current session.
- Moving between `xhigh`, `max`, lower reasoning levels, or another model no
  longer re-arms the warning for an identity the user already saw.
- A different sensitive provider/model identity still receives its own first
  warning.

### Why

- The previous single last-key value was cleared whenever the active state was
  not warnable and included the reasoning level in its key. Cycling reasoning
  levels or switching away and back therefore appended the same large warning
  box repeatedly.

### Expected merge conflict zones

- LOW: `agent-session.ts` warning-dedup state and
  `_emitHighReasoningWarningIfNeeded()`.

## Preserve the user's reasoning preference across model switches (2026-07-31)

### What changed

- `agent-session.ts`: manual model selection and favorite-model cycling now
  apply model-specific overrides and capability clamps as session-effective
  levels without replacing `defaultThinkingLevel`.
- Model switches without an explicit favorite tier restore the remembered
  `defaultThinkingLevel` before clamping it to the selected model.

### Why

- Switching from a max-capable model to a basic reasoning model persisted the
  clamped `high` tier, so switching back no longer restored the user's last
  selected `max` tier. Explicit favorite tiers could likewise replace the
  global preference even though they are model-specific overrides.

### Expected merge conflict zones

- LOW: `agent-session.ts` around `_switchActiveModel()`,
  `_cycleFavoriteModel()`, and `_getThinkingLevelForModelSwitch()`.

## Thinking-level tier detection delegates to packages/ai (2026-07-30)

### What changed

- `thinking-levels.ts` no longer re-implements the `xhigh` / `max` model-id lists. `supportsXhigh`,
  `supportsMax`, and `getSupportedThinkingLevels` now wrap the canonical `@earendil-works/pi-ai` helpers
  and only keep the coding-agent's `ThinkingLevel` vocabulary plus the non-empty `["off"]` fallback.
- The local `ModelWithThinkingLevelMap` cast is gone: `Model.thinkingLevelMap` is already part of the
  public `pi-ai` model type.

### Why

- Tier rules belong to `packages/ai`; delegating removes the coding-agent's duplicate model-id lists and
  precedence logic so future capability changes have one implementation. Generated catalog models retain
  their explicit maps, so behavior for real catalog models is intentionally unchanged.

### Why extension system couldn't handle this alone

- Tier detection feeds session thinking-level clamping and the model/RPC surfaces inside core; it is not
  reachable from an extension.

## Codex fast-variant service-tier metadata lookup (2026-07-29)

### What changed

- `model-registry.ts` now exposes a selected model's configured `serviceTier`
  synchronously, alongside the existing `getUpstreamModelId()` lookup.
- The builtin `/fast` command uses both values to accept only catalog siblings
  that send the same upstream model with `service_tier: "priority"`.

### Why

- A `-fast` suffix alone is not proof that a model supports priority
  processing. The command must validate the request metadata already resolved
  by the model registry before switching the session.

### Why extension system couldn't handle this alone

- Compatibility request metadata is composed inside `ModelRuntime`; extensions
  can inspect the registry but could not synchronously read its resolved
  per-model service tier.

### Expected merge conflict zones

- LOW: the request-metadata accessors in `model-registry.ts`.

## Settings withLock first-write TOCTOU fix (2026-07-29)

### What changed

- `settings-manager.ts` `FileSettingsStorage.withLock`: when the settings file does not exist yet, the merge callback used to run with no lock held and the write-time lock then overwrote whatever a concurrent process had created. The write path now re-checks existence after acquiring the lock and re-runs the merge callback against the winner's content before writing. The existing-file path additionally re-verifies existence after the lock before reading.
- Pure read paths are unchanged: a read on a missing file still creates no directory and no lock artifacts, so loading settings in an arbitrary cwd still cannot spray `.senpi/` directories.

### Why

- Two processes racing the first write of a fresh `settings.json` silently lost one side's fields (`existsSync` gated the lock, so the merge ran unlocked). Deterministic regression: `test/settings-storage-lock.test.ts` injects a concurrent first-write at lock acquisition and asserts the merge preserves it.

## Nearest-parent project settings discovery (2026-07-28)

### What changed

- `settings-manager.ts`: project settings now resolve from the nearest ancestor containing a real `.senpi` directory, rather than only from the exact cwd. If none exists, the legacy `<cwd>/.senpi/settings.json` path remains the write/read target.
- Global settings remain loaded before project settings, so project values continue to override the selected agent-directory settings layer.

### Why

- Invoking senpi below a project root silently skipped that root's `.senpi/settings.json`.

### Expected merge conflict zones on next upstream sync

- LOW: `getSettingsPath()` in `settings-manager.ts`.

## messages.ts keep-latest exclusion for goal-continuation (2026-07-29)

### What changed

- `messages.ts` now excludes consumed `goal-continuation` custom messages by position instead of by type: every
  `role === "custom" && customType === GOAL_CONTINUATION_MESSAGE_TYPE` entry is dropped except the last one.
  The same keep-latest rule is applied in both `filterContextExcludedMessages` and `convertToLlm`, so token estimation
  and provider payload assembly stay in sync.
- `isContextExcludedCustomMessage` remains `false` for this custom type; the live triggering message still needs to be
  visible to per-entry consumers such as compaction and branch summarization.

### Why

- Goal continuation messages accumulate across long sessions, and stale consumed entries must stay out of the next
  provider request without hiding the active trigger or letting the estimator disagree with the payload.

### Expected merge conflict zones on next upstream sync

- LOW in `messages.ts` around the shared keep-latest helper, `filterContextExcludedMessages`, and `convertToLlm`.
- NONE in the per-entry custom-message predicate semantics.

## AgentEndEvent.willRetry extension event field (2026-07-29)

### What changed

- `extensions/types.ts` now exposes an optional `willRetry?: boolean` on `AgentEndEvent`, mirroring the agent-session
  end event so builtin extensions can tell a terminal provider error from a retryable one.
- The field is additive only; existing extension consumers that ignore it continue to behave the same.

### Why

- The goal builtin needs to block on terminal provider errors only after retries are exhausted. Without the retry
  signal, a terminal error could be misclassified while a fallback retry was still in flight.

### Expected merge conflict zones on next upstream sync

- LOW in `extensions/types.ts` and the runner plumbing that forwards agent-session end events to builtin extensions.

## claude-agent-sdk provider with native multi-account OAuth (2026-07-27)

### What changed

- New builtin extension `core/extensions/builtin/claude-agent-sdk/`: routes LLM calls through the
  official Claude Agent SDK (spawns the real Claude Code engine) while senpi executes all tools
  (Claude Code tool use is denied; custom tools are exposed in-process as `mcp__custom-tools__*`).
- Auth: `/login claude-agent-sdk` runs the existing Anthropic PKCE flow and stores multi-account
  slots inside the provider credential (top-level fields are non-expiring sentinels; real refresh is
  per-slot under the store lock). Import of an existing `anthropic` OAuth credential and
  `CLAUDE_CODE_OAUTH_TOKEN(_N)` env accounts supported.
- HRW session affinity (rendezvous hashing) pins each session to one account to preserve prompt
  cache; mandatory failover on rate_limit/overloaded/auth errors only, stream-safe (no transparent
  retry after the first visible delta) with an AgentSession `senpi:no-turn-retry:` marker suppressing
  whole-turn replay of post-delta failures.
- Surfaces: `/claude-account` command, `--claude-account` flag, RPC `get_provider_accounts` /
  `account_pin` / `account_remove` plus `auth_accounts_changed` / `account_failover` events, and
  actionable auth guidance. `AuthStorage` learned to enumerate extension-registered OAuth providers
  (`registerOAuthProvider` bridge), synced from `ModelRuntime.registerProvider`.
- Dependency: `@anthropic-ai/claude-agent-sdk` pinned `0.3.220`; `@anthropic-ai/sdk` stays `0.91.1`
  via a root override (the `>=0.93.0` peer range breaks the browser build through node-builtin
  imports in new credential modules).

## Session-title generation retry + humanized provider errors (2026-07-27)

### What changed

- `session-title-generator.ts`: `generateSessionTitle()` accepts an optional `retry: RetryPolicy` and wraps the
  title call in `retryAssistantCall`, mirroring `completeSummarization()`. A transient provider error (e.g. an
  Anthropic 529 `overloaded_error` stream event) no longer fails title generation on the first attempt. Final
  failures throw `humanizeProviderError(...)` output — a short human-readable line such as
  `Overloaded (overloaded_error, request req_...)` — instead of the raw provider JSON body.
- `session-title-generator.ts`: new `sessionTitleRetryPolicy()` narrows the user's `settings.retry` for this
  cosmetic background call — `enabled` is preserved, `maxRetries` capped at 1 and `baseDelayMs` at 2000ms, and a
  smaller configured budget is never inflated. The full agent-turn budget would keep hitting an already-overloaded
  provider for ~14s while the user's real turn competes for the same capacity; a title that still fails is
  regenerated at the next turn end anyway.
- `agent-session.ts`: `_generateSessionTitle()` passes `sessionTitleRetryPolicy(settingsManager.getRetrySettings())`.
  The runtime-emitted extension-error sites now use the shared `RUNTIME_EXTENSION_PATH` sentinel constant.

### Why

- A single transient 529 during background title generation surfaced as `Extension "<runtime>" error: {raw json}`
  in the TUI and left the session untitled until the next turn end.

### Expected merge conflict zones

- LOW: `session-title-generator.ts` around `generateSessionTitle()`.
- LOW: `agent-session.ts` `_generateSessionTitle()` and the `emitError` call sites.

## Composable leading skill commands (2026-07-26)

### What changed

- `agent-session.ts`: `/skill:<name>` now accepts a leading whitespace-separated run of loaded skills, expanding each unique skill in written order before appending the remaining prompt text. Repeated skills expand only once, unknown skills stop the run and remain literal, and slash text outside that leading run is never interpreted as a skill command.
- Explicit expansion is capped at `MAX_SKILL_EXPANSIONS_PER_PROMPT` (5). Commands beyond the cap remain literal and emit an existing `skill_expansion` error-channel notification, preventing a composed prompt from growing context without bound.
- The shared expansion seam is called by `prompt()`, `steer()`, and `followUp()`, so queued and non-TUI/RPC prompt paths receive identical behavior.

### Why extension system couldn't handle this alone

Skill commands are resource-loader entries rather than extension commands, and their substitution happens in the private `AgentSession` prompt and queue boundary before the outbound user message is assembled.

### Expected merge conflict zones

- LOW: `agent-session.ts` `_expandSkillCommand()` if upstream revises skill-command parsing.

## Provider-bound inline image budget (2026-07-26)

### What changed

- `messages.ts`: added a transport-only 24 MiB inline image budget. Provider-bound conversion keeps the newest image
  block, counts it against the budget, and replaces images older than the hard recency cutoff with a re-read
  placeholder while preserving all text and leaving the persisted session untouched.
- `sdk.ts`: routes the main agent loop through the shared transport conversion while preserving the dynamic
  `images.blockImages` kill switch and its existing placeholder/deduplication behavior.
- `test/suite/harness.ts`: uses the same transport conversion and accepts a small injectable image budget for
  deterministic first-request integration coverage.

### Why extension system couldn't handle this alone

- Inline images must be bounded after session messages are converted but before every main-loop provider request,
  including resumed sessions and provider fallbacks. That conversion boundary is owned by the core Agent wiring.

### Expected merge conflict zones

- MEDIUM: `sdk.ts` around the Agent `convertToLlm` wiring.
- LOW: the transport helpers at the end of `messages.ts` and the Agent construction in `test/suite/harness.ts`.

## Thinking-level tier detection for Claude 5 families and GPT-5.6 (2026-07-25)

### What changed

- `src/core/thinking-levels.ts`: `supportsXhigh` now recognizes `gpt-5.6`, `opus-5`, `sonnet-5` and
  `fable-5`; `supportsMax` recognizes `opus-5`, `sonnet-5` and `fable-5`. These lists are the fallback
  for models with no `thinkingLevelMap` (custom `models.json` entries and third-party gateways), so
  those models previously could not reach the `xhigh` / `max` tiers in the level cycler even though
  their provider accepts them. Bundled catalog models are unaffected because an explicit map wins.
- This file is the coding-agent copy of the tier predicates; `packages/ai/src/models.ts` owns the
  `pi-ai` copy and was updated in lockstep.

### Why

- `off` also became selectable for Claude Fable 5 in this change set: `packages/ai` now encodes
  "cannot send `thinking.type: disabled`" as a compat fact rather than `thinkingLevelMap.off: null`,
  and the Messages provider pins the cheapest effort for an off turn. The selector needed no change
  for that - removing the `null` was enough.

## Session-owned compaction lifecycle (2026-07-23)

### What changed

- `agent-session.ts` now holds a monotonic compaction lifecycle coordinator that snapshots the active model and
  controller at operation start, rejects stale completion/feedback, and retains the terminal result until another
  operation begins. Feedback-only aborts publish one terminal event, and accepted completions publish their terminal
  event before `session_compact` handlers can begin a fresh operation.
- Owned automatic compaction attempts publish balanced start/end events when execution cannot begin. Ownership is
  rechecked after start: a synchronous listener that supersedes the controller with a new operation silences the stale
  terminal event (the new owner publishes its own lifecycle), while a listener that aborts the same controller still
  receives an `aborted` terminal event so UI state opened on `compaction_start` is always closed.
- Durable append now rejects a generation whose message revision or agent-message snapshot changed during preparation
  or summary generation (`stale-revision`), preserving intervening context without duplicate replay.
- Required compaction uses one provider-admission gate for normal prompts, extension-triggered turns, and every next
  turn. Provider-confirmed overflow remains fail-closed even when the local token estimate is below the configured
  threshold; `agent_end` synchronously transfers both silent-overflow and threshold-compaction continuation ownership
  to `AgentSession` before agent-core can drain native queues, and failed recovery restores the overflow context so
  later prompts cannot bypass the same requirement.
- Next-turn snapshots reapply the live active tools and effective per-run system prompt after asynchronous preparation,
  so a tool removed during the turn is neither advertised nor executable by the following provider request.
- Required ownership now suppresses only agent-core's post-`agent_end` queue drain, not the run abort signal. Deferred
  extension dispatch retains the real source signal, so compaction ownership does not masquerade as user cancellation.
- Retry and fallback admission resolve required compaction first; rejected recovery retains native queues without
  dispatching a provider retry. Active-tool changes advance the context revision and abort active core compaction so
  summaries prepared against a prior tool set cannot apply.
- Fallback apply/revert transitions emit typed model-selection events, rebuild model-scoped tools and prompts, abort
  compaction prepared for the prior model, and re-run required compaction against the selected model's context window
  before retrying.
- Message objects are associated with their persisted session-entry order. Compaction-boundary checks use that order
  (and treat pending `message_end` persistence as post-boundary) instead of relying only on payload timestamps.
- Session reload materialization restores those message-to-entry associations, so older payload timestamps cannot
  bypass post-compaction admission after reopening a session.
- When a late queue triggers compaction after a host `prepareNextTurnWithContext` callback, the callback is replayed
  once against the compacted context so its message filtering/injection contract reaches the provider request.
- Every compaction execution receives its route-owned controller explicitly. Auto compaction cannot promote unrelated
  extension feedback, and superseded feedback controller references are released even when their stale terminal
  callback never arrives.
- Post-retry and post-compaction usage exemptions suppress only stale threshold accounting. Provider-confirmed
  overflow always retains queue ownership and runs fail-closed recovery.
- Extension-originated provider turns now wait behind active session work and manual compaction. `clearQueue()` clears
  both native and post-compaction deferred ownership layers, preventing canceled steer/follow-up input from resurfacing.
- Provider admission is checked again after assembling `nextTurn` and `before_agent_start` custom messages. Rejected
  compaction restores one-shot additions transactionally; accepted compaction rebuilds and rechecks the final visible
  request before the provider is called.
- Request-local context provenance is attached non-enumerably to message identities and removed from persisted/session
  JSON. Remote replay uses it to prove the exact checkpoint boundary after filtering, injection, or reordering.
- Trigger-turn custom messages serialize behind manual/extension compaction before they are appended or sent.
  Scheduled continuation revalidates the canonical context against any model selected by `session_compact`, retaining
  queues when the smaller model requires rejected re-compaction.
- Manual and extension compaction claim a synchronous pending-admission barrier before their first await, closing the
  same-tick window where a trigger-turn custom message could overtake startup. Retry continuation failures that occur
  before provider dispatch now settle retry/idle state and retain queues instead of hanging the session.
- Fire-and-forget `session_start` messages defer past replacement-session work without being discarded as stale.

### Why extension system couldn't handle this alone

- Model selection, durable session append, provider-overflow recovery, controller ownership, and prompt admission are
  private `AgentSession` lifecycle boundaries.

### Expected merge conflict zones

- HIGH: `agent-session.ts` compaction execution, pre-prompt recovery, abort handling, and extension context bindings.

## Streaming steer/followUp submissions bypass the session-work barrier (2026-07-21)

### What changed

- `agent-session.ts` (`prompt()`): a submission with a `streamingBehavior` while a run is active and not
  compacting now queues immediately instead of awaiting `_waitForSettledSessionWork()`. Scheduled
  queued-message continuations (goal chains, queued follow-ups) hold the `SessionWorkBarrier` for the
  entire remaining run, so the old gate trapped typed input inside `prompt()` — invisible, unqueued, and
  undelivered — until the whole chain settled or the user pressed Esc.
- If the run ends while the bypassed input is being expanded, `prompt()` re-serializes with remaining
  session work and re-queues when a scheduled continuation started a new run in the meantime.

### Why extension system couldn't handle this alone

- The trap sits between core-owned `prompt()` serialization and the core continuation scheduler; both are
  private `AgentSession` lifecycle boundaries.

### Expected merge conflict zones

- MEDIUM: `agent-session.ts` `prompt()` entry serialization and the streaming queue dispatch branch.

## Memoized materialized session views (2026-07-21)

### What changed

- `session-manager.ts`: added a monotonic `mutationCount` bumped by every mutator (`_appendEntry`, `branch()`,
  `resetLeaf()`, `setSessionFile`, `newSession`, `createBranchedSession`). `getEntries()` is memoized on
  `mutationCount`, no-arg `getBranch()` on `(leafId, mutationCount)` (explicit `fromId` bypasses), and
  `getSessionName()` is O(1) via a cached value maintained on `appendSessionInfo`/`_buildIndex` (empty name still
  clears the title). `getEntries()` now returns a shared cached array callers must not mutate.

### Why extension system couldn't handle this alone

- The mutation surface and resident-store materialization are private to `SessionManager`; external wrappers cannot
  observe every invalidation point.

### Expected merge conflict zones

- LOW: private fields and the listed getters; upstream rarely touches `SessionManager` internals.

## Smooth streaming settings (2026-07-20)

### What changed

- `settings-manager.ts`: added persisted `smoothStreaming` and `smoothStreamingFps` settings. Smoothing defaults on,
  FPS defaults to 60, and reads clamp the configured value to 30–120.

### Why extension system couldn't handle this alone

- The built-in interactive renderer must read the setting before extensions load and while it owns an active stream.

### Expected merge conflict zones

- LOW: `Settings` fields and accessors near the existing thinking-visibility setting.

## "video" input modality plumbed through provider composition (2026-07-17)

### What changed

- `provider-composer.ts`: model `input` arrays (config input, models.json override, custom model definition)
  widened to `("text" | "image" | "video")[]`, tracking the pi-ai `Model.input` union. Enables the
  kimi-coding `k3` video input capability and models.json overrides declaring video.
- `remote-catalog-provider.ts`: `mergeModels` now unions `input` modalities (canonical text/image/video
  order) when a pi.dev overlay entry replaces a builtin model. The overlay refreshes costs/limits but a
  stale remote entry must not silently drop a fork-declared capability — the cached kimi-coding `k3`
  entry in `models-store.json` otherwise strips `"video"` and deactivates the `read_video` tool.

### Why extension system couldn't handle this alone

- The modality union is a core type shared with pi-ai; extensions consume it but cannot widen it.

### Expected merge conflict zones on next upstream sync

- LOW: `provider-composer.ts` model field lists.

## Model-switch atomicity: live prompt options and api-change gate (2026-07-19)

### What changed

- `src/core/agent-session.ts`: `_modelSelectionChangesContext` now also fires on `api`
  changes with identical provider, id, and context window, so wire-protocol-only model
  changes trigger full toolset/prompt synchronization.
- `src/core/extensions/runner.ts`: `emitModelSelect` re-reads live `systemPromptOptions`
  per handler so an earlier handler that swaps the active toolset (gpt-apply-patch) lets
  later handlers (prompt-preset) rebuild the system prompt from the post-swap tools in
  the same emission.

### Why extension system couldn't handle this alone

- The stale-snapshot defect lives in the core emission path; extensions only consume the
  combined `model_select` result.

## Composed providers engage text tool-call compatibility middleware (2026-07-17)

### What changed

- `provider-composer.ts`: composed provider `stream()` and `streamSimple()` now apply the text tool-call middleware when a model has `compat.toolCallFormat` and active tools. Custom `models.json` providers previously dispatched directly to their base or API provider, silently bypassing this compatibility behavior.

### Why extension system couldn't handle this alone

- Provider composition owns the final base-provider/API-provider stream dispatch before extensions receive model output, so extensions cannot insert the required context transformation and streaming parser on both paths.

### Expected merge conflict zones

- LOW: `provider-composer.ts` shared `streamWith()` dispatch and its `@earendil-works/pi-ai/compat` imports.

## AnthropicMessagesCompat.supportsWebSearch in models.json schema (2026-07-16)

### What changed

- `model-config.ts` (`AnthropicMessagesCompatSchema`): added optional boolean `supportsWebSearch`, mirroring
  `supportsWebSearchPreview` in `OpenAIResponsesCompatSchema`. This is the models.json opt-in for
  Anthropic-compatible endpoints that genuinely support server-side web search (see `packages/ai/src/changes.md`
  2026-07-16); without the schema entry the flag would fail models.json validation.

### Why extension system couldn't handle this alone

- models.json validation happens in core `model-config.ts` before any extension sees the model entry.

### Expected merge conflict zones

- LOW: `model-config.ts` compat schemas if upstream adds more compat flags.

## Skill-loading trigger reframed with cost asymmetry (2026-07-16)

### What changed

- `skills.ts` (`formatSkillsForPrompt`): the load trigger changed from "when the task matches its description" to "whenever its description even loosely matches the task - loading an irrelevant skill costs little; missing a relevant one degrades the work" (ported from omo Hephaestus). `skills.test.ts` pins "even loosely matches".

### Why extension system couldn't handle this

- `formatSkillsForPrompt` is core-owned and rendered into every system prompt. Strict-match framing under-loads skills on compression-biased models (GPT-5.6); stating the cost asymmetry is the decision-rule form the 5.6 guide prescribes for judgment calls.

### Expected merge conflict zones

- LOW: `skills.ts` intro lines if upstream rewords the skills preamble.

## Release accepted auto-compaction ownership before recovery (2026-07-13)

### What changed

- `agent-session.ts`: accepted auto-compaction now releases only its own abort-controller identity before awaiting the recovery continuation, while the session-work barrier remains active until recovery settles.
- Final cleanup is identity-guarded so an older compaction cannot clear a newer controller installed during recovery.

### Why extension system couldn't handle this

- Interactive input classification reads core-owned `AgentSession.isCompacting`, and fresh-prompt serialization depends on the private session-work barrier. Extensions cannot split those two lifecycle boundaries safely.

### Expected merge conflict zones

- MEDIUM: `agent-session.ts` around `_runAutoCompaction()` accepted-result handling and final controller cleanup.

## Post-compaction continuation deadlock fix (2026-07-12)

### What changed

- `agent-session.ts`: deferred post-compaction and queued-message continuations until the current serialized
  `agent_end` event promise resolves, while registering the detached continuation in `SessionWorkBarrier`.
- Overflow retry, threshold/pending-message delivery, and normal queued `agent_end` continuation use the same scheduler.

### Why

- Awaiting `agent.continue()` inside the active `agent_end` queue item deadlocked tool-bearing continuations because
  pre-tool hooks wait for the current agent-event queue to finish persisting.

### Why extension system couldn't handle this

- `AgentSession` owns the event queue, tool-hook barrier, settlement state, and continuation launch boundary.

### Expected merge conflict zones

- MEDIUM: `agent-session.ts` around `agent_end` queued continuation handling and `_runAutoCompaction()` recovery.
- LOW: `_continueAgentAfterCurrentRun()` and the session-work barrier integration.

## Preserve builtin extensions after project trust resolution (2026-07-12)

### What changed

- `resource-loader.ts`: project-trust reloads now carry forward only preloaded factory-origin extensions - builtins, bundled codemode package entries, and inline factories - ahead of file-based extensions.
- Shadowed or disabled file extensions from the pre-trust pass remain excluded from the trusted final set instead of being restored by the factory carry-over.
- Added regression coverage that verifies trusted reloads preserve plain-reload membership and builtin-first order, including `todowrite`, codemode's `eval` tool, and a shadowed `pi-todotools` package.

### Why extension system couldn't handle this

- Project trust uses a core-owned two-phase resource load. Only the resource loader can retain the factory instances and side effects from the untrusted bootstrap pass while rebuilding the final trusted extension order.

### Expected merge conflict zones

- LOW: `resource-loader.ts` around trusted final extension-set composition.
## Upstream model context overflow recovery (2026-07-08)

### What changed

- `model-registry.ts`: exposed configured `upstreamModelId` metadata synchronously so session-control code can compare selected aliases with provider-reported wire model ids without resolving credentials.
- `agent-session.ts`: overflow recovery now treats a context-window error from the configured upstream model id as the same current-model source, preserving the existing stale/unrelated model guard.

### Why extension system couldn't handle this

- Provider context-overflow recovery happens inside the core session compaction gate before extensions can safely decide whether to retry the active turn.

### Expected merge conflict zones

- MEDIUM: `agent-session.ts` around `_checkCompaction()` overflow eligibility.
- LOW: `model-registry.ts` around model request metadata accessors.

## Bundled codemode extension loading (2026-07-06)

### What changed

- `resource-loader.ts`: added `codemode` as a builtin-adjacent bundled extension loaded from the `@code-yeongyu/senpi-codemode` package manifest.
- The bundled extension is enabled by default, respects `enabledBuiltinExtensions` and `disabledBuiltinExtensions`, is unaffected by `--no-extensions`, and is still removable from the active tool set through `--exclude-tools eval`.
- Resolution failures, including compiled Bun binary package-resolution gaps, are reported as extension diagnostics and startup continues without `eval`.

### Why extension system couldn't handle this

- The extension package is shipped with the CLI and must be active before user extension discovery and project-trust resolution. User-installed extension paths cannot model that trusted default-on load order.

### Expected merge conflict zones

- HIGH: `resource-loader.ts` around builtin extension loading, package shadowing, and active builtin id filtering.

## executeTool active-tool bridge (2026-07-06)

### What changed

- `agent-session.ts`: added the core implementation for `pi.executeTool()`, including active-tool resolution, shared agent-loop argument preflight, synthetic `codemode-*` tool call ids, hook block handling, and post-result rewrites.
- Extracted the existing `beforeToolCall` and `afterToolCall` hook bodies into shared helpers used by both normal agent-loop dispatch and `executeTool()`.

### Why extension system couldn't handle this

- Extensions can observe and register tools, but only the session owns the active wrapped tool instances, the agent-event queue, and the hook/permission pipeline needed to execute subcalls with the same semantics as model tool calls.

### Expected merge conflict zones

- HIGH: `agent-session.ts` around `_installAgentToolHooks()`, `getActiveToolNames()`, and extension `bindCore()` wiring.

## Neo auth RPC core surface (2026-07-06)

### What changed

- `auth-providers.ts` (fork-only): shared auth-provider list module — the single source of truth across the classic
  TUI `/login` flow and the RPC auth commands.
- `agent-session.ts`: emits `auth_login_url` / `auth_login_end` as `AgentSessionEvent`s so interactive OAuth
  round-trips can complete out-of-band of a single RPC request; reuses `AuthStorage.login` callbacks unchanged.

### Why

- The neo Go TUI logs in over RPC (see `modes/rpc/changes.md`); login completion cannot fit inside the 30s RPC
  request timeout, so the terminal result must arrive as session events.

### Why extension system couldn't handle this

- Auth storage, login callbacks, and session event emission are core session services.

### Expected merge conflict zones

- MEDIUM: `agent-session.ts` around session event union and emission sites.
- LOW: `auth-providers.ts` (fork-only file).

## Provider stream idle timeout enabled by default (2026-07-06)

### What changed

- `sdk.ts`: the agent's stream idle timeout now defaults to `httpIdleTimeoutMs` (300s default) instead of being off
  unless `retry.provider.timeoutMs` was set.
- `settings-manager.ts`: `httpIdleTimeoutMs` participates in the default resolution; `0` disables, and
  `retry.provider.timeoutMs` still overrides.

### Why

- Sessions went stale forever when the network dropped and reconnected mid-stream: the dead connection never errors.
  Node runs were eventually rescued by the undici dispatcher body timeout, but the Bun binary has no such protection
  and hung indefinitely. With the guard on by default, a silently dead connection fails with a retryable idle-timeout
  error and auto-retry recovers the turn (abort-side fix in `packages/agent/src/changes.md` 2026-07-06).

### Why extension system couldn't handle this

- Stream option defaults are resolved in core SDK/settings plumbing before extensions see a request.

### Expected merge conflict zones

- LOW: `sdk.ts` stream-option assembly; `settings-manager.ts` retry/timeout resolution.

## External stdout/stderr guards while a TUI owns the terminal (2026-07-04)

### What changed

- `hidden-stdout-log.ts` (fork-only): hidden external stdout writes are redacted and appended to the debug log.
- `output-guard.ts` / `sensitive-output.ts`: stderr writes are likewise hidden and redacted while a TUI owns the
  terminal, matching the interactive stderr guard.
- Wiring: interactive mode, startup dialogs, and the config selector (see `modes/interactive/changes.md` and
  `cli/changes.md`); the TUI-side hook is `ProcessTerminal.onExternalStdoutWrite` (`packages/tui/src/changes.md`
  2026-07-04).

### Why

- A stray `console.log` from a library or extension corrupted the trust dialog and permanently desynchronized
  differential rendering.

### Why extension system couldn't handle this

- Redaction and debug-log routing for hidden writes are core services shared by every TUI surface.

### Expected merge conflict zones

- LOW: `hidden-stdout-log.ts`, `output-guard.ts`, `sensitive-output.ts` (fork-heavy files).

## Persist truncated bash output contents (2026-07-03)

### What changed

- `bash-executor.ts`: when bash output is truncated for the model context, the truncated contents are still persisted
  so the session record keeps the full output.

### Why

- Truncation previously dropped the overflow entirely; transcripts and session replays lost output that the user's
  terminal had shown.

### Why extension system couldn't handle this

- Output truncation happens inside the built-in bash executor before tool results reach extension hooks.

### Expected merge conflict zones

- LOW: `bash-executor.ts` truncation/persistence path.

## Await available-model lookups (2026-07-03)

### What changed

- `model-resolver.ts`: available-model lookups are properly awaited instead of racing an unresolved promise.

### Why

- The fork's model-resolution flow could observe an empty model list mid-startup.

### Why extension system couldn't handle this

- Startup model resolution runs before extensions load.

### Expected merge conflict zones

- LOW: `model-resolver.ts` async lookup call sites.

## App-server app-mode plumbing (2026-07-02)

### What changed

- `project-trust.ts`: `AppMode` gained `"app-server"` so project-trust resolution covers the fork's app-server mode
  (mode itself lives in `modes/app-server/`, dispatch in `src/changes.md` 2026-07-02).

### Why

- App-server sessions must honor the same project-trust gating as interactive/rpc modes.

### Why extension system couldn't handle this

- Trust gating is evaluated in core before a mode starts.

### Expected merge conflict zones

- LOW: `project-trust.ts` `AppMode` union.

## Upstream session, auth, and model-resolution sync (2026-07-02)

### What changed

- `auth-storage.ts`: accepted upstream persistence-failure surfacing so `/login` does not report success when `auth.json`
  could not be saved.
- `agent-session.ts`: accepted upstream split-turn serialization and kept fork prompt/compaction settlement behavior.
- `session-manager.ts`: accepted upstream context-building helper splits while preserving fork compaction detail propagation
  through `createCompactionSummaryMessage(entry.details)`.
- `model-resolver.ts`: accepted upstream structured model-resolution diagnostics and public helper behavior while
  preserving the fork's optional warning callback.

### Why

- These upstream fixes improve observable login errors, prevent overlapping summary generations, and expose consistent
  model diagnostics without dropping fork-only compaction metadata or warning behavior.

### Why extension system couldn't handle this

- Auth persistence, session context reconstruction, prompt/compaction scheduling, and model scope resolution are core
  session services that run before extensions can replace them.

### Expected merge conflict zones

- HIGH: `agent-session.ts` around prompt execution, compaction settlement, and split-turn continuation.
- MEDIUM: `session-manager.ts` around `sessionEntryToContextMessages()` and compaction-entry reconstruction.
- MEDIUM: `model-resolver.ts` around `resolveModelScope()` and diagnostics helpers.
- LOW: `auth-storage.ts` around save failure propagation.

## Resident session payload retention (2026-06-08)

### What changed

- `src/core/session-manager.ts`: large in-memory session strings are retained through a resident store while public
  readers, LLM context construction, branching, forking, and JSONL persistence materialize the original content.
- `src/core/session-resident-store.ts`: centralizes resident string references and store statistics for session payloads.

### Why

- Long sessions can retain repeated large message payloads in every session tree/index view. Keeping large resident
  strings behind lightweight refs lowers steady-state session memory pressure without changing persisted sessions.

### Expected merge conflict zones

- MEDIUM: `SessionManager` append, reload, branch, and persistence paths.
- LOW: tests under `test/session-manager/` that assert exact in-memory entry identity.

## Compaction prompt settlement barrier (2026-05-28)

### What changed

- `src/core/agent-session.ts`: normal user prompts now wait for pending session event processing and in-flight
  compaction work before starting a fresh provider request.
- `src/core/agent-session.ts`: overflow retry and user-visible queued follow-up/steering recovery now await the
  post-compaction continuation instead of scheduling an unobserved delayed `continue()`.
- `src/core/agent-session.ts`: agent-level custom-only queues also use the awaited post-compaction continuation path.
- `src/core/session-work-barrier.ts`: centralizes nested session-work barriers used by compaction settlement.

### Why

- `Agent` can become idle before `AgentSession` finishes `agent_end` compaction work. A prompt submitted in that window
  could race ahead of the compaction boundary or overflow recovery, making queued messages appear out of order or miss the
  compacted context.

### Why extension system couldn't handle this

- Extensions can provide compaction results, but only `AgentSession` can serialize fresh prompts against session event
  processing, compaction mutation, and retry/queue continuation.

### Expected merge conflict zones

- MEDIUM: `AgentSession.prompt()` around the pre-prompt settlement and post-prompt wait.
- MEDIUM: `_executeCompaction()` and `_runAutoCompaction()` around compaction lifecycle and continuation handling.

## Compaction cancellation across abort and model changes (2026-05-23)

### What changed

- `src/core/agent-session.ts`: `abort()` and `dispose()` now cancel in-flight manual/auto compaction and branch
  summarization controllers along with retry/agent cleanup.
- `src/core/agent-session.ts`: `setModel()` and favorite model cycling invalidate compaction state and bump the
  message revision whenever the selected model identity or context window changes.
- `src/core/agent-session.ts`: `model_select` now emits for same provider/model-id selections that change the effective
  context window, so extensions can drop stale model-bound work.

### Why

- An aborted over-context turn could leave a compaction request alive. If the user then switched to a larger-context
  model, stale compaction could finish beside the next normal assistant response and surface duplicate Working/status
  state.

### Why extension system couldn't handle this

- Extensions can observe model and compaction events, but the session owns the abort controllers and the monotonic
  message revision that guards precomputed compaction snapshots.

### Expected merge conflict zones

- MEDIUM: `AgentSession.abort()`, `setModel()`, and `_cycleFavoriteModel()` lifecycle paths.
- LOW: `AgentSession.dispose()` cleanup path and `_emitModelSelect()` early-return logic.

## Tool hook lifecycle status events (2026-05-19)

### What changed

- `src/core/extensions/runner.ts`: `tool_call` and `tool_result` handlers now emit internal start/end lifecycle
  observations with `PreToolUse` / `PostToolUse` labels, bounded status messages, elapsed-time anchors, and completed,
  blocked, or failed end statuses.
- `src/core/agent-session.ts`: the session relays those internal observations to mode listeners as
  `tool_hook_status` events without exposing a new extension author API.

### Why

- The interactive TUI needs to show when extension hook work is happening, including permission-rule matching and
  post-tool result processing, instead of leaving users with only a generic Working indicator.

### Why extension system couldn't handle this

- Extensions can show their own UI, but only the runner knows when each individual hook handler starts, ends, blocks, or
  fails. The session must relay that host-owned lifecycle to the TUI.

### Expected merge conflict zones

- MEDIUM: `extensions/runner.ts` around `emitToolCall()` and `emitToolResult()`.
- LOW: `agent-session.ts` around `_applyExtensionBindings()` and `AgentSessionEvent`.

## User abort prompt settlement barrier (2026-05-17)

### What changed

- `src/core/agent-session.ts`: `abort()` now creates a shared user-abort settlement promise before waiting for the
  active agent run to become idle.
- `src/core/agent-session.ts`: `prompt()` waits for that user-abort promise before classifying submitted input as
  streaming steering/follow-up or a normal fresh prompt.

### Why

- Pressing Esc while a tool call was active started abort asynchronously. A message submitted before the old run settled
  still saw `isStreaming === true`, so it was queued into the aborting run and could remain stuck after abort completed.

### Why extension system couldn't handle this

- The stale queue classification happens inside `AgentSession.prompt()` before extension commands or input handlers can
  reliably distinguish "streaming" from "currently aborting and about to become idle".

### Expected merge conflict zones

- MEDIUM: `AgentSession.prompt()` around the streaming queue branch.
- MEDIUM: `AgentSession.abort()` around agent abort and idle waiting.

## Provider-supplied retry delay handling (2026-05-15)

### What changed

- `src/core/agent-session.ts`: auto-retry now uses provider-supplied retry-after hints from assistant error messages when present, while refusing waits above `retry.provider.maxRetryDelayMs`.

### Why

- Rate-limit and overload responses can include an explicit wait period. Ignoring that hint caused senpi to retry too early with the local exponential base delay, often hitting the same provider throttle again.

### Why extension system couldn't handle this

- Retry scheduling is core `AgentSession` lifecycle behavior. Extensions can observe retry events, but they cannot replace the internal abortable sleep or resolve the prompt-level retry promise.

### Expected merge conflict zones

- MEDIUM: `AgentSession._handleRetryableError()` and retry event emission.

## Avoid duplicate compaction summary message augmentation (2026-05-15)

### What changed

- `messages.ts`: removed the coding-agent-side `CustomAgentMessages.compactionSummary` declaration merge entry.

### Why

- `@earendil-works/pi-agent-core` now declares the shared harness compaction summary message type. Keeping a second
  coding-agent declaration for the same `compactionSummary` slot made `tsgo` reject the package build because the two
  declarations used distinct local interface symbols.

### Why extension system couldn't handle this

- This is TypeScript declaration metadata for core message unions, evaluated at package build time before extensions run.

### Expected merge conflict zones

- LOW: `messages.ts` around the `CustomAgentMessages` declaration merge block.

## Compaction detail propagation (2026-05-15)

### What changed

- `messages.ts`: `CompactionSummaryMessage` can now carry opaque `details` from the accepted compaction result.
- `session-manager.ts`: reconstructed compaction summary messages preserve those details when rebuilding context from
  session entries.

### Why

- The OpenAI remote compact API returns provider-native retained input, counts, and route metadata that should remain
  visible after compaction and across context reconstruction without hard-coding provider behavior into core.

### Why extension system couldn't handle this

- Extensions can create the compaction result, but core owns conversion from persisted `compaction` entries into
  `CompactionSummaryMessage` objects.

### Expected merge conflict zones

- LOW: `messages.ts` around `CompactionSummaryMessage` and `createCompactionSummaryMessage()`.
- LOW: `session-manager.ts` around compaction-entry reconstruction.

## Export tilde paths (2026-05-13)

### What changed

- `src/core/export-html/index.ts` and `src/core/agent-session.ts`: `/export` output paths now expand leading `~` before writing HTML or JSONL exports.

### Why

- A user-facing `/export ~/asdf.jsonl` could create `./~/asdf.jsonl` instead of writing to the home directory.

### Why extension system couldn't handle this

- Export path resolution lives in the core export/session methods before extension command handlers see the final file write.

### Expected merge conflict zones

- LOW: `export-html/index.ts` and `AgentSession.exportToJsonl()` path handling.

## Overflow alias recovery (2026-05-13)

### What changed

- `src/core/agent-session.ts`: context-window overflow errors now trigger overflow compaction with automatic retry when the saved assistant provider differs from the current provider alias but the current context is also at the compaction limit.

### Why

- Imported or resumed sessions can contain OpenAI provider aliases from a previous run. When such a near-limit session overflows, treating the error as threshold compaction leaves the user with an empty error turn and no automatic retry.

### Why extension system couldn't handle this

- Overflow retry policy is core agent-loop recovery behavior; extensions can request compaction but cannot reliably remove the error turn and restart the agent turn.

### Expected merge conflict zones

- MEDIUM: `AgentSession._checkCompaction()` around overflow-vs-threshold recovery.

## Extension duplicate resource conflict policy (2026-05-12)

### What changed

- `src/core/resource-loader.ts`: Extension paths are deduped by nearest `package.json` package name plus relative extension entry before loading, so the same package installed from both a git package checkout and `~/.senpi/agent/extensions/` loads once without dropping multi-extension packages.
- Builtin extensions now precede disk-loaded extensions in the runtime array, and builtin-vs-external tool/flag name collisions no longer surface as startup errors.
- Extension flag defaults and CLI flag validation now follow that final builtin-first order, so an external duplicate flag cannot override builtin metadata by registering earlier during disk discovery.

### Why

- Users with both installed and manually cloned `code-yeongyu/pi-*` extensions saw noisy duplicate tool/flag conflict errors at startup, even when the duplicates represented the same logical extension or a builtin vendored copy.

### Why extension system couldn't handle this

- Extension factories only run after resource discovery and conflict diagnostics. Deduping package paths and classifying builtin/external conflicts has to happen in the core resource loader before the TUI renders startup diagnostics.

### Expected merge conflict zones

- LOW: `resource-loader.ts` around extension path assembly, rebuilt flag defaults, and `detectExtensionConflicts()` if upstream changes resource precedence or conflict diagnostics.
- LOW: `agent-session-services.ts` around extension CLI flag validation if upstream changes extension flag parsing.

## models.json per-model prompt preset metadata (2026-05-12)

### What changed

- `src/core/model-registry.ts`: Custom `models.json` model entries and built-in `modelOverrides` can now carry a `promptPreset` string.
- The registry preserves this value as model metadata for extensions instead of interpreting preset names in core code.

### Why

- Provider-specific model IDs can be too new or too aliased for automatic prompt-preset detection. Putting `promptPreset` next to the model definition keeps the routing metadata with the model catalog entry that needs it.

### Why extension system couldn't handle this

- The prompt-preset extension can consume model metadata, but `models.json` schema validation and model merging live in the core registry. Core needs to preserve the metadata before extensions see the selected model.

### Expected merge conflict zones

- LOW: `ModelDefinitionSchema`, `ModelOverrideSchema`, and `applyModelOverride()` in `src/core/model-registry.ts` if upstream adds more per-model metadata fields.

## Packaged thinking-tier helpers stay local (2026-05-12)

### What changed
- Added `src/core/thinking-levels.ts` so coding-agent owns the senpi-specific `xhigh` / `max` tier detection and supported-level expansion.
- Updated `src/core/agent-session.ts` and `src/core/sdk.ts` to import these helpers locally instead of from `@earendil-works/pi-ai`.

### Why
- The published `@code-yeongyu/senpi` package currently installs the registry `@earendil-works/pi-ai@0.74.0`, whose public exports do not include the fork-only `supportsXhigh` / `supportsMax` helpers.
- Importing those names directly from `pi-ai` makes packaged senpi fail during module loading before any CLI command runs.

### Why extension system couldn't handle this
- Thinking-tier availability is consumed by core session/model logic (`AgentSession`, SDK helpers) during startup and model switching, before extensions can replace those imports.

### Expected merge conflict zones on next upstream sync
- LOW: `agent-session.ts` / `sdk.ts` import blocks and any future upstream move of thinking-level helpers.

## Configured upstream model id and service tier (2026-05-09)

### What changed

- `src/core/model-registry.ts`: Custom `models.json` model entries can now set `upstreamModelId` and per-model `serviceTier`.
- `src/core/sdk.ts`: Provider requests use the configured upstream model id while preserving the configured catalog id for model selection.

### Why

- Users need both a normal catalog entry and a priority catalog entry, such as `gpt-5.5` and `gpt-5.5-fast`, while sending the upstream request as `model: "gpt-5.5"` with `service_tier: "priority"` for only the priority entry.

### Why extension system couldn't handle this

- The model id is embedded by the provider payload builder before `before_provider_request` hooks run, and `service_tier` is a provider-managed field. The registry has to carry the configured wire id and tier into the stream call before payload construction.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `model-registry.ts` schema/request-auth metadata and `sdk.ts` stream option composition.

## Generated default extension fast path (2026-05-08)

### What changed

- `src/core/resource-loader.ts`: Unchanged generated global default extension shims are now recognized by path and exact generated content, then resolved to the known in-process extension factory before the generic jiti loader runs.
- `src/core/resource-loader.ts`: User-edited or replacement files with the same default names still load through the normal extension import path.

### Why

- Clean-profile startup was spending several seconds loading deterministic generated shim files through jiti even though core already knows the matching default extension factories.

### Why extension system couldn't handle this

- Generated default shims are discovered and loaded by core resource bootstrap before extension code can run. Extensions cannot replace the loader's import strategy for their own files.

### Expected merge conflict zones on next upstream sync

- LOW: `resource-loader.ts` around generated global default extension path/content checks and the `loadExtensions()` call.

## Dist-backed default extension shims (2026-05-08)

### What changed

- `src/core/resource-loader.ts`: Default generated global extension shims now point at `dist` files when senpi itself is running from `dist`, even in a linked workspace that also has `src`.

### Why

- Linked CLI startup was re-transpiling default global extension TypeScript files through jiti before the first frame.

### Why extension system couldn't handle this

- Generated default global extension shims are created by core resource loading before extension code runs.

### Expected merge conflict zones on next upstream sync

- LOW: `resource-loader.ts` around `getGlobalDefaultExtensionModulePath()` and default shim generation.

## Model config controls (2026-05-08)

### What changed

- `src/core/model-registry.ts`: `models.json` can disable providers with top-level `disabledProviders` or per-provider `disabled`, filter provider models with `whitelist` / `blacklist`, and replace built-in thinking-level mappings with `thinkingLevelMapMode: "replace"`.
- `src/core/settings-manager.ts` and `src/core/sdk.ts`: added `favoriteModels` settings support and kept `enabledModels` as global model-catalog narrowing.
- `src/core/agent-session.ts`: reload refreshes the model registry, global model narrowing, and favorite models; Ctrl+P cycling only uses the configured favorite models, and available thinking levels honor model-level mapping overrides.

### Why

- The user requested opencode-style provider disable/filtering, favorite-model-only Ctrl+P cycling, and configurable replacement of reasoning variants with reload support.

### Why extension system couldn't handle this

- Model discovery, startup model resolution, persisted settings, and Ctrl+P cycling are core session/model-registry responsibilities. Extensions can add providers or shortcuts, but cannot reliably replace the built-in model registry, default catalog narrowing, or internal cycling semantics before the TUI starts.

### Expected merge conflict zones on next upstream sync

- HIGH: `model-registry.ts` schema/loading and model filtering.
- MEDIUM: `sdk.ts` startup model narrowing resolution and `agent-session.ts` reload/cycle paths.

### Migration notes

- `enabledModels` remains readable as global model narrowing, but Ctrl+P favorites are persisted through `favoriteModels`.

## Favorite model filter hardening (2026-05-11)

### What changed

- `src/core/agent-session.ts`: favorite models now act as a filter over the current available model list and current global narrowing before being exposed or cycled, so stale cached model objects cannot be selected after a provider/model leaves the registry.
- `src/core/model-resolver.ts`: slash-qualified glob patterns now match canonical `provider/model` ids only, preventing patterns like `openai/*` from also matching raw model ids such as `openai/gpt-*` under another provider.

### Why

- Favorite cycling should only choose models that are still present in the current model catalog. This matches opencode's validity filter behavior and avoids switching to stale favorites after provider/model changes.

### Why extension system couldn't handle this

- Favorite model resolution and Ctrl+P cycling are core `AgentSession` behavior, and glob pattern matching is shared by core startup/reload model resolution before extensions can safely override it.

### Expected merge conflict zones on next upstream sync

- `src/core/agent-session.ts` around favorite model getters and `cycleModel()`.
- `src/core/model-resolver.ts` around glob pattern matching in `resolveModelScope()`.

## Favorite model toggle keybinding (2026-05-12)

### What changed

- `src/core/keybindings.ts`: added configurable `app.models.toggleFavorite`, defaulting to `Ctrl+F`, for model selector favorite toggles.

### Why

- Users need the `/model` and `/favorite-models` selectors to select models normally while still being able to toggle favorite status for the highlighted row.

### Why extension system couldn't handle this

- Selector key handling uses the built-in keybinding registry before extension UI code can attach row-local actions, so the built-in selector action needs a first-class keybinding id.

### Expected merge conflict zones on next upstream sync

- LOW: `keybindings.ts` around model selector keybinding definitions.

## Git package dependency repair on update (2026-05-02)

### What changed

- `src/core/package-manager.ts`: `updateGit()` now runs the package dependency install step even when the fetched git target already matches the local checkout.

### Why

- `senpi update` previously returned early for current git packages. If an extension checkout's `node_modules` was damaged or incomplete, the update command reported success but left runtime imports broken.

### Why extension system couldn't handle this

- Git package update and dependency installation are core package-manager responsibilities that run before extension loading.

### Expected merge conflict zones on next upstream sync

- LOW: `DefaultPackageManager.updateGit()` around the post-fetch current-HEAD branch.

## Model Switch System Prompt Change (2026-04-30)

### What changed

- `src/core/agent-session.ts`: Applies `model_select` system prompt results immediately, emits `system_prompt_change` only when the active prompt string changes, and returns the change from `setModel()` / `cycleModel()`.
- `src/core/extensions/types.ts`: Added typed `system_prompt_change` event and model-select prompt-change result.
- `src/core/extensions/runner.ts`: Added `emitModelSelect()` to collect prompt-change results from `model_select` handlers.
- `src/modes/interactive/interactive-mode.ts`: Includes the changed prompt name in model-switch status messages and shows standalone prompt-change status for extension-driven switches.
- `src/core/extensions/builtin/prompt-preset/index.ts`: Resolves prompt presets during `model_select` so mid-session model changes update the active prompt immediately.

### Why

- The prompt-preset builtin only changed the effective prompt at the next `before_agent_start`. The user requested mid-session model changes to switch the system prompt immediately, emit a `pi.on` event, and show the TUI notice only when the prompt actually changes.

### Why extension system couldn't handle this

- The existing extension event runner ignored `model_select` return values and had no core-owned typed event for active system prompt changes. TUI status also needs core session feedback from `setModel()` / `cycleModel()`.

### Expected merge conflict zones on next upstream sync

- HIGH: `agent-session.ts` around model switching and event emission.
- HIGH: `extensions/types.ts` and `extensions/runner.ts` around model events.
- MEDIUM: `interactive-mode.ts` model status rendering.

### Migration notes

- Keep `system_prompt_change` gated by actual string inequality. Same-preset model switches must not spam the event or TUI.

## Seam 3: Compaction Apply ExtensionContext API (2026-04-27)

### What changed

- `src/core/agent-session.ts`: Added in-memory monotonic message revision counter. Added `getMessageRevision()` and `applyCompaction(precomputed, { reason, expectedRevision })` for compare-and-apply speculative compaction.
- `src/core/agent-session.ts`: Extended `_executeCompaction()` to accept a precomputed `CompactionResult`.
- `src/core/extensions/types.ts`: Added `ApplyCompactionOptions`, `ApplyCompactionResult`, `ExtensionContext.getMessageRevision()`, `ExtensionContext.applyCompaction()`.
- `src/core/extensions/runner.ts`: Wired new context actions through `bindCore()` and `createContext()`.
- `src/modes/interactive/interactive-mode.ts`: Added same methods to inline shortcut `ExtensionContext` literal.

### Why

- Speculative/v2 compaction needs a stable compare-and-apply seam: extensions can prepare a compaction summary against revision N and only apply it if no context-affecting message mutation has happened since.
- `getMessageRevision()` is intentionally monotonic and in-memory only; it is a staleness guard, not persisted session data.
- `applyCompaction()` returns explicit `ok`, `stale`, or `rejected` outcomes so extensions can avoid racing the live session.

### Why extension system couldn't handle this

Extensions can observe hooks and return summaries during a core-driven compaction, but they cannot append a compaction entry, rebuild agent context, emit core compaction events, or atomically guard against stale session context without a typed core API.

### Expected merge conflict zones on next upstream sync

- HIGH: `agent-session.ts` around message revision and `applyCompaction()` implementation.
- HIGH: `extensions/types.ts` and `extensions/runner.ts` around `ExtensionContext`/`ExtensionContextActions` definitions.
- MEDIUM: `interactive-mode.ts` shortcut context literals must retain parity with `ExtensionRunner.createContext()`.

### Migration notes

If upstream adds new `ExtensionContext` methods or changes `AgentSession` message mutation logic, preserve the monotonic revision counter and the `applyCompaction()` compare-and-apply semantics. The revision guard must remain in-memory and advance on every context-affecting mutation. Do not let upstream's `ExtensionContext` additions shadow the new methods.

## Seam 3b: Extension Compaction Feedback Scope (2026-05-15)

### What changed

- `src/core/agent-session.ts`: Added core-owned begin/end helpers for extension-driven compaction feedback and wired them into `ExtensionContext`.
- `src/core/agent-session.ts`: `applyCompaction()` now reuses an already-open compaction abort controller so an extension can show `compaction_start` before it has a precomputed summary without emitting duplicate start events.
- `src/core/extensions/types.ts` and `src/core/extensions/runner.ts`: Added optional `beginCompaction()` and `endCompaction()` context methods.

### Why

- The fork's speculative/blocking compaction extension can spend time generating or awaiting a summary before `applyCompaction()` is called.
- Without a core-owned feedback scope, the TUI has no compaction loader, Esc cancellation signal, or `isCompacting` input queueing during that wait.

### Why extension system couldn't handle this

Extensions can call UI methods, but they cannot set `AgentSession.isCompacting`, own the session abort controller, or emit canonical `compaction_start`/`compaction_end` events without a core context action.

### Expected merge conflict zones on next upstream sync

- HIGH: `agent-session.ts` around `applyCompaction()`, compaction abort controllers, and extension context binding.
- HIGH: `extensions/types.ts` and `extensions/runner.ts` around `ExtensionContext`/`ExtensionContextActions`.

### Migration notes

If upstream adds a native progress or cancellation API for compaction, map the builtin compaction extension to that API while preserving the invariant that visible feedback starts before extension summary generation begins and ends exactly once.

## Seam 4: Unified Compaction Pipeline (2026-04-27)

### What changed

- `src/core/agent-session.ts`: Consolidated manual, threshold, overflow, pre-prompt, and extension-triggered compaction routes into a single private `_executeCompaction()` pipeline.
- The unified pipeline covers: preparation, extension hook execution (`session_before_compact`), summary generation, pre-append token simulation, session append, context rebuild, and completion event emission (`session_compact`).
- Route-specific metadata (reason, custom instructions, thinking/max-token behavior), error handling, retry handling, token estimation before append, and abort handling now flow through one seam.

### Why

- The user identified 9 route inconsistencies caused by duplicated compaction code paths across manual `/compact`, threshold-triggered, overflow-recovery, pre-prompt, and extension-triggered compaction.
- Without unification, each route handled metadata, error recovery, token estimation, and event emission differently, causing observable behavioral differences for extensions consuming compaction events.

### Why extension system couldn't handle this

The duplicated route control flow lives inside `AgentSession`. Extensions can customize compaction content via `session_before_compact` hooks, but they cannot unify internal caller behavior, append semantics, context rebuilds, or core event ordering from outside the session.

### Expected merge conflict zones on next upstream sync

- HIGH: `agent-session.ts` is the highest-churn upstream file. Rebase conflict resolution must preserve the `_executeCompaction()` pipeline and keep branch summarization outside this helper.

### Migration notes

If upstream modifies any compaction route (manual, threshold, overflow, pre-prompt), resolve conflicts by routing the modified logic through `_executeCompaction()` rather than restoring inline duplication. Preserve the 6-route coverage: manual, threshold, overflow-recovery, pre-prompt, extension-triggered, and branch summarization (which routes through the hook but remains a separate caller). Keep the pre-append token simulation step to prevent post-compaction overflow.

## builtin extension labels

- Changed `src/core/extensions/builtin/index.ts` and `src/core/resource-loader.ts` so builtin extensions keep stable synthetic ids like `<builtin:todowrite>` instead of being loaded as numbered inline factories.
- This was changed in core because the startup Extensions list is sourced from extension metadata produced by `DefaultResourceLoader`; the extension API cannot rename builtin factory identities after load.
- Expected merge-conflict zone on upstream sync: builtin extension registration in `src/core/extensions/builtin/index.ts` and builtin factory loading in `src/core/resource-loader.ts`.

## move selected defaults to global extensions

- Changed `src/core/extensions/builtin/index.ts` and `src/core/resource-loader.ts` so `diff`, `files`, `prompt-url-widget`, and `tps` are no longer registered as builtin factories.
- `DefaultResourceLoader` now seeds generated shim files for those four defaults into the real global `agentDir/extensions/` directory, so they load through normal global extension discovery instead of builtin registration.
- `DefaultResourceLoader` now rewrites previously generated shim files when their absolute builtin module paths become stale after the checkout/package directory moves or is renamed.
- This had to be done in core because builtin-vs-global extension ownership is determined during resource bootstrap, before any extension code runs.
- Expected merge-conflict zone on upstream sync: builtin extension registration and early resource bootstrap in `src/core/resource-loader.ts`.

## disable builtin extensions from settings

- Changed `src/core/settings-manager.ts` and `src/core/resource-loader.ts` so `settings.json` can disable selected builtin extensions with `disabledBuiltinExtensions`.
- `DefaultResourceLoader` now skips builtin factories whose ids are listed in settings.
- This had to be done in core because builtin extensions are instantiated during early resource bootstrap, before project extensions can intercept or unregister them.
- Expected merge-conflict zone on upstream sync: settings schema/getters in `src/core/settings-manager.ts` and builtin factory loading in `src/core/resource-loader.ts`.

## steering default mode to all

- Changed `src/core/settings-manager.ts` so `getSteeringMode()` now defaults to `"all"` instead of `"one-at-a-time"` when no explicit setting is present.
- Added `test/settings-manager.test.ts` coverage to lock the new default behavior.
- This was changed in core because the default steering mode is injected into `Agent` during session creation via `SettingsManager`, so an extension cannot change the built-in default before the session runtime is constructed.
- Expected merge-conflict zone on upstream sync: `src/core/settings-manager.ts` default getter behavior.

## builtin openai service tier setting

- Changed `src/core/settings-manager.ts`, `src/core/extensions/builtin/index.ts`, and added `src/core/extensions/builtin/service-tier.ts` so `settings.json` can set `openai.serviceTier` and automatically inject `service_tier` into OpenAI Responses payloads.
- Added test coverage in `test/suite/service-tier-extension.test.ts`, `test/suite/service-tier-settings.test.ts`, and updated builtin extension registration coverage in `test/resource-loader.test.ts`.
- This was changed in core because builtin extension registration and settings schema/getter wiring happen before extension code can discover a new builtin id or read typed settings from the existing settings manager.
- Expected merge-conflict zone on upstream sync: builtin extension registration in `src/core/extensions/builtin/index.ts` and settings schema/getter additions in `src/core/settings-manager.ts`.

## synced builtin extensions and webfetch

- Changed `src/core/extensions/builtin/index.ts`, `src/core/resource-loader.ts`, and `src/core/settings-manager.ts` so builtin extensions can be allowlisted with `enabledBuiltinExtensions` while preserving `disabledBuiltinExtensions` as an override.
- Added `src/core/extensions/builtin/webfetch/` as a builtin extension synced from `../pi-extensions/pi-webfetch`, and moved `bash-timeout` and `openai-api-parallel-tool-calls` to synced `../pi-extensions` layouts.
- Added `scripts/sync-builtin-extensions.mjs`, wired into the package build, so local builds refresh the vendored builtin snapshots from `SENPI_BUILTIN_EXTENSIONS_SOURCE` or `../pi-extensions` when that source checkout exists. `external-versions.json` records the source package names and versions included in the snapshot.
- This had to be done in core because builtin extension registration and builtin settings filtering happen before any user extension can affect resource discovery.
- Expected merge-conflict zone on upstream sync: builtin extension registration in `src/core/extensions/builtin/index.ts`, builtin factory filtering in `src/core/resource-loader.ts`, and settings schema/getters in `src/core/settings-manager.ts`.

## Anthropic "max" thinking level and provider/model extraBody config

- Widened the `"max"` thinking level through the coding agent surface: CLI `--thinking max`, `/settings` selector, Shift+Tab cycle, `settings.json` `defaultThinkingLevel`, thinking border color mapping.
- Extended `packages/coding-agent/src/core/model-registry.ts` so `models.json` (and `pi.registerProvider()`) accepts `extraBody` at both provider and per-model level. `getApiKeyAndHeaders` now resolves `extraBody`, and `sdk.ts` merges provider/model extraBody with any call-site `extraBody` before invoking `streamSimple`.
- This had to be done in core because `ThinkingLevel` is exported from `@mariozechner/pi-agent-core` and every UI/CLI/settings surface needed to be widened, and because `getApiKeyAndHeaders` + stream option composition live in core `ModelRegistry`/`sdk.ts`.
- Expected merge-conflict zone on upstream sync: `model-registry.ts` schemas + `getApiKeyAndHeaders`, `sdk.ts` stream option composition, `cli/args.ts` validator, `settings-manager.ts` thinking level type, `agent-session.ts` thinking cycle list, interactive TUI thinking selector and border color map.

## RPC prompt-level thinking and fallback level events (2026-07-22)

### What changed

- `agent-session.ts`: accepts a session-only `PromptOptions.thinkingLevel`, rejects queued prompts carrying it before queue mutation, and emits `thinking_level_changed` when retry fallback applies an ephemeral level.

### Why extension system couldn't handle this

- Prompt preflight, session-only level application, fallback model switching, and session event emission are private core lifecycle boundaries.

### Expected merge conflict zones

- HIGH: `agent-session.ts` prompt serialization and fallback model-switch logic.
