## 2026-08-25 - Preserve same-model redacted thinking during message transforms

### What changed

- `packages/ai/src/api/transform-messages.ts` preserves opaque redacted thinking blocks whenever the source and target model are the same, independent of `preserveProviderState`.

### Why

- Bedrock redacted reasoning is provider replay state that must survive same-model transformation; gating it on `preserveProviderState` dropped the block and changed the replayed request.

### Why an extension could not handle it

- Message transformation and provider-state preservation run inside the AI adapter boundary before extension code receives the outbound request.

### Expected merge conflict zones

- LOW: redacted-thinking handling in `transformMessages()` when upstream changes message replay policy.

## Provider wire layer re-diverges from upstream dcd4619 (2026-08-25)

### What changed

- `packages/ai/src/providers/cloudflare-ai-gateway.ts` keeps the fork's Cloudflare AI Gateway provider registration and Workers AI model mapping.
- `packages/ai/src/index.ts` keeps the fork barrel export for `estimateContextTokens`.
- `packages/ai/src/api/anthropic-messages.ts` keeps refusal fallback, provider-native content,
  prompt-cache TTL compat, 429 retry-after hints, and combined abort signals.
- `packages/ai/src/api/azure-openai-responses.ts` keeps `supportsMax`-aware effort mapping and
  `thinkingLevelMap` resolution.
- `packages/ai/src/api/bedrock-converse-stream.ts` keeps prompt-cache TTL gating, tool-call id
  normalization, `applyExtraBody` with reserved keys, and the trimmed smithy type imports.
- `packages/ai/src/api/google-generative-ai.ts` and `packages/ai/src/api/google-vertex.ts` keep the
  thinking-level maps, `applyExtraBody` with `GOOGLE_RESERVED_BODY_KEYS`, provider-header records,
  and grounding/url-context metadata emission.
- `packages/ai/src/api/mistral-conversations.ts` keeps `preserveThinking` message transformation and
  `MISTRAL_RESERVED_BODY_KEYS` extra-body support.
- `packages/ai/src/api/transform-messages.ts` keeps same-model redacted-thinking replay: opaque
  redacted blocks are preserved for the same model regardless of `preserveProviderState` (upstream
  additionally gates on it), so Bedrock redacted reasoning replays instead of being dropped.
- `packages/ai/src/api/openai-completions.ts` keeps moonshot/compat tool-schema normalization,
  forced-tool-choice fallback, stream-aware retries, and `supportsMax`/`supportsXhigh` effort.
- `packages/ai/src/api/openai-responses.ts` keeps the responses-websockets beta header, Cloudflare
  base-url routing, client-auth resolution, reserved body keys, and `clampMaxForOpenAI`.
- `packages/ai/src/index.ts` keeps fork re-exports (cursor pi-args helpers,
  `sanitizeAnthropicToolPairs`, cursor exec types).
- `packages/ai/src/types.ts` keeps the `cursor-agent` API id, the extended `OpenAIResponsesCompat`
  (`supportsAdditionalTools`), session-affinity formats, and `Model` re-exports.

### Why

These are fork-owned product surfaces (senpi branding, provider wire behavior, fork runtime features) that upstream does not carry; the sync must re-assert them on top of upstream's tree.

### Why this lives in the fork

The divergence lives in core wiring, package identity, or build plumbing that executes before any extension loads, so no extension hook can express it.

### Expected merge conflict zones

- Import blocks and option-mapping functions of every listed `packages/ai/src/api/*.ts` file, and the
  export list of `packages/ai/src/index.ts` — upstream touches these on nearly every provider change.

## 2026-08-25 - Distinguish Cursor usage-pool exhaustion from context overflow

### What changed

- `packages/ai/src/utils/overflow.ts`: token-bearing Cursor `resource_exhausted` errors are context overflow only at or above half the supplied context window; added `isCursorQuotaResourceExhausted` for below-half usage-pool failures while preserving zero-token and no-window behavior.

### Why

- Cursor uses the same bare `resource_exhausted` status for quota exhaustion and context overflow. Proximity to the model window is the verified discriminator.

### Why an extension could not handle it

- Overflow classification is a provider-neutral AI utility below extension-visible session behavior.

### Expected merge conflict zones

- LOW: Cursor `resource_exhausted` handling in `packages/ai/src/utils/overflow.ts`.

## Unreleased

## 2026-08-25 - Harden bounded retry jitter and provider abort metadata

### What changed

- `packages/ai/src/providers/faux.ts`: preserves `abortSource` in faux assistant messages.
- `packages/ai/src/types.ts`: adds optional provider abort provenance to assistant messages.
- `packages/ai/src/utils/retry.ts`: adds injectable Codex-style +/-10% jitter to bounded retry delays; provider hints remain lower bounds.

### Why

- Retry watchdog ownership and deterministic jitter must survive shared AI message and retry utility boundaries. Jitter prevents synchronized retries without shortening provider-directed waits.

### Why an extension could not handle it

- These browser-safe shared types and utilities execute below extension-visible provider/session boundaries.

### Expected merge conflict zones

- LOW: `packages/ai/src/providers/faux.ts`, `packages/ai/src/types.ts`, and `packages/ai/src/utils/retry.ts`.
- Pin a Cursor Composer operating prefix as its own leading system blob so Composer models arrive with this client's native tool vocabulary and completion rules instead of the Cursor-harness habits they were trained on.
- Match the official Cursor CLI's stream recovery: every inbound frame, including heartbeats and checkpoints, refreshes the 30s health timer; pre-`turnEnded` stalls and transport deaths retry with bounded backoff, and checkpointed attempts resume with the original pinned model request.
- Treat Cursor `turnEnded` as definitive completion after a bounded exec-dispatch drain.
- Skip ANTML invoke recovery when `model.api === "cursor-agent"` so native Cursor tool starts are not rejected as invalid event order.
- Keep usable Cursor task tool arguments when the complete frame parses as empty.
- Remint a Cursor conversation wire id after the 3-rotation skip instead of blocking the whole session.
- Persist Cursor conversation-id rotation under the agent dir (`CODING_AGENT_DIR` / `~/.senpi/agent`), not `$HOME/cursor-conversation-ids.json`.
- Surface the first 0-token `resource_exhausted` of a `stream()` call so session-layer compaction runs before rotation.

## 2026-08-23 - Provider-declared retry policy profiles

### What changed

- `packages/ai/src/utils/retry-profile/` (new tree): pure retry-profile value types (`types.ts`), backoff calculator (`backoff.ts`), failure normalizer (`failure.ts`), classifiers (`classifiers.ts`), delay planner (`planner.ts`), and shipped profile constants (`profiles.ts`). Two stages per profile (`providerRequest`, `turn`), each carrying enabled/maxRetries/backoff(exponential with factor, per-attempt cap, jitter mode)/serverHint(override with ceiling or tiered)/classify.
- `packages/ai/src/models.ts`: added optional `retryPolicy?: RetryPolicyProfile` to `Provider` and `CreateProviderOptions`, forwarded through `createProvider`. Omitting it means the shipped senpi-default profile applies.
- `packages/ai/src/providers/kimi-coding.ts`: declares `KIMI_CODE_RETRY_PROFILE` (10 total attempts, 500ms base, x2 factor, 32s per-attempt cap, +0-25% additive jitter, uncapped server Retry-After, status-whitelist classifier) because kimi-code's managed base (api.kimi.com/coding/v1) and wire protocol (anthropic) match this provider's target exactly.
- `packages/ai/src/api/anthropic-messages.ts`: the catch boundary emits exactly one `provider_retry_failure` diagnostic via `normalizeAnthropicRetryFailure` before the raw error is reduced to a string, carrying a whitelist of facts (kind, statusCode, providerCodes, retryAfterMs, shouldRetry). `output.errorMessage` remains character-identical including the existing `(retry-after-ms: N)` marker.
- `packages/ai/src/utils/diagnostics.ts`: the `provider_retry_failure` diagnostic type sits alongside existing diagnostics, never retaining a `Headers` object or authorization value.
- `packages/ai/src/utils/retry.ts`: `isRetryableErrorMessage` delegates to the new tri-state `classifyErrorMessage` (non-retryable / retryable / unknown). Verdicts are unchanged for every message the regexes match; "unknown" lets profile classifiers consult structured status facts only when the regexes say nothing, with non-retryable still outranking retryable.
- `packages/ai/src/utils/retry-profile/profiles.ts` (phase 2 defaults): the senpi-default turn backoff gained an 8s per-attempt cap and +0..25% additive jitter for locally computed exponentials; provider-derived hints stay exact. The kimi-code profile keeps its documented +0..25% additive jitter on both stages.

### Why

- senpi's `kimi-coding` provider talks to the same upstream service as the kimi-code CLI, so its own retry policy (10 attempts, shorter first waits, uncapped server hints) applies verbatim. Every other provider keeps senpi's existing default behavior byte-identical because the senpi-default profile delegates to the same functions that already drive it.

### Why an extension could not handle it

- The retry decision lives inside this package's streaming adapters and the failure-catch boundary, before any extension hook observes the error. The profile must be resolved at the provider level to affect classification, delay, and fallback routing together.

### Expected merge conflict zones

- MEDIUM: `packages/ai/src/models.ts` Provider/CreateProviderOptions field lists and the `createProvider` forwarding block.
- MEDIUM: `packages/ai/src/api/anthropic-messages.ts` catch boundary (diagnostic emission before errorMessage assignment).
- LOW: `packages/ai/src/utils/diagnostics.ts` diagnostic union (append-only).
- LOW: `packages/ai/src/utils/retry-profile/` (new tree, no upstream owner).

## 2026-08-23 - Browser-safe credential pool slot algebra

### What changed

- `packages/ai/src/auth/pool/slots.ts` (new): pure slot algebra over the stored `Credential` - `listSlots`, `findSlot`, `upsertSlot`, `removeSlot`, `pinSlot`, `assertValidSlotName`, plus `CredentialSlot` / `PooledCredential` types. A credential with no `accounts` array is read as a one-slot pool named `default` derived from its flat fields without any write-back; `upsertSlot` replaces or appends one slot while every sibling, the pin, and the flat top-level credential survive untouched. Exported as the new subpath `@earendil-works/pi-ai/auth/pool/slots`.
- `packages/ai/package.json`: added the `./auth/pool/slots` export mapping.
- `packages/ai/src/models.ts`: `login()` now appends the fresh credential to a pool as a generated `login-N` slot instead of replacing the provider entry (flat/absent entries keep today's whole-write shape); `logout()` accepts `slotId` to remove exactly one slot (no-slot keeps remove-everything); `resolveRefreshCredential()` merges the rotated token back via `mergeRefreshed` so sibling slots and the pin survive a refresh.
- `packages/ai/src/auth/resolve.ts`: the request-path OAuth refresh applies the same `mergeRefreshed` before persisting.

### Why

- Multi-account credential pools need one shared, provider-neutral definition of slot shape and slot-preserving mutation. The module is pure data transformation with zero I/O so the auth root stays browser-safe, and consumers (coding-agent storage, later affinity/failover) import it rather than redefining it.

### Why an extension could not handle it

- The slot shape extends the stored `Credential` contract defined in this package's `src/auth/types.ts`; extensions cannot author new credential-envelope types or their canonical mutation semantics.

### Expected merge conflict zones

- LOW: new file with no upstream counterpart; the `package.json` export insertion sits beside `./oauth`.

## 2026-08-20 - Google FinishReason exhaustiveness after the @google/genai 2.18.0 bump

### What changed

- `packages/ai/src/api/google-shared.ts`: `mapStopReason` handles the new `FinishReason.TOO_MANY_TOOL_CALLS` member alongside `UNEXPECTED_TOOL_CALL`, mapping it to the `"error"` stop reason.

### Why

- `@google/genai` 2.18.0 adds that enum member, and the switch closes with a `const _exhaustive: never = reason` guard, so `tsc --noEmit` failed until the new case was handled. Grouping it with the other tool-calling aborts keeps the existing semantics: a run that was stopped by the provider rather than completing is surfaced as an error.

### Why an extension could not handle it

- The mapping runs inside this package's Google streaming adapter, on the provider response path that produces the stop reason an extension would only observe after the fact.

### Expected merge conflict zones

- LOW: the `mapStopReason` case list, which grows only when the upstream SDK adds finish reasons.

## 2026-08-20 - Cursor 0-token RE overflow without estimate gate

### What changed

- `packages/ai/src/utils/overflow.ts`: 0-token Cursor `resource_exhausted` is overflow even when the local estimate is 0; same-model remint helpers skip provider fallback; Cursor overflow compaction settings force `keepRecentTokens: 0` and disable restoration.

### Why

- The 50k estimate gate missed sessions whose last billed usage was zeroed after an earlier compact, so Cursor still rejected the payload while senpi treated it as a 429 and jumped providers.

### Why an extension could not handle it

- Overflow classification and retry fallback run in core before extension hooks.

### Expected merge conflict zones

- `packages/ai/src/utils/overflow.ts` after `getOverflowPatterns()`.

# AI Source Changes

## 2026-08-22 - Cursor heartbeat liveness and checkpoint resume retries

### What changed

- `packages/ai/src/api/cursor-agent.ts`: uses one 30s deadline since the last inbound frame of any kind, waits for local exec dispatches before retrying pre-completion stalls or transport termination, and rebuilds checkpointed attempts as `resumeAction` requests without re-resolving the selected model.
- `packages/ai/src/api/cursor-agent/stream-retry.ts` (new): contains the retry classification, 10-retry default policy, and official-style exponential backoff capped at 60s plus 0-20% jitter. Deterministic delay and budget options support transport harness tests.

### Why

- Cursor heartbeats and conversation checkpoints prove the server stream is alive, especially while a local exec handler is running. Killing heartbeat-only streams after 90s interrupted valid long-running tools. The official CLI instead retries a stream only after 30s with no inbound frame at all, resuming from the latest checkpoint when available.

### Why an extension could not handle it

- HTTP/2 termination, checkpoint caching, request action selection, and exec-dispatch draining all happen inside the native provider below extension-visible events.

### Expected merge conflict zones

- HIGH: `packages/ai/src/api/cursor-agent.ts` `stream()` HTTP/2 lifecycle and retry loop.
- LOW: `packages/ai/src/api/cursor-agent/types.ts` test-tuning options.

## 2026-08-21 - Cursor turn completion and stream health bounds

### What changed

- `packages/ai/src/api/cursor-agent.ts`: treats a decoded `turnEnded` frame as definitive application completion, drains tracked exec dispatches for at most `CURSOR_TURN_END_DRAIN_TIMEOUT_MS` (5000ms), then closes the client HTTP/2 stream instead of waiting for the server. Before `turnEnded`, `CURSOR_STREAM_HEALTH_FAIL_THRESHOLD_MS` (30000ms) bounds complete inbound silence and `CURSOR_STREAM_HEALTH_HEARTBEAT_ONLY_THRESHOLD_MS` (90000ms) bounds streams carrying only heartbeats or conversation checkpoints.

### Why

- Cursor can leave the HTTP/2 response open after all assistant content, exec results, usage, and `turnEnded` have arrived. The adapter previously waited exclusively for transport end, leaving the user-facing turn frozen until the generic 300000ms agent idle timeout. A server that stalls before `turnEnded` had the same five-minute escape path despite the official Cursor CLI bounding transport silence much sooner.

### Why an extension could not handle it

- Frame decoding, HTTP/2 stream ownership, exec-dispatch tracking, and the conversation-rotation retry loop all live inside the Cursor provider adapter below extension-visible events. Only this transport layer can distinguish heartbeat/checkpoint liveness from meaningful frames and close the active request after the authoritative completion signal.

### Expected merge conflict zones

- HIGH: `packages/ai/src/api/cursor-agent.ts` `stream()` HTTP/2 lifecycle, frame decode loop, and final exec drain; upstream and fork Cursor protocol changes commonly touch the same block.

## 2026-08-20 - Cursor conversation rotation composes with compact-before-rotate

### What changed

- `packages/ai/src/api/cursor-conversation-rotation.ts` (new): persists the base-id to wire-id mapping under the agent dir (`CODING_AGENT_DIR` / `~/.senpi/agent`, overridable with `CURSOR_CONVERSATION_ID_STORE`), caps rotation at `MAX_CURSOR_CONVERSATION_ROTATIONS` (3), and remints a fresh wire id after the skip so a session is never permanently blocked.
- `packages/ai/src/api/cursor-agent.ts` `stream()`: the FIRST 0-token `resource_exhausted` of a `stream()` call surfaces as an error with no rotation, so the session layer gets first refusal and can compact. Rotation, cache/blob migration, and same-stream retry apply only to attempts after the first within one `stream()` call. Once the base conversation has burned its 3 rotations, `shouldSkip()` surfaces `CURSOR_CONVERSATION_POISONED_MESSAGE` instead of rotating again.

### Why

- Rotating on the first failure swallowed the error inside `stream()`, so the compact-before-rotate policy added by #1015 (which fires in `agent-session` on a SURFACED 0-token RE via `isCursorPayloadResourceExhausted`) never ran. A large-payload rejection then burned all three rotations replaying the same oversized payload and still failed. Surfacing attempt 1 lets compaction shrink the payload first; rotation remains the fallback for a genuinely poisoned conversation id, which compaction cannot fix.

### Why an extension could not handle it

- The rotation map, the persisted wire id, and the h2 retry loop live inside `cursor-agent` `stream()`, below every extension hook; the retry must reuse the same in-flight event stream so `start` is emitted once.

### Expected merge conflict zones

- `packages/ai/src/api/cursor-agent.ts` `stream()` retry loop and its `catch` block.
- `packages/ai/src/api/cursor-conversation-rotation.ts` (whole file).

## 2026-08-20 - Cursor explicit levels prefer catalog suffix variant ids

### What changed

- `packages/ai/src/cursor/selection-descriptor.ts`: `resolveCursorSelectionDescriptor` now resolves an
  explicit thinking level to the catalog-guaranteed legacy suffix alias (`kimi-k3-high`,
  `claude-fable-5-thinking-low`, `gpt-5.3-codex-xhigh`) whenever one exists, via a new
  `suffixAliasId` that tries the level's wire value then the level token, with thinking-infixed
  candidates for thinking Claude identities. Bare base id + ordered parameters remains only as the
  fallback for levels without any alias; `legacySuffixId` is subsumed.

### Why

- Cursor's Run RPC now rejects bare capability ids with Connect `not_found` for every family
  (issue #1008; live probes 2026-08-20 in
  `local-ignore/qa-evidence/20260820-cursor-bare-id-notfound/`: bare `kimi-k3`+parameters and bare
  `claude-fable-5`+parameters both `not_found`, while `kimi-k3-high` and
  `claude-fable-5-thinking-low` complete), so every explicit level rendered as base+parameters died
  at turn start.

### Why an extension could not handle it

- The selection descriptor is core provider data consumed by both Cursor transports (protobuf
  `RequestedModel` and the CLI model string); no extension hook sits between them.

### Expected merge conflict zones

- `selection-descriptor.ts` resolver body and helper block (fork-only file; upstream has no cursor
  provider).

## 2026-08-19 - Ignore Cursor billed cacheRead that dwarfs usedTokens

### What changed

- `applyCheckpointTokenDetails` records `UsageState.liveUsedTokens`.
- `applyBilledTurnEndedUsage` ignores `cache_read_tokens` when it is more than 3× that live window and keeps `totalTokens` at `usedTokens`.

### Why

- Session 01a01879 jumped 148k → 4.09M because field 3 was dashboard-cumulative cache read, not conversation size. `max(usage, estimate)` then forced a useless compact and a 0-token `resource_exhausted`.

### Conflict zone

- `packages/ai/src/api/cursor-agent.ts` `applyBilledTurnEndedUsage` / `UsageState`.

## 2026-08-19 - OpenAI-family adapters re-diverge from the 59a71b23 pin

### What changed

- `packages/ai/src/api/openai-responses.ts`: keeps the fork's Responses request surface on top of the new
  pin — `serviceTier` forwarded as `service_tier` with `-fast`/Priority-tier cost correction
  (`getServiceTierCostMultiplier` / `applyServiceTierPricing`, flex 0.5x, priority 2x and 2.5x for
  `gpt-5.5`), the `max` ladder resolved through `supportsMax` / `supportsXhigh` / `clampMaxForOpenAI`
  instead of a flat clamp, the `web_search_preview` compat guard that strips the unsupported
  `web_search_call.action.sources` include, per-session WebSocket connection reuse with idle expiry, the
  three-way `sessionAffinityFormat` split (`openai` / `openai-nosession` / `openrouter`),
  `extraBody` merging, and null-aware `thinkingLevelMap` resolution where a mapped `null` means
  "reasoning unavailable" rather than "reasoning off".
- `packages/ai/src/api/openai-completions.ts`: compat resolution now lives in the shared browser-safe
  `utils/prompt-cache-ttl.ts` (`getOpenAICompletionsCompat`) and is re-exported from here, replacing the
  pin's file-local `detectCompat`/`getCompat` pair; the params type is a real
  `OpenAICompletionsRequestParams` (fork fields `tool_stream`, `chat_template_kwargs`,
  `reasoning_effort` typed instead of `as any` casts); Kimi K3 detection supplies
  `KIMI_K3_THINKING_LEVEL_MAP`; usage parsing reads cache-read tokens from
  `prompt_tokens_details.cached_tokens`, then DeepSeek's `prompt_cache_hit_tokens`, then Kimi's
  documented **top-level** `usage.cached_tokens` on the final usage chunk, and never subtracts writes;
  per-choice usage is typed via `ChatCompletionChoiceWithUsage`; `applyExtraBody` merges caller fields
  under `OPENAI_COMPLETIONS_RESERVED_BODY_KEYS`. The `thinkingTokenBudgetField` /
  `supportsThinkingTokenBudget` budget field upstream generalized is retained through the shared
  resolver rather than the pin's inline compat table.
- `packages/ai/src/api/openai-codex-responses.ts`: the fork splits WebSocket fallback/debug state into
  `openai-codex-responses/fallback-state.ts` and re-exports `OpenAICodexWebSocketDebugStats` from there;
  ChatGPT account identity resolves through `extractOpenAiCodexAccountId` with an `accountId ?? apiKey`
  affinity fallback, cache-affinity headers come from `applyOpenAICodexCacheAffinityHeaders`, the same
  `supportsMax`/`supportsXhigh`/`clampMaxForOpenAI` ladder applies, and `extraBody` merges under
  `OPENAI_RESPONSES_RESERVED_BODY_KEYS`.
- `packages/ai/src/api/azure-openai-responses.ts`: accepts upstream's `tool_choice` forwarding while
  keeping the fork's additions — the `supportsMax` effort ladder in `streamSimple`, `prompt_cache_key`
  suppressed when the effective `cacheRetention` (option or `model.cacheRetention`) is `"none"`, the
  null-aware `thinkingLevelMap` resolution with `reasoningRequested` / `reasoningUnavailable`, and
  `reasoningSummary: null` omitting the summary field entirely.
- `packages/ai/src/api/simple-options.ts`: fork-owned shared option layer — `applyExtraBody` plus the
  six per-provider reserved-key sets (OpenAI Completions/Responses, Google, Anthropic, Mistral,
  Bedrock), `clampMaxForOpenAI`, `cacheRetention` defaulting to `model.cacheRetention`,
  `abortServerSideFallback` and `extraBody` carried onto base options, integer/finite clamping in
  `clampMaxTokensToContext`, and `adjustMaxTokensForThinking` treating an unresolvable level as
  "no thinking" (budget 0) instead of producing a NaN budget.

### Why

- These are the fork's paid-tier accounting, provider-affinity, and wire-compat contracts. Upstream
  `59a71b235d` has no service-tier pricing, no `-fast` Priority variants, no Kimi top-level cached-token
  form, no `extraBody` seam, and no shared compat resolver, so each re-diverges on merge. The Kimi read
  in particular is a correctness fix: Kimi reports cache reads only at `usage.cached_tokens`, so without
  the top-level branch every Kimi turn bills cache reads as fresh input.

### Why an extension could not handle it

- Request-body construction, usage/cost parsing, WebSocket session reuse, and affinity headers all run
  inside the provider adapters, below every extension-visible surface. An extension cannot rewrite a
  streamed usage chunk into corrected cost, nor inject a header on a socket it never sees.

### Expected merge conflict zones

- HIGH: `openai-responses.ts` `buildParams` / request construction and the usage-and-cost block;
  `openai-completions.ts` compat import and params typing (upstream owns the same `detectCompat` hunk —
  keep the shared resolver when resolving).
- MEDIUM: `openai-codex-responses.ts` fallback-state extraction and affinity header application;
  `azure-openai-responses.ts` `buildParams` reasoning block.
- LOW: `simple-options.ts` reserved-key sets and clamp helpers.

## 2026-08-19 - Google, Anthropic, Bedrock, and Mistral adapters re-diverge from the 59a71b23 pin

### What changed

- `packages/ai/src/api/google-shared.ts`: tool-call ids normalize through the shared collision-safe
  `utils/tool-call-id.ts` instead of the pin's local `replace(...).slice(0, 64)` truncation;
  `convertMessages` takes `preserveThinking` so a non-reasoning turn drops thinking state;
  `sanitizeForOpenApi` recurses into arrays; the position-aware `stripOptional` removes the non-standard
  `optional` keyword from schema-keyword position only, preserving it as a property name under
  `properties`/`patternProperties`/`$defs`/`definitions` and never traversing the value keywords
  `const`/`default`/`examples`/`enum`; `toProviderNativeContent` maps unrecognized Gemini parts
  (`executableCode`, `codeExecutionResult`, or the dominant part key) onto the fork's
  `providerNative` content block.
- `packages/ai/src/api/google-generative-ai.ts` and `packages/ai/src/api/google-vertex.ts`: both take
  upstream's thinking-level direction but keep the fork's thinking-off routing — a runtime `"off"`
  handed through the `ThinkingLevel`-typed `reasoning` option, and a post-clamp `"off"`, both take the
  disabled wire form rather than an enabled one, which a post-clamp check alone cannot see because
  Gemini 3 maps `off` to `null`. Both also emit `providerNative` blocks for unhandled parts and for
  once-per-response `groundingMetadata` / `urlContextMetadata`, merge `extraBody` into the inner
  `config` under `GOOGLE_RESERVED_BODY_KEYS`, and pass `preserveThinking` into `convertMessages`.
  `google-generative-ai.ts` additionally replaces the pin's `as any` thinking-level casts with a typed
  `THINKING_LEVEL_MAP` onto the SDK's `ThinkingLevel` enum; `google-vertex.ts` drops the
  `Model<"google-generative-ai">` casts in favor of `Pick<Model<Api>, "id">` predicates and takes plain
  header records so `providerHeadersToRecord` is applied once at the client boundary.
- `packages/ai/src/api/anthropic-messages.ts`: keeps the fork's adaptive-thinking surface — the
  `ADAPTIVE_THINKING_MODEL_MARKERS` and `NATIVE_XHIGH_EFFORT_MODEL_MARKERS` families, the
  `forceAdaptiveThinking` compat override, `sanitizeAdaptiveThinkingPayload` /
  `sanitizeAdaptiveThinkingHeaders` (which rewrite `thinking` to `{type: "adaptive"}` with an
  `output_config.effort`, and strip the interleaved-thinking beta an adaptive family rejects), the
  computer-use beta stripper for families that reject it, effort pinned low on a degraded/disabled turn,
  the shared `getAnthropicCompat` / `isAnthropicApiBaseUrl` prompt-cache-TTL resolver behind the `1h`
  retention decision, and server-side-fallback receipt handling.
- `packages/ai/src/api/bedrock-converse-stream.ts`: keeps `cacheRetention` falling back to
  `model.cacheRetention`, `preserveThinking` on message conversion, shared `normalizeToolCallId`,
  `applyExtraBody` with `BEDROCK_RESERVED_BODY_KEYS`, the Mythos 5 adaptive-family marker, and the
  custom-header build-step middleware — now guarded so no middleware is registered for an empty header
  map and narrowed through a `hasHeaders` type guard rather than an inline cast. Upstream's response
  smithy-header deserialize middleware is accepted in the same inline-registration form.
- `packages/ai/src/api/mistral-conversations.ts`: keeps `preserveThinking` (derived from
  `promptMode === "reasoning"` or an explicit `reasoningEffort`) on message transformation and
  `applyExtraBody` with `MISTRAL_RESERVED_BODY_KEYS`, plus the block-type narrowing in `toChatMessages`
  that skips non-`toolCall` blocks instead of coercing them.

### Why

- Every item here is a wire contract the fork resolved against live provider behavior: truncating tool
  ids can collapse two distinct calls into one id, replaying thinking state into a non-reasoning turn is
  rejected, an adaptive Anthropic family 400s on `thinking: {type: "disabled"}` and on the interleaved
  beta, Gemini 3 cannot express thinking-off through a budget, and `optional` is not a JSON Schema
  keyword Gemini accepts. Upstream's new thinking-level maps do not encode any of these, so the fork's
  routing must survive the merge.

### Why an extension could not handle it

- Message conversion, tool-schema emission, beta-header negotiation, and Smithy middleware registration
  happen inside the adapters while constructing the outbound request; there is no hook between the
  adapter and the provider SDK where an extension could observe or repair them.

### Expected merge conflict zones

- HIGH: `anthropic-messages.ts` `buildParams` and the beta-header/payload sanitizers.
- MEDIUM: `google-shared.ts` `convertMessages` and `convertTools`; the `streamSimple` thinking branches
  in `google-generative-ai.ts` and `google-vertex.ts`; `bedrock-converse-stream.ts` middleware
  registration and command-input construction.
- LOW: `mistral-conversations.ts` payload build and stream-block narrowing.

## 2026-08-19 - Public type and export surface re-diverges from the 59a71b23 pin

### What changed

- `packages/ai/src/types.ts`: carries the fork's request and content contracts — the compaction
  affinity/request-identity split (`affinitySessionId`, the stable originating-session identity that
  survives auxiliary calls which replace `sessionId`, plus `streamKind: "main" | "auxiliary"` where an
  absent value must be read as auxiliary), `abortServerSideFallback`, `extraBody`, the three-argument
  `onPayload` with `ProviderRequestMetadata` (effective model plus fully transformed headers),
  `ThinkingSelection` provenance, `thinkingBudgets.max`, thinking-block `startedAt`/`endedAt`, the
  `incomplete`/`errorMessage` tool-call carriers used by text tool-call recovery, `isVideoMimeType` and
  video payloads riding `ImageContent`, the `providerNative` block, the local `OpenAIResponsesCompat`
  extension adding `supportsAdditionalTools`, and the fork-only `cursor-agent` API plus
  `alibaba-token-plan` / `cursor` / `ollama` / `opengateway` provider ids and the `openai-images` images
  API.
- `packages/ai/src/index.ts`: publishes the fork's core export surface that upstream has no counterpart
  for — the cursor capability/grouping/selection API and cursor pi-args helpers, `getApiProvider`,
  `convertResponsesMessages`, `warmPromptCache`, `sanitizeAnthropicToolPairs`, the tool-call middleware
  entry points (`wrapStreamWithToolCallMiddleware`, `shouldRecoverTextToolCalls`,
  `hasKimiTextToolCallRecovery`, the XTML recovery stream parser), context provenance,
  `env-api-keys`, `auth/headers`, prompt-cache TTL constants, server-fallback receipts, stop details,
  tool-pair repair, visible text, block symbols (`kCursorExecResolved`), wire identity
  (`getWireIdentity` / `setWireIdentity`, the senpi branding seam), and `extractOpenAiCodexAccountId`.

### Why

- These two files are the seam through which `packages/agent` and `packages/coding-agent` reach every
  fork behavior recorded elsewhere in this tracker. If the merge took the pin's version, the affinity
  split, provenance-bearing thinking selection, provider-native blocks, and the entire cursor and
  tool-call-middleware surface would stop being reachable and the dependent packages would not compile.

### Why an extension could not handle it

- An extension consumes these types and exports; it cannot add a field to a core request interface or
  publish a package entry point that other workspace packages import.

### Expected merge conflict zones

- HIGH: `index.ts` export ordering — upstream appends to the same alphabetized lists, so nearly every
  sync conflicts here; resolve by keeping both sides' exports.
- MEDIUM: `types.ts` `ProviderRequestOptions` / `StreamOptions` / `SimpleStreamOptions` members and the
  `KnownProvider` / `KnownApi` unions.

## 2026-08-18 - Cursor context windows tracked to the models.dev first-party SSOT

### What changed

- `packages/ai/src/cursor/model-capabilities.ts`: window values now derive from the models.dev
  first-party catalog capped by the `context` options Cursor actually offers each family, and the
  capability gains `requestContext` — the context token matching the advertised window.
- `packages/ai/src/cursor/selection-descriptor.ts`: the wire mapper emits
  `requestContext ?? defaultContext`, so a family advertising 1M also asks Cursor for `context=1m`.

### Why

- Claude families were encoded at 300000, copied from the cursor-agent CLI listing's stale
  "(300K context)" display labels; models.dev, Cursor's `1m` context option, and the models' own "1M"
  display names all agree they are 1000000. Advertising a window larger than the context the request
  asks for would let compaction overrun what Cursor was told to allocate, so the two values are one
  contract and are now verified together.

### Why an extension could not handle it

- The capability table and the protobuf/CLI wire mapper are core provider data consumed by both
  Cursor transports; no extension hook sits between them.

### Expected merge conflict zones

- `model-capabilities.ts` family table and helper signatures, `selection-descriptor.ts` parameter switch.

## 2026-08-18 - Sanitize JSON-Schema composition keywords from advertised Cursor tool schemas

### What changed

- `packages/ai/src/api/cursor-agent.ts`: new exported `sanitizeCursorToolSchema` helper plus
  `CURSOR_UNSUPPORTED_SCHEMA_KEYS`; `buildMcpToolDefinitions` now recursively strips `oneOf`,
  `anyOf`, and `allOf` from every advertised tool's inputSchema before proto encoding. `not` and
  all other keywords pass through untouched. Returns new structures (input never mutated).

### Why

- An advertised tool whose inputSchema carries a composition keyword makes Cursor's gateway
  reject the ENTIRE request upstream with a wrapped provider 400 (`ERROR_PROVIDER_ERROR`, zero
  tokens, `resource_exhausted` end-stream) — proven by live A/B on 2026-08-18 with a minimal
  single-tool `oneOf`/`anyOf`/`allOf` repro against `claude-fable-5-thinking-xhigh`. External MCP
  servers ship such schemas routinely (ast-grep's `scan` uses a top-level `oneOf`), so every
  session registering one failed on the cursor provider from turn 1.

### Why an extension could not handle it

- `buildMcpToolDefinitions` runs inside the cursor-agent Run-request construction path; the
  advertised schema bytes are serialized before any extension-visible surface exists.

### Expected merge-conflict zones

- `packages/ai/src/api/cursor-agent.ts` (`buildMcpToolDefinitions` / schema helpers) — same zone
  as the reasoning-levels entry; test file
  `packages/ai/test/cursor-tool-schema-sanitize.test.ts` is new.

## 2026-08-18 - Cursor reasoning levels end to end

### What changed

- `src/cursor/model-capabilities.ts`, `src/cursor/cursor-variant-aliases.json`: committed static capability table
  (windows, parameter orders, exact level encodings incl. GPT 5.5/Codex 5.3 `extra-high` and off=`none` families)
  plus the 204-id alias index, both derived from the live aiserver.v1 AvailableModels capture of 2026-08-18.
- `src/cursor/catalog-grouping.ts`: lossless variant parser + grouping (Claude `base`/`base-thinking` boolean axis,
  fast variants retained raw) with total seven-key thinkingLevelMaps; golden 204->113/32 pinned by fixture test.
- `src/cursor/selection-descriptor.ts`: transport-neutral selection resolver (parameters vs suffix-id encodings)
  shared by the native protobuf lane and the `cursor-cli-oauth` extension.
- `src/cursor/store-migration.ts`: idempotent stored-catalog regrouping.
- `providers/cursor.ts`: discovery now publishes grouped identities with `compat.cursorReasoning` and correct
  windows; `api/cursor-agent.ts` renders `options.thinkingSelection` into `RequestedModel.parameters`; absent
  selections keep the representative-variant request shape byte-exactly.
- `packages/ai/src/index.ts`: re-exports the shared cursor capability, grouping, and selection API.
- `packages/ai/src/models.ts`: new `restoreModels` provider hook (try/catch — stored catalog survives a throwing transform).
- `packages/ai/src/types.ts` / `packages/ai/src/model.ts`: `ThinkingSelection` type + `CursorAgentCompat.cursorReasoning` capability gate.

### Why

- The Cursor catalog exposed 204 expanded variant ids with reasoning disabled, so senpi thinking
  levels could not reach the wire and context windows came from stale name heuristics.

### Why an extension couldn't do it

- Provider discovery normalization, protobuf Run-request construction, agent-loop option propagation, and the
  models-store restore path are core runtime seams an extension cannot reach.

### Expected merge-conflict zones

- `api/cursor-agent.ts` (Run-request builder + streamSimple), `providers/cursor.ts`, `models.ts` restore path,
  `types.ts` SimpleStreamOptions, `packages/agent/src/agent-loop.ts` prepareNextTurn merge.

## 2026-08-17 - Cursor exec result closure + per-exec heartbeats

### What changed and why

- `api/cursor-agent.ts`: recognised exec frames now run inside one lifecycle boundary. While a handler is pending,
  the client emits `ExecClientControlMessage.heartbeat` with the numeric `ExecServerMessage.id` after 3 seconds and
  schedules each later heartbeat only after the prior HTTP/2 write completes. When a normal typed result sequence
  finishes — including typed rejection/error results and streamed shell results — the client clears the heartbeat
  and emits exactly one `ExecClientControlMessage.streamClose` for the same numeric id.
- Unknown/unset frame fallback remains `ExecClientThrow` followed by `streamClose`; `ExecClientThrow` itself is now
  a throw-only primitive so the recognised lifecycle and unknown fallback each own exactly one close.
- Direct capture of `cursor-agent` `2026.08.11-e8db854` established the contract: a normal `readResult` is followed
  by `streamClose`, and the bundled dispatcher uses write-completion-chained 3-second exec heartbeats. Senpi's prior
  port inherited oh-my-pi's result-only behaviour for most exec families, leaving the server-side exec pending until
  the Run stream could end before `turnEnded`.
- `test/cursor-agent.test.ts` registers focused lifecycle cases split between a small behavior module and reusable
  h2 harness. They pin typed success/rejection closure, pending-handler heartbeat write serialization and cleanup,
  unexpected-dispatch throw-close recovery, unknown fallback, and exactly-once shell-stream closure.

### Why this cannot be expressed as an extension

- Heartbeats and close controls must be written on the same provider-owned HTTP/2 Connect stream while the server is
  blocked on a local tool result. Extensions can observe the outer agent turn but cannot own provider-internal exec
  control frames or their write-completion timing.

### Expected merge conflict zones

- MEDIUM: `api/cursor-agent.ts` around `handleExecServerMessage`, the exec heartbeat scheduler, and exec control
  writers. Reapply the single lifecycle owner if upstream changes individual result branches.
- LOW: `test/cursor-agent-exec-lifecycle-{cases,harness}.ts` and the permanent senpi-qa scenario are fork-only
  coverage registered by `test/cursor-agent.test.ts`.

> Audit backfill (2026-08-17): the entries between this note and the pre-existing `2026-08-16` Cursor
> entries were recorded during the repository-wide changes.md audit of divergences from the upstream pin
> (v0.84.2, `914cf1472e`); each is dated by its underlying work and gives its audited production paths a
> canonical four-section record.

## Upstream v0.84.2 sync on the pinned OpenAI SDK (PR #892) (2026-08-16)

### What changed

- `packages/ai/src/api/openai-responses-shared.ts`: the PR #892 upstream merge brought deferred-tools
  support that constructs an `additional_tools` input item. That member exists only in openai@6.40.0's
  `ResponseInputItem` union while the fork deliberately pins openai@6.26.0, so the merged source did not
  typecheck; the local `AdditionalToolsInputItem` type extends the pinned union instead of bumping the
  dependency, leaving the wire payload unchanged.
- `packages/ai/src/api/openai-responses.ts`: the merge kept the fork's Responses additions (service-tier
  pricing for `-fast` variants, native image-generation item reconciliation, the `web_search_preview`
  compat guard, `supportsMax`-aware effort handling) while accepting upstream's deferred-tools plumbing.
- Accepted upstream v0.84.2 transports that arrived with the same sync: Kimi Coding requests send the
  shared `pi (<platform>)` User-Agent (`utils/pi-user-agent.ts`, unchanged from the pin), Google length
  stops are preserved when tool calls are present (`packages/ai/src/api/google-generative-ai.ts`,
  `packages/ai/src/api/google-shared.ts`, `packages/ai/src/api/google-vertex.ts`), the Mistral
  Conversations HTTP transport rework landed in `packages/ai/src/api/mistral-conversations.ts`, and
  delayed GitHub Copilot device-code polling was accepted in the OAuth flow.
- `packages/ai/src/api/constrained-sampling.ts`: `constrainedSampling: false` is honored as an explicit
  opt-out, distinct from an absent value, in both the strict-JSON and grammar resolvers.
- The Google files' remaining pin divergence is the fork's own work recorded in the 2026-07-25/07-26
  entries (thinking-off routing, shared collision-safe tool-call-id normalization); Mistral keeps the
  fork's `preserveThinking` and `applyExtraBody` additions.

### Why

- The fork tracks upstream provider transports to stay mergeable but cannot take upstream's floating
  `openai` SDK pin: the pinned SDK is a deliberate dependency decision, so upstream type-level work must
  be repaired locally rather than pulled in through a version bump.

### Why an extension could not handle it

- Wire item types, transport construction, and stop-reason normalization live inside the provider
  adapters, below every extension-visible surface; an extension cannot widen SDK request unions or repair
  streaming transports.

### Expected merge conflict zones

- HIGH: `packages/ai/src/api/openai-responses-shared.ts` message conversion (upstream owns the same
  hunk; keep the local union extension when resolving).
- MEDIUM: `packages/ai/src/api/openai-responses.ts` request construction and the Google adapters' stop
  handling.
- LOW: `packages/ai/src/api/mistral-conversations.ts` and `packages/ai/src/api/constrained-sampling.ts`.

## Bedrock Converse adapter divergence (2026-08-16)

### What changed

- `packages/ai/src/api/bedrock-converse-stream.ts`: the prompt-cache predicates (`supportsPromptCaching`
  and the Bedrock Claude 4.5 one-hour-TTL allowlist) moved into the browser-safe
  `utils/prompt-cache-ttl.ts` and are re-exported here, so the wire request and the TTL estimate share one
  definition; `cacheRetention` falls back to `model.cacheRetention`; message conversion takes
  `preserveThinking` so non-reasoning turns drop thinking state.
- Tool-call ids normalize through the shared collision-safe `normalizeToolCallId`
  (`utils/tool-call-id.ts`), replacing the adapter's local 64-character truncation that could collapse two
  distinct over-long ids into duplicate tool ids.
- `extraBody` pass-through applies `applyExtraBody` with `BEDROCK_RESERVED_BODY_KEYS`; custom headers are
  injected through a typed inline Smithy build-step middleware (reserved `x-amz-*`/`authorization`/`host`
  headers ignored to preserve SigV4 signing, no middleware added when the header map is empty); the
  command input is typed as `ConverseStreamCommandInput`.
- Mythos 5 joins the adaptive-family markers so a thinking-off turn cannot fall through to a budget-based
  request.

### Why

- Bedrock cache points, SigV4-signed headers, and tool-id pairing are wire contracts resolved inside the
  adapter; divergent copies between the adapter, the TTL resolver, and the other Anthropic-compatible
  adapters previously produced wrong TTL estimates and duplicate tool ids.

### Why an extension could not handle it

- AWS SDK request assembly and the Smithy middleware stack are constructed inside `packages/ai` before
  any extension hook can observe or rewrite the signed request.

### Expected merge conflict zones

- MEDIUM: cache-point construction, header middleware, and message conversion in
  `packages/ai/src/api/bedrock-converse-stream.ts`.

## OAuth loader registry, compatibility surface, and auth resolution (2026-08-16)

### What changed

- `packages/ai/src/auth/oauth/load.ts` and `packages/ai/src/bun-oauth.ts`: the `cursor` OAuth flow joined
  the lazy loader registry and the standalone-Bun static bundle (details in the Cursor OAuth entry
  below).
- `packages/ai/src/oauth.ts`: the extension compatibility entry point re-exports `loadAnthropicOAuth`
  and `registerBundledOAuthFlowLoaders` so extension providers can reuse the Anthropic PKCE machinery;
  previously the entry was type-only.
- `packages/ai/src/compat/extension-oauth-types.ts`: legacy extension OAuth declarations gained the
  `OAuthProviderId` alias, an optional `OAuthSelectOption.description`, and readonly select options.
- `packages/ai/src/auth/resolve.ts` and `packages/ai/src/auth/types.ts`: stored OAuth credentials refresh
  before the optional side-effect-free `check` runs, sentinel envelopes with zero usable accounts no
  longer bypass availability, request environment merges transiently for `check()`/`toAuth()` and
  auxiliary replay without persisting request secrets, explicit empty request values mask host values,
  and `ApiKeyAuth.ambientOnly` marks compatibility adapters fallback-only.

### Why

- Availability must not report a provider configured from dead or empty credentials, and auxiliary
  streams (compaction) must keep the same account affinity. The legacy extension OAuth types must keep
  compiling for coding-agent extensions while the real loader registry grows.

### Why an extension could not handle it

- The loader registry, Bun bundle registration, and the stored-credential short-circuit inside
  `resolveProviderAuth` are package-internal seams that run before extension request hooks exist.

### Expected merge conflict zones

- MEDIUM: `packages/ai/src/auth/resolve.ts` precedence and derivation branches.
- LOW: loader lists in `packages/ai/src/auth/oauth/load.ts` and `packages/ai/src/bun-oauth.ts`; additive
  fields in `packages/ai/src/auth/types.ts` and
  `packages/ai/src/compat/extension-oauth-types.ts`; the export block in `packages/ai/src/oauth.ts`.

## Shared retry, overflow, and event-stream utilities (2026-08-16)

### What changed

- `packages/ai/src/utils/retry.ts`: the bounded retry loop gained the throw-based `retryTransientCall`
  sibling and the exported string classifier `isRetryableErrorMessage`, stream-stall and timeout
  classifiers, and pattern updates — the gateway "model request was rejected" wording is retryable while
  malformed tool-schema rejections and Anthropic `credits_required` exhaustion are terminal; Cloudflare
  522 and Codex `upstream_unavailable` join the transient set.
- `packages/ai/src/utils/provider-retry.ts`: 429 retry-after hints propagate as structured
  `ProviderRetryDelayError` (canonical markers from `utils/retry-hint.ts`), and the first stream chunk is
  prefetched inside the bounded policy so pre-output failures retry without replaying started streams.
- `packages/ai/src/utils/overflow.ts`: gateway HTTP 413 byte-size rejections ("Request body too large",
  "Request Entity Too Large", `body_too_large`, "Payload Too Large") classify as context overflow so
  shrink-retry recovery runs instead of dead-ending the session.
- `packages/ai/src/utils/event-stream.ts`: the event queue uses a ring-buffer head with compaction, the
  final-result promise rejects on stream failure (with an unhandled-rejection guard), and
  `trackLocalWork`/`hasPendingLocalWork` attribute mid-stream silence to local tool work for idle
  watchdogs.

### Why

- Transient-vs-terminal classification, overflow recovery, and stream lifecycle are the provider-neutral
  boundary every caller keys off; duplicated per-consumer copies diverge and wedge sessions.

### Why an extension could not handle it

- These utilities run below the extension-visible assistant message; extensions consume their verdicts
  through the retry loop and cannot add error classes or repair stream lifecycles from outside.

### Expected merge conflict zones

- MEDIUM: pattern lists and classifier functions in `packages/ai/src/utils/retry.ts`; hint propagation in
  `packages/ai/src/utils/provider-retry.ts`.
- LOW: `packages/ai/src/utils/overflow.ts` pattern list; `packages/ai/src/utils/event-stream.ts` queue
  internals.

## Adapter option normalization: extraBody, reasoning ladders, affinity (2026-08-16)

### What changed

- `packages/ai/src/api/simple-options.ts`: `applyExtraBody()` merges user pass-through fields into
  provider payloads while skipping per-provider reserved-key sets
  (`OPENAI_COMPLETIONS_RESERVED_BODY_KEYS` and the Mistral, Bedrock, and Google inner-`config` sets) so
  users cannot stomp library-managed fields.
- `packages/ai/src/api/openai-completions.ts`: map-less thinking-level ladders for Kimi K3, DeepSeek,
  MiMo, GLM 5.x, and Ollama; Kimi's flat `usage.cached_tokens` parsed after the nested forms;
  OpenRouter-style session affinity (`x-session-id` plus body `session_id`); replayed tool-call ids
  sanitized to the strict OpenAI-compatible shape; Moonshot/final-boundary tool-schema normalization;
  and header-only credential clients without a synthetic bearer key.
- `packages/ai/src/api/azure-openai-responses.ts`: `max` maps through `supportsMax` (clamped to `high`
  otherwise), `thinkingLevelMap` wins for adapter options, and `cacheRetention: "none"` omits
  `prompt_cache_key`.
- `packages/ai/src/api/openai-prompt-cache.ts`: `applyOpenAICodexCacheAffinityHeaders()` applies the
  complete Codex affinity tuple (`session-id`, `thread-id`, `x-client-request-id`) beside the clamped
  `prompt_cache_key`.

### Why

- Option derivation, capability ladders, and affinity headers are decided while each adapter builds its
  wire payload; one shared reserved-key and ladder policy prevents the per-adapter drift that produced
  rejected requests and silently lost capability levels.

### Why an extension could not handle it

- The final request object is assembled inside the adapter after `onPayload`; extensions cannot reserve
  provider-managed fields, remap reasoning levels, or attach transport headers reliably.

### Expected merge conflict zones

- MEDIUM: `packages/ai/src/api/simple-options.ts` reserved sets and
  `packages/ai/src/api/openai-completions.ts` request construction.
- LOW: `packages/ai/src/api/azure-openai-responses.ts` payload construction and the header helper in
  `packages/ai/src/api/openai-prompt-cache.ts`.

## Canonical record for images builtin registration (2026-08-11)

### What changed

- `packages/ai/src/providers/images/register-builtins.ts`: registers the `openai-images` ImagesApi as a
  lazy builtin beside `openrouter-images`, generalizes `createLazyLoadErrorImages` over `ImagesApi`, and
  normalizes module-load failures into `AssistantImages` error envelopes. Semantics and coverage live in
  the two OpenAI-images entries below; this entry supplies the canonical four-section record for the
  audited path.

### Why

- Same as the entries below: builtin registration runs at module load inside `packages/ai` and must keep
  the images SDK out of the initial bundle.

### Why an extension could not handle it

- External providers register through the public images registry but cannot supply the lazy
  module-promise boundary that builtin registration owns.

### Expected merge conflict zones

- LOW: additive registration entries in `packages/ai/src/providers/images/register-builtins.ts`.

## Dynamic product wire identity (2026-08-10)

### What changed

- `packages/ai/src/index.ts` exports `getWireIdentity`/`setWireIdentity` from the browser-safe
  `wire-identity.ts` module (default token `senpi`).
- `packages/ai/src/api/openai-codex-responses.ts` builds the Codex `originator` and `User-Agent` from
  the dynamic identity instead of the previously hardcoded `senpi` strings.
- `packages/ai/src/auth/oauth/openai-codex.ts` derives the OAuth flow's default `originator` from the
  same identity.

### Why

- A distribution repackaging this stack sets its product token once at startup; a standalone install
  keeps the default. One source of truth replaces per-site hardcoded strings that had already diverged
  once (upstream `pi` versus fork `senpi`).

### Why an extension could not handle it

- Header construction and the OAuth originator default happen inside `packages/ai` request builders and
  auth flows, below extension hooks.

### Expected merge conflict zones

- LOW: additive root exports in `packages/ai/src/index.ts`.
- MEDIUM: `packages/ai/src/api/openai-codex-responses.ts` header builders and the originator default in
  `packages/ai/src/auth/oauth/openai-codex.ts`, where upstream hardcodes `pi`.

## Request-option and content contract: metadata hooks, affinity, native blocks (2026-08-07)

### What changed

- `packages/ai/src/types.ts`: `onPayload` gained the optional `ProviderRequestMetadata` third argument
  (effective model plus fully transformed headers); `ProviderRequestOptions` gained `affinitySessionId`
  (stable session identity preserved across auxiliary calls such as compaction, consumed by the
  claude-sdk-oauth lane for account affinity) and `streamKind` (`main` or `auxiliary`, absent treated as
  auxiliary as the fail-safe); `ProviderNativeContent` surfaces provider-native blocks verbatim on
  assistant content; `OpenAICompletionsCompat.supportsAdditionalTools` gates the deferred
  additional-tools path; and video payloads ride `ImageContent` with `isVideoMimeType()` for models
  declaring the `video` input modality.
- `packages/ai/src/utils/text.ts`: `contentText()` accepts `ProviderNativeContent` blocks and extracts
  their embedded text.

### Why

- Payload hooks needed the post-transform header set to make informed decisions; auxiliary streams were
  re-rolling account affinity; providers emit native blocks (web-search results, grounding metadata)
  that lossy normalization dropped; and the modality and compat facts must be typed once for every
  consumer.

### Why an extension could not handle it

- These are the exported contracts extensions compile against and the content shapes produced inside
  provider streams; standalone `pi-ai` consumers need them before any coding-agent extension runs.

### Expected merge conflict zones

- MEDIUM: `packages/ai/src/types.ts` option and content unions (upstream owns adjacent members).
- LOW: `packages/ai/src/utils/text.ts` content union.

## Cross-provider message transform contract (2026-07-20)

### What changed

- `packages/ai/src/api/transform-messages.ts`: tool results pair by source position (the earliest
  still-unconsumed matching result after the declaring assistant, or exactly one synthetic error result),
  video-mime blocks downgrade to placeholders for models without the `video` modality, and
  `TransformMessagesOptions.preserveThinking` (default true) lets non-reasoning turns drop provider
  thinking state.

### Why

- Delayed or duplicated results mis-attached across user turns; unsupported video blocks crossed model
  handoffs to rejecting providers; preserved thinking on thinking-off turns produced invalid requests.

### Why an extension could not handle it

- History normalization runs during provider request serialization, below extension-visible payloads.

### Expected merge conflict zones

- MEDIUM: the second-pass pairing loop and media-downgrade pass in
  `packages/ai/src/api/transform-messages.ts`.

## Lazy stream iterator cancellation (2026-07-20)

### What changed

- `packages/ai/src/api/lazy.ts`: `LazyAssistantMessageEventStream` overrides `[Symbol.asyncIterator]` so
  a consumer's `return()` (early break, abort) invokes a cancellation handler that awaits the deferred
  provider iterator's `return` exactly once; `forwardStream` iterates the inner iterator manually instead
  of `for await`.

### Why

- Breaking out of a lazy stream previously never reached the not-yet-consumed inner iterator, leaving
  the in-flight provider request running (billing and resources) when consumers terminate early.

### Why an extension could not handle it

- The lazy wrapper is the package's sanctioned dynamic-import seam; cancellation semantics are part of
  the stream contract it owns.

### Expected merge conflict zones

- LOW: `packages/ai/src/api/lazy.ts` stream wrapper.

## Token estimation and UUIDv7 generator maintenance (2026-07-14)

### What changed

- `packages/ai/src/utils/estimate.ts`: `estimateMessageTokens` counts `providerNative` blocks (subtype
  plus raw JSON length) instead of misreading them as tool calls.
- `packages/ai/src/utils/uuid.ts`: typed-array generics (`Uint8Array<ArrayBuffer>`), a hoisted `crypto`
  local, and the extracted `formatUuid()` helper keep the time-ordered UUIDv7 generator compiling under
  the repo's TypeScript pin.

### Why

- Overflow prediction under-counted turns carrying native blocks; the generator must stay typecheck-clean
  under the pinned compiler without behavior change.

### Why an extension could not handle it

- Both are shared utilities consumed inside `packages/ai` before extension code runs.

### Expected merge conflict zones

- LOW: both files are small leaf utilities.

## Builtin provider set and model capability runtime (2026-06-23)

### What changed

- `packages/ai/src/providers/all.ts`: `normalizeBuiltinModel()` projects builtin catalog entries (applied
  to the Xiaomi MiMo provider set among others) and the builtin list exports `ollamaProvider` (Ollama
  Cloud, added 2026-07-30).
- `packages/ai/src/providers/anthropic.ts`, `packages/ai/src/providers/google.ts`, and
  `packages/ai/src/providers/google-vertex.ts`: re-export `stream`/`streamSimple` functions from the lazy
  API instances for direct consumers.
- `packages/ai/src/env-api-keys.ts`: the browser-safe env map detects `ALIBABA_TOKEN_PLAN_API_KEY`,
  `OLLAMA_API_KEY`, and `OPENGATEWAY_API_KEY`.
- `packages/ai/src/models.ts`: shared `supportsXhigh`/`supportsMax` capability detection (boundary-aware
  family matcher, explicit-map precedence, `null` veto) with `getSupportedThinkingLevels` delegating to
  it, and `checkProviderAuth` consulting the optional `OAuthAuth.check` hook for stored and ambient
  credentials.

### Why

- Provider availability, env detection, and capability inference run before the extension runtime loads
  and must be one implementation; per-adapter copies of the xhigh/max rules had already drifted once.

### Why an extension could not handle it

- `KnownProvider` typing, the builtin registration list, and the `Models` capability APIs are compile-time
  and package-internal surfaces.

### Expected merge conflict zones

- MEDIUM: `packages/ai/src/models.ts` capability predicates and auth precedence branches.
- LOW: additive provider/env entries in `packages/ai/src/providers/all.ts` and
  `packages/ai/src/env-api-keys.ts`; stream re-exports in the three provider modules.

## Registry seams: compat dispatch and scoped images registry (2026-06-23)

### What changed

- `packages/ai/src/compat.ts`: the mutable API-provider registry moved to the fork-owned
  `api-registry.ts` (compat re-exports registration and lookup), `stream`/`streamSimple` wrap calls in
  the text tool-call middleware when the model declares a `ToolCallFormat`, and the `cursor-agent` lazy
  API registers through `BUILTIN_APIS`.
- `packages/ai/src/images-api-registry.ts`: the images registry became scope-aware — an immutable
  builtin registry plus per-scope overlays, `installImagesProviderScopeAccessor` for the node-only
  subpath, strict-mode errors when multi-session lookup happens with no active scope, and closed-scope
  throws on lookup or mutation.

### Why

- Multi-session RPC hosts need session-scoped provider resolution that never falls back to a mutable
  process-global, while the root stays browser-safe (no `node:async_hooks` reachable from root).

### Why an extension could not handle it

- Registry dispatch and scope installation are package-internal seams; extensions register through the
  public surface but cannot re-home the registry or install the scope accessor.

### Expected merge conflict zones

- MEDIUM: `packages/ai/src/compat.ts` dispatch and re-export block (upstream owns the legacy registry
  inline).
- LOW: additive scope functions in `packages/ai/src/images-api-registry.ts`.

## Faux provider test surface (2026-06-23)

### What changed

- `packages/ai/src/providers/faux.ts`: `FauxContentBlock` includes `ProviderNativeContent` so faux turns
  exercise native blocks; `FauxCallLogEntry` records cloned contexts and stream options per call;
  `schedulerHook` paces chunk emission deterministically; and
  `registerFauxProvider`/`getRegisteredFauxProvider` (plus `fauxOverflowError`) expose registration and
  overflow fixtures for the test harness.

### Why

- Faux is the default token-free test provider: suites must capture what was sent, drive pacing
  deterministically, and cover native-block handling without live credentials.

### Why an extension could not handle it

- Faux is the in-package test double reached through the registry's fast path, below the extension
  runtime.

### Expected merge conflict zones

- MEDIUM: upstream also evolves faux; the registration and logging additions sit beside upstream's core.

## Cloudflare base-URL routing (2026-06-23)

### What changed

- `packages/ai/src/api/cloudflare.ts`: `isCloudflareProvider()` and `resolveCloudflareBaseUrl()`
  substitute provider-scoped `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_GATEWAY_ID` values into the
  brace-placeholder gateway base URLs at request time.
- `packages/ai/src/api/anthropic-messages.ts` and `packages/ai/src/api/openai-responses.ts` resolve their
  base URL through that helper. `packages/ai/src/api/anthropic-messages.ts` is also this tracker's
  canonical cover for its accumulated adapter divergences (final tool-pair sanitization,
  unavailable-tool demotion, adaptive-thinking effort ladders, the warm-cache request builder, and the
  unsigned-thinking replay retry) recorded in the dated entries below.

### Why

- The committed catalog stores placeholder URLs; without request-time substitution the literal braces go
  to the wire and every Cloudflare route fails.

### Why an extension could not handle it

- Base-URL resolution happens inside adapter client construction before any extension hook or payload
  transform runs.

### Expected merge conflict zones

- LOW: `packages/ai/src/api/cloudflare.ts` helpers.
- MEDIUM: client construction sites in `packages/ai/src/api/anthropic-messages.ts` and
  `packages/ai/src/api/openai-responses.ts`.

## 2026-08-16 - Cursor agent protocol: full chat + tool calling (`cursor-agent` API)

### What changed and why

- `api/cursor-agent.ts` (new) + `api/cursor-agent.lazy.ts` (new): full port of the Cursor agent protocol from
  upstream oh-my-pi, adapted to this fork's API architecture. One HTTP/2 Connect stream per assistant turn
  (`POST /agent.v1.AgentService/Run`, `application/connect+proto`, 5-byte envelope framing, 5s client
  heartbeats, gRPC-trailer + Connect end-stream error decoding, abort via stream close). Interaction updates
  map onto assistant events (text/thinking deltas, streamed MCP tool calls with cumulative `args_text_delta`
  buffering + throttled partial-JSON parsing, `turnEnded`, `tokenDelta` usage). The exec channel is answered
  in band: the server blocks mid-turn on tool results, so exec frames dispatch onto injected
  `CursorExecHandlers` (legacy read/ls/grep/write/shell(+stream)/delete frames, modern `pi_*` frames, MCP
  calls incl. approval-only probes, kv blob get/set, `requestContext` tool advertising, `mcpState` regrouping,
  neutral hook replies) and every remaining frame gets a typed refusal or `ExecClientThrow` — an unanswered
  frame strands the turn. Each bridged call is synthesized into the assistant message as an already-resolved
  `toolCall` block (`kCursorExecResolved`) and paired with a `ToolResultMessage` via `onToolResult`.
- `api/cursor-agent/gen/agent_pb.ts` (new, vendored): protobuf-es v2.13 codegen of
  `packages/ai/proto/cursor/agent.proto`, with TS enums rewritten to erasable const objects by
  `scripts/transform-cursor-agent-proto.mjs` (repo compiles with `erasableSyntaxOnly`; runtime decode uses the
  embedded descriptor, not the TS enums). Excluded from Biome via `biome.json`.
- `api/cursor-agent/{types,exec-modern,pi-args,deterministic-id}.ts` (new): browser-safe handler contracts,
  wire result builders for the Pi frames, and arg translations shared by the API's synthesized display blocks
  and the coding-agent bridge (senpi's tools take plain kwargs, so `pi_read` maps to `offset`/`limit` instead
  of upstream's path selectors; `pi_edit` maps 1:1 onto `edits[{oldText,newText}]`; `workingDirectory`
  composes onto `bash` commands as a quoted `cd` prefix because senpi's bash has no cwd kwarg).
- Conversation continuity: history is rebuilt per request from `context.messages` into
  `rootPromptMessagesJson` blobs (system prompt + Vercel-AI-SDK-shaped user/assistant/tool JSON) and
  `turns[]` display structures over a per-conversation SHA-256 blob store; checkpoints are cached per
  conversation id; a bare `resource_exhausted` with zero tokens rotates the wire conversation id once.
- Model discovery: `fetchCursorUsableModels` (unary `GetUsableModels` over HTTP/2) normalizes usable models
  (1M-context signals, max-mode flag → `Model.compat.cursorMaxMode`); `providers/cursor.ts` now wires
  `api: cursorAgentApi()` + `fetchModels`, so the catalog appears after `/login cursor` (refresh runs
  automatically after login).
- Registration: `KnownApi`/`ApiOptionsMap` gain `"cursor-agent"`; `compat.ts` `BUILTIN_APIS` registers the
  lazy API; `model.ts` gains `CursorAgentCompat`; `utils/block-symbols.ts` (new) carries the streaming and
  `kCursorExecResolved` markers; `utils/event-stream.ts` gains `trackLocalWork`/`hasPendingLocalWork` so idle
  watchdogs can attribute mid-stream tool-run silence to local work.
- Deliberately not ported from upstream: computer use, subagents, background shells, canvas, smart-mode
  classifier, conversation search, native todo mirroring (summary-only pairing is kept), Kimi-K3 thinking
  replay, request-debug capture, and proxy tunneling — each answered with the protocol's typed refusal.

### Why this cannot be expressed as an extension

- The exec channel must be answered on the SAME HTTP/2 stream mid-turn, which requires provider-internal
  transport access; `KnownApi` registration, `Model.compat` typing, and the event-stream local-work contract
  are all package-internal seams.

### Expected merge conflict zones

- LOW: `types.ts` (`KnownApi`, `ApiOptionsMap`), `compat.ts` lists, `model.ts` compat conditional,
  `index.ts` export blocks — additive lines.
- NONE expected under `api/cursor-agent/`: fork-only files; upstream's implementation lives in a different
  architecture (`src/providers/cursor.ts`).

## 2026-08-16 - Cursor OAuth authentication and builtin provider

### What changed and why

- `auth/oauth/cursor.ts` (new): Cursor's browser deep-link + poll OAuth flow. `login` generates a PKCE S256
  pair, notifies `auth_url` for `https://cursor.com/loginDeepControl?challenge&uuid&mode=login&redirectTarget=cli`,
  and polls `https://api2.cursor.sh/auth/poll?uuid&verifier` with capped geometric backoff (1s ×1.2 up to 10s,
  150 attempts). 404 means "not approved yet"; 400/401/403/410 fail fast as definitive rejections; 429 keeps
  polling without burning the transient budget; network errors and 5xx tolerate 3 consecutive failures. The
  poll sleep is abort-aware, so cancelling the login interaction aborts immediately. `refresh` POSTs the stored
  refresh token as a bearer to `auth/exchange_user_api_key` and keeps the previous refresh token when the
  server does not rotate it. Expiry comes from the access-token JWT `exp` claim minus a 5-minute skew, with a
  1-hour fallback for unreadable tokens. Error messages carry HTTP status plus short server `error` strings,
  never raw bodies or token material.
- Compared to the upstream oh-my-pi flow this fixes a self-swallowed error bug (upstream throws its polling
  `OAuthError` inside its own `try`, so a definitive 401 was retried as if it were a network hiccup), adds
  abort-signal support, and validates response shapes strictly.
- `auth/oauth/load.ts` + `bun-oauth.ts`: `cursor` loader added to the lazy registry and the Bun static bundle.
- `providers/cursor.ts` (new) + `providers/all.ts` + `types.ts`: builtin `cursor` provider (OAuth-only,
  `isSubscription`), registered with an empty model catalog and an empty API map because Cursor chat runs on a
  protobuf Connect-RPC agent protocol (`agent.v1.AgentService`) that is not ported. Nothing becomes selectable
  in model pickers, and `Models.getAuth("cursor")` resolves the stored access token for integrations that speak
  the Cursor protocol.

### Why this cannot be expressed as an extension

- Builtin OAuth flows are lazy-loaded through the bundler-opaque loader registry in `auth/oauth/load.ts` and
  statically registered for standalone Bun binaries in `bun-oauth.ts`; both are package-internal seams an
  extension cannot reach, and `KnownProvider` typing is compile-time.

### Expected merge conflict zones

- LOW: `auth/oauth/load.ts` and `bun-oauth.ts` loader lists when upstream adds flows.
- LOW: `providers/all.ts` builtin list and `types.ts` `KnownProvider` union (additive lines).
- NONE expected in `auth/oauth/cursor.ts` / `providers/cursor.ts`: fork-only files; upstream's Cursor
  implementation lives in a different architecture (`src/registry/oauth/`).

## 2026-08-16 - GLM 5.3 reasoning effort + zai always-enabled thinking + catalog entries

### What changed and why

- `openai-completions.ts`: generalized the `isGlm52` thinking-level-map matcher to `isGlm5x` (regex `glm-5\.[23]`), so GLM 5.3 inherits the same host-specific thinkingLevelMap branches 5.2 uses (zai → DEEPSEEK map, openrouter → `{xhigh}`, default → `{max}`). Without this, 5.3 returned `undefined` from `getThinkingLevelMap` and reasoning effort was sent raw instead of mapped.
- `openai-completions.ts`: the zai `thinkingFormat` handler now forces `{type: "enabled"}` for GLM 5.3 ids even when no `reasoningEffort` is set. GLM 5.3 cannot disable thinking (Z.AI wire contract: `thinking.type` must always be `"enabled"`). GLM 5.2 keeps the existing `{type: "disabled"}` behavior when no effort is set.
- Provider data files (`packages/ai/src/providers/data/`): cloned glm-5.2 model entries to glm-5.3 across
  17 provider files (alibaba-token-plan, baseten, cloudflare-ai-gateway, cloudflare-workers-ai, fireworks,
  huggingface, nvidia, opencode-go, opencode, opengateway, openrouter, qwen-token-plan-cn, qwen-token-plan,
  together, vercel-ai-gateway, zai-coding-cn, zai). Each 5.3 entry inherits the 5.2 entry's baseUrl,
  compat, cost, contextWindow, maxTokens, and thinkingLevelMap with only the id/name version bumped. A
  qwen-token-plan-individual entry shipped initially and was reverted the same day (see the generator
  bullet).
- `scripts/generate-models.ts`: generalized the four 5.2-specific generator sites to also cover 5.3 (zai
  `isGlm52`→`isGlm5x`, openrouter, fireworks `glm-5p2`→`glm-5p3`, opencode-go). `glm-5.3` was also added
  to the qwen-token-plan-individual allowlist and then removed again on 2026-08-16: models.dev does not
  yet publish GLM 5.3 for that provider, so the strict allowlist validation (exact model-ID match plus the
  strict-generation error assertion) failed. Regeneration preserves the 5.3 entries and their
  thinkingLevelMaps everywhere else.
- `.manifest.json`: regenerated (structureHash + per-file sha256) to match the changed data files.
- `test/glm-5.3-thinking.test.ts`: pins both wire contracts through the stream (vi.mock openai + onPayload capture): low/medium effort maps through the zai thinking-level map (not raw), and no-reasoning still enables thinking.

### Expected merge conflict zones

- `openai-completions.ts`: the `isGlm52`→`isGlm5x` rename and the zai handler `isGlm53` guard sit in fork-modified sections; re-apply if upstream touches the same lines.
- Provider data files: fork-only; upstream has no counterpart.

## 2026-08-16 - Classify gateway 413 body-size rejections as overflow

### What changed and why

- `isContextOverflow` now recognizes gateway HTTP 413 byte-size rejections — "Request body too
  large", "Request Entity Too Large", `body_too_large`, and "Payload Too Large" — as the same
  recovery class as Anthropic's native `request_too_large`. Both wordings were captured from a
  live session whose compaction summarization request exceeded a gateway body limit on every
  fallback model ([#884](https://github.com/code-yeongyu/senpi/issues/884)).
- Without the classification, a byte-size rejection never reached input-shrinking recovery: it
  surfaced as a terminal error and wedged sessions above the compaction threshold.

### Why this cannot be expressed externally

- Overflow classification is the provider-neutral boundary every caller (compaction shrink-retry,
  agent-session overflow admission) keys off; an extension can only observe the final error.

### Expected merge conflict zones

- LOW: `utils/overflow.ts` pattern list and its header documentation; LOW in
  `test/overflow.test.ts` where the new cases sit beside existing provider patterns.

## 2026-08-14 - Harden stored OAuth request derivation

### What changed and why

- `resolveProviderAuth()` refreshes expired OAuth credentials before invoking the provider's optional side-effect-free `check`.
- Sentinel envelopes that represent zero usable accounts can no longer bypass the same availability predicate used by provider catalog checks.
- Stored OAuth derivation transiently merges request environment before both `check()` and `toAuth()`, then returns it for auxiliary replay without persisting request secrets.
- Explicit empty request environment values mask host values instead of falling back through truthiness.
- `ApiKeyAuth.ambientOnly` lets compatibility adapters remain fallback-only without changing explicit-key precedence for real dual-auth providers.
- Ambient-only adapters receive the raw request environment alongside their overlaid context, allowing provider-owned token namespaces to replace sibling host slots instead of importing them during replay.

### Why this cannot be expressed externally

- Stored OAuth credentials short-circuit inside the provider-neutral resolver before coding-agent provider composition or extension request hooks can intervene.

### Expected merge conflict zones

- MEDIUM: `auth/resolve.ts` at explicit-key precedence, environment overlay, and stored-OAuth refresh/check/derivation.
- LOW: `auth/types.ts` at the additive `ApiKeyAuth.ambientOnly` metadata.

## 2026-08-13 - Preserve explicit request compatibility fields

### What changed and why

- OpenAI-completions compatibility resolution now preserves explicit Baseten `chatTemplateArgs` and vLLM
  `supportsThinkingTokenBudget` settings when it combines detected defaults with model overrides.
- Focused Baseten and thinking-budget tests prove those fields reach the final request payload.

### Why this cannot be expressed externally

- The compatibility resolver is the provider-neutral normalization boundary used before any request transform or
  coding-agent extension can observe the payload.

### Expected merge conflict zones

- MEDIUM: `utils/prompt-cache-ttl.ts` at the explicit compatibility override return object.

## 2026-08-13 - Upstream option and live-test cleanup

### What changed and why

- Removed an obsolete reasoning-budget local and a Baseten live-test key lookup no test consumes after the
  upstream option/catalog merge.
- Runtime behavior and live-test gating are unchanged; this keeps warnings fatal without weakening the checks.

### Why this cannot be expressed externally

- Both warnings arise in the provider-neutral option compiler and AI test module before coding-agent extensions
  exist.

### Expected merge conflict zones

- LOW: `api/simple-options.ts` reasoning-budget setup and `test/context-overflow.test.ts` live-key declarations.

## 2026-08-12 - Throw-based sibling for the bounded assistant retry loop

### What changed and why

- `utils/retry.ts` adds `retryTransientCall(produce, isRetryable, policy, signal, callbacks)`. It reuses the exact
  sleep, exponential backoff (`baseDelayMs * 2^(attempt-1)`), abort, and `RetryCallbacks` contract that
  `retryAssistantCall` already implements, for producers that report failure by THROWING rather than by resolving an
  `AssistantMessage` with `stopReason: "error"`.
- The classifier is an explicit `isRetryable(error)` parameter, so each caller keeps ownership of what counts as
  transient instead of inheriting assistant-message semantics that do not apply to it.
- `retryAssistantCall` is untouched and stays value-based; its full existing suite passes unchanged. The two loops
  share the private `sleep`/`RetrySleepAbortError` primitives so backoff and cancellation have one implementation.
- First consumer is senpi's builtin compaction extension, whose summarization request throws and therefore could not
  reuse the bounded retry without first reshaping failures into assistant messages.

### Why this cannot be expressed externally

- The delay, abort-during-backoff normalization, and retry callback ordering are private to this module. A caller
  reimplementing them outside `utils/retry.ts` is exactly the duplicated policy this addition removes.

### Expected merge conflict zones

- MEDIUM: `utils/retry.ts` between `RetryCallbacks`/`sleep` and `retryAssistantCall`, where the new function is
  inserted.
- LOW: `test/retry-transient-call.test.ts` is a new focused file for the added surface.

## 2026-08-12 - OpenGateway built-in provider

### What changed and why

- Added `opengateway` as a built-in provider for the OpenGateway data plane (`https://apis.opengateway.ai`),
  an OpenAI-compatible multi-provider gateway serving `owner/model` ids (OpenAI, Anthropic, Google, xAI,
  Moonshot, DeepSeek, ZAI, MiniMax, Qwen) through a single `OPENGATEWAY_API_KEY` Bearer credential.
- The generated catalog is hydrated from the gateway's live `/v1/models` at generation time by
  `scripts/generate-models-opengateway.ts`: chat-completions-capable, non-retired models are kept and
  enriched with pricing/context/reasoning metadata from models.dev, preferring the owning provider's
  catalog over the OpenRouter id space. Six models models.dev cannot enrich carry explicit overrides.
- Env detection maps `OPENGATEWAY_API_KEY`; the provider factory uses the shared `openai-completions`
  API with standard OpenAI compat auto-detection.

### Why this cannot be expressed externally

- A user-level `models.json` custom provider can point at the gateway, but it cannot ship a generated,
  validated catalog in `src/providers/data/`, participate in `KnownProvider` typing, or register the
  built-in display name that makes the provider a first-class `/login` target.

### Expected merge conflict zones

- MEDIUM: `scripts/generate-models.ts` main fetch/assembly flow (new source call + spread).
- LOW: `src/types.ts` `KnownProvider` union, `src/env-api-keys.ts` env map, `src/providers/all.ts`
  registration list.
- LOW: generated artifacts (`models.generated.ts`, `providers/data/`) — resolve by regenerating.
## 2026-08-12 - Default direct Anthropic prompt caching to five minutes

### What changed and why

- Native `anthropic-messages` requests now use Anthropic's default five-minute prompt-cache retention when neither
  `cacheRetention` nor `PI_CACHE_RETENTION=long` explicitly selects long retention. The adapter emits bare
  `{ type: "ephemeral" }` cache-control markers instead of adding `ttl: "1h"`.
- The browser-safe `resolvePromptCacheTtlSeconds()` mirror now reports 300 seconds for the same omitted-retention
  path, keeping cache-aware tool waits and goal-monitor timing aligned with the wire request.
- Explicit `cacheRetention: "long"`, model-level long retention, and `PI_CACHE_RETENTION=long` still request and
  report one hour on supported canonical Anthropic endpoints. Anthropic-compatible proxies remain five minutes.

### Why this cannot be expressed externally

- Prompt-cache retention is selected while the Anthropic provider serializes system, tool, and conversation cache
  breakpoints. Extensions only observe higher-level requests and cannot safely rewrite every provider-owned
  `cache_control` block or the browser-safe TTL estimate consumed by cache-aware runtime scheduling.

### Expected merge conflict zones

- MEDIUM: `api/anthropic-messages.ts` around `resolveCacheRetention()` and the cache-session-id setup.
- MEDIUM: `utils/prompt-cache-ttl.ts` in the native Anthropic branch of `resolvePromptCacheTtlSeconds()`.
- LOW: focused cache-retention and TTL tests that pin provider-default precedence.

## 2026-08-11 - Native Responses image-generation item reconciliation

### What changed and why

- The shared OpenAI Responses stream loop now structurally recognizes `image_generation_call` output items across
  SSE, WebSocket, Azure, and Codex adapters. Added and done frames reconcile into one provider-native slot, while a
  terminal response backfills the final item when providers omit `response.output_item.done`.
- Completed items retain only validated base64 plus an optional nonempty `revised_prompt`. Missing, empty, or invalid
  results become short malformed status blocks; failed and provider-specific statuses remain message-local metadata
  instead of escalating into transport errors. Partial-image events remain intentionally ignored.
- Native image results have a 24 MiB aggregate base64-character cap. Exceeding it scrubs already collected image bytes
  before the adapter returns a normalized provider error, so oversized data cannot enter the final assistant content.
- `OpenAIResponsesCompat.supportsImageGeneration` exposes an explicit native-tool compatibility override, with direct
  OpenAI Responses endpoints as the default-compatible route.

### Why this cannot be expressed externally

- Output-item slot reconciliation and terminal-response backfill happen inside the shared provider event loop before
  extensions receive a completed assistant message. External hooks cannot reliably deduplicate frames or prevent
  oversized native payloads from entering normalized content across all three adapters.

### Expected merge conflict zones

- MEDIUM: `api/openai-responses-shared.ts` output-slot lifecycle and terminal response finalization.
- LOW: `openai-responses-compat.ts` additive compatibility flag.
- LOW: `api/openai-responses.ts` resolved compatibility defaults.

## 2026-08-11 - OpenAI images provider with generated gpt-image models

### What changed and why

- `scripts/generate-image-models.ts` now also emits `IMAGE_MODELS.openai` with static, hand-authored entries for
  `gpt-image-2` and `gpt-image-1.5` (api `openai-images`, provider `openai`, baseUrl `https://api.openai.com/v1`,
  input `["text"]` only - the v1 generations endpoint is text-only). Costs quote models.dev as of 2026-08-11
  (gpt-image-2: $5 input / $30 output / $1.25 cache-read per 1M tokens; gpt-image-1.5 has no models.dev cost entry
  as of that date and is zero-filled until pricing is published). The OpenRouter live fetch is unchanged.
- `providers/openai-images.ts` adds `openaiImagesProvider()` mirroring the OpenRouter images provider, authing via
  `OPENAI_API_KEY` and serving `Object.values(IMAGE_MODELS.openai)` through the lazy `openaiImagesApi()` accessor.
- `providers/all.ts` appends the provider to `builtinImagesProviders()`, so `builtinImagesModels()` exposes the
  `openai` provider and its catalog.

### Why this cannot be expressed externally

- The built-in image model catalog is generated inside `packages/ai`; external providers can register through the
  images registry but cannot extend the generated `IMAGE_MODELS` catalog or the builtin provider list.

### Expected merge conflict zones

- LOW: additive static model table and provider grouping in `scripts/generate-image-models.ts`.
- LOW: one-line append in `builtinImagesProviders()` and the import block in `providers/all.ts`.

## 2026-08-11 - Lazy builtin registration for openai-images provider

### What changed and why

- `providers/images/register-builtins.ts` registers the `openai-images` ImagesApi as a lazy builtin alongside the
  existing `openrouter-images` registration. The lazy wrapper defers the dynamic import of `api/openai-images.ts`
  until first invocation, and catches any module-load failure into a normalized `AssistantImages` error envelope
  (stopReason "error", never a thrown rejection).
- The shared `createLazyLoadErrorImages` helper is generalized over `ImagesApi` so both providers reuse the same
  error-envelope construction.

### Why this cannot be expressed externally

- Builtin provider registration runs at module load time inside `packages/ai`; external extensions register through
  the public registry surface but cannot supply the lazy module-promise boundary that keeps the openai-images SDK
  out of the initial bundle.

### Expected merge conflict zones

- LOW: additive registration entry inside `registerBuiltInImagesApiProviders()` and the new lazy wrapper export in
  `providers/images/register-builtins.ts`.
- LOW: additive test file `test/images-registry-builtins.test.ts`.

## 2026-08-11 - OpenAI Images API adapter

### What changed and why

- `api/openai-images.ts` adds the text-only OpenAI Images generations adapter with canonical `/v1` endpoint
  normalization, shared credential-header auth, provider-owned retries, usage/cost mapping, and normalized error envelopes.
- Image results accept provider base64, data URLs, or unauthenticated signed HTTP URLs. Hydration validates image MIME or
  magic bytes, enforces a 24 MiB cap, and keeps generated bytes in memory so packages/ai remains browser-safe.
- `api/openai-images.lazy.ts` adds the sanctioned dynamic-import boundary, and `types.ts` recognizes `openai-images` as
  a known images API.

### Why this cannot be expressed externally

- Correct request fields, SDK retry ownership, credential-header suppression, and response hydration are provider wire
  concerns that must run before the normalized `AssistantImages` result reaches callers.

### Expected merge conflict zones

- LOW: additive API and test modules plus the `KnownImagesApi` union line.
- LOW: additive entry at the top of `src/changes.md`.
## 2026-08-11 - Normalize replayed tool IDs for strict OpenAI-compatible gateways

### What changed and why

- `api/openai-completions.ts` now sanitizes every replayed non-Responses tool-call ID to the OpenAI-compatible
  alphanumeric/underscore/dash shape, preserves already-valid bounded IDs, and uses a deterministic hash suffix when
  sanitization or the 40-character bound changes the ID.
- `api/transform-messages.ts` lets strict target adapters opt into applying their supplied tool-call ID normalizer to
  same-model history as well as cross-model history. OpenAI completions enables that opt-in and remaps the paired
  tool result through the existing ID map; Responses retains its provider-native IDs.
- A persisted `apitopia/kimi-k3-unlocked` session stored tool-call IDs such as `eval:18`. After switching to
  `opengateway/anthropic/claude-fable-5`, the gateway rejected the request before generation with
  `messages.36.content.1.tool_use.id: String should match pattern '^[a-zA-Z0-9_-]+$'`.
- This cannot be extension-local: tool-call IDs and their paired results are transformed inside provider request
  serialization before an extension can safely rewrite the complete outbound history. Rewriting persisted session
  files would also leave other histories and future provider handoffs exposed.

### Expected merge conflict zones

- MEDIUM: `api/openai-completions.ts` near the local `normalizeToolCallId` function in `convertMessages`.
- LOW: `api/transform-messages.ts` in the assistant `toolCall` transformation branch.
- LOW: `../test/model-switch-replay-characterization.test.ts` near the non-Responses replay cases.

## 2026-08-11 - Retry gateway model-request rejections

### What changed and why

- `utils/retry.ts` classifies `"model request was rejected"` as retryable so a gateway/proxy-side "The model
  request was rejected. Check the request and try again." response is absorbed by the bounded same-model retry
  policy (`settings.retry`) instead of failing the turn or immediately burning the fallback chain. Observed in a
  live session on 2026-08-11. The classifier couples the rejection sentence to its explicit "Check the request and
  try again." instruction so permission denials, content refusals, and request-shape errors remain terminal, and
  the non-retryable list still wins on overlap.

### Why this cannot be expressed externally

- The transient-vs-terminal message classifier is package-internal; callers and extensions consume its verdict
  through `retryAssistantCall`/`isRetryableAssistantError` and cannot add a message class without forking the
  retry loop.

### Expected merge conflict zones

- LOW: additive pattern in `utils/retry.ts`, additive cases in `test/retry.test.ts`, additive mock-loop scenario
  and optional scripted-error `type` under `.agents/skills/senpi-qa/scripts/`.

## 2026-08-11 - Optional availability `check` on `OAuthAuth`

### What changed and why

Added an optional `check?(input)` to `OAuthAuth` (`auth/types.ts`) and taught `checkProviderAuth` (`models.ts`) to consult it in the stored-OAuth-credential branch. Previously that branch was a pure structural short-circuit — `provider.auth.oauth ? {configured} : undefined` — so any stored OAuth credential, including an empty sentinel envelope with zero accounts, reported the provider as configured. The fallback engine reads configured-ness through `hasConfiguredAuth`, so such a provider was never skipped as `unauthenticated`. `ApiKeyAuth` already exposes an equivalent `check`; this makes the OAuth path symmetric. When `check` is absent, behavior is byte-identical to before, so every existing OAuth provider is unaffected. This cannot be extension-local: the short-circuit lives in `ModelsImpl.checkProviderAuth`, which no extension hook reaches, and `OAuthAuth` had no `check` to supply.

### Expected merge-conflict zones

LOW in `auth/types.ts` (additive optional field on `OAuthAuth`); LOW in `models.ts` `checkProviderAuth` (one stored-OAuth branch expanded, existing behavior preserved when `check` is undefined).

## 2026-08-11 - OAuth availability `check` for ambient and no-credential providers

### What changed and why

- Follow-up to the optional `OAuthAuth.check` hook: `Models.checkAuth()` now also invokes the hook for ambient
  no-credential providers, not only for stored OAuth credentials. Providers without a hook retain the previous
  behavior where any matching stored OAuth credential is configured.
- This lets providers confirm usable ambient OAuth without refreshing, resolving, or exposing token material. Hook
  failures are wrapped in `ModelsError` on both the stored-credential and ambient paths.

### Why this cannot be expressed externally

- Provider availability and model filtering happen inside `Models` before host registries and fallback controllers see
  the provider, so an extension-only post-filter would leave `checkAuth()` and `getAvailable()` inconsistent.

### Expected merge conflict zones

- MEDIUM: the auth precedence branches in `models.ts`.

## 2026-08-09 - Native Anthropic prompt-cache warming primitive

### What changed and why

- `api/warm-prompt-cache.ts` adds the non-streaming `warmPromptCache()` request primitive for direct Anthropic
  Messages models. It sends the normal converted system, tools, and conversation cache breakpoints with
  `max_tokens: 0`, strips streaming, thinking, and forced tool choice, disables SDK retries, and returns normalized
  input/output/cache-read/cache-write usage alongside the raw provider usage.
- `api/anthropic-messages.ts` exposes a focused warm-request builder so pre-warming and the normal stream share the
  same message, tool, cache-control, and tool-pair conversion instead of maintaining a second wire transform.
- The root package exports the primitive and its exact supported/unsupported result contract. Non-Anthropic APIs and
  Anthropic-compatible gateways return unsupported before authentication or network work begins.

### Why this cannot be expressed externally

- Correct cache breakpoints depend on adapter-internal Anthropic message and tool conversion. Reconstructing the
  request outside the package would drift from the normal provider path and could mutate history or send incompatible
  streaming/thinking options.

### Expected merge conflict zones

- MEDIUM: `api/anthropic-messages.ts` near request construction and cache-control conversion.
- LOW: additive `api/warm-prompt-cache.ts` and root `index.ts` export.

## 2026-08-09 - Prompt-cache correctness across OpenAI-compatible and Bedrock lanes

### What changed and why

- `api/openai-completions.ts` `parseChunkUsage()` now reads Kimi's flat `usage.cached_tokens` only after the
  existing nested OpenAI and `prompt_cache_hit_tokens` forms, preserving precedence while reporting cache reads and
  uncached input correctly.
- `types.ts` adds `OpenAICompletionsCompat.supportsPromptCacheKey`; `utils/prompt-cache-ttl.ts`
  `detectOpenAICompletionsCompat()` enables it for Moonshot and direct OpenAI endpoints, and
  `getOpenAICompletionsCompat()` preserves explicit overrides. `buildParams()` uses the resolved flag to emit a
  clamped stable key without adding provider URL checks at the request boundary.
- OpenRouter compatibility detection now defaults session affinity on, and `buildParams()` sends the same session ID
  in both `x-session-id` and the body `session_id` from the first cache-enabled request.
- Runtime and `scripts/generate-models.ts` detection share the literal `anthropic/`, `qwen/`, `google/` cache-control
  prefix allowlist and strip one optional leading `~`. Hydrated Moonshot and OpenRouter catalogs bake the resolved
  compatibility metadata.
- `utils/prompt-cache-ttl.ts` `supportsOneHourCacheTtl()` is the single Bedrock Claude 4.5 allowlist used by both
  `api/bedrock-converse-stream.ts` cache-point sites and `resolvePromptCacheTtlSeconds()`, preventing a one-hour
  resolver estimate when the wire request can only use five minutes.
- `resolvePromptCacheTtlSeconds()` reports 300 seconds for the actual `claude-sdk-oauth` model shape because the SDK
  owns that lane's default ephemeral prompt caching.

### Why this cannot be expressed externally

- Usage parsing, provider request fields, cache-point TTLs, and cache lifetime estimates are adapter-internal wire
  contracts resolved before an extension can observe a normalized assistant message or safely rewrite every request
  path. Generated compatibility metadata must also stay aligned with runtime detection.

### Expected merge conflict zones

- HIGH: `utils/prompt-cache-ttl.ts` OpenAI-compatible detection/merge and cache TTL resolver switches.
- HIGH: `api/openai-completions.ts` request construction and streamed usage parsing.
- MEDIUM: `api/bedrock-converse-stream.ts` system and conversation cache-point construction.
- MEDIUM: `scripts/generate-models.ts` compatibility detection and generated Moonshot/OpenRouter data.

## 2026-08-09 - Shared visible assistant-content classification

### What changed and why

- `utils/visible-text.ts` defines the shared visibility boundary for assistant text: Unicode format characters
  (`\p{Cf}`) are removed before whitespace trimming, so zero-width spaces, joiners, word joiners, byte-order marks,
  and directional formatting marks cannot make an otherwise empty response appear user-visible.
- `hasVisibleAssistantContent` treats a tool call or text containing a visible scalar as assistant output. Emoji ZWJ
  sequences remain visible because removing the joiner leaves visible emoji scalars.
- The browser-safe root exports both predicates so agent-core and other consumers use one classification instead of
  duplicating JavaScript `trim()` checks that miss U+200B.

### Why this cannot be expressed externally

- Assistant response visibility is a shared message-level contract consumed before coding-agent extensions receive a
  committed turn; external hooks cannot reliably repair divergent classifiers in each core consumer.

### Expected merge conflict zones

- LOW: additive `utils/visible-text.ts` module and root export in `index.ts`.

## 2026-08-05 - Root-object tool schemas and request-shape error classification

### What changed and why

- `utils/tool-schema-compat.ts` no longer hoists a ROOT schema's `type` into its combiner branches.
  OpenAI-compatible gateways reject a covered object-shaped root when normalization removes its required
  `type: "object"`, which is exactly how an Apitopia/Kimi turn died on 2026-08-04. `normalizeNode` now takes an
  `isRoot` flag so branch-level hoisting (still correct below the root) is unchanged. Plain and object-shaped roots
  receive or retain object typing, while scalar and mixed root unions remain unchanged instead of being mislabeled.
  Root `allOf` is protected from root type hoisting but is not flattened into a synthetic object.
- `mergeRootObjectUnion` merges object-shaped root `anyOf`/`oneOf` schemas without replacing the root's own
  `properties`/`required`. It previously returned `{"properties":{},"type":"object"}` for a root union that declared
  its properties at the root — silently sending a tool with zero parameters. Untyped constraint-only branches
  (`{ required: [...] }` over root properties) are accepted, and `required` keeps root entries plus only the names
  every branch shares.
- `normalizeToolParametersForMoonshot` now reuses the same object-root normalization before annotation stripping,
  rather than maintaining a second, divergent root-merge path.
- `api/anthropic-messages.ts` resolves object-shaped root `anyOf`/`oneOf` parameters through the shared
  `resolveRootObjectSchema` before building `input_schema`. `convertTools` reads top-level `properties`/`required`
  only, so covered root unions previously arrived as `{"properties":{},"required":[]}`. The conversion now merges
  their properties and required names while leaving ordinary object schemas unchanged; non-object unions and root
  `allOf` remain outside this resolver's flattening boundary.
- `utils/retry.ts` classifies five recognized malformed tool/function schema message forms as NON-retryable, and
  `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN` is renamed `NON_RETRYABLE_PROVIDER_ERROR_PATTERN` because it no
  longer covers only limits. Gateways can wrap these deterministic rejections in retryable-looking 5xx envelopes,
  so generic status matching replayed an equivalent invalid request on the same model. Four matchers target
  `tools.`/`functions.` request paths; `invalid tool schema` is intentionally broader. Eligible configured
  fallbacks rebuild their own provider-specific request rather than inheriting guaranteed identical bytes.

### Why this cannot be expressed externally

- Wire-payload schema normalization runs inside the provider adapter, after extension payload
  hooks, so no extension can repair the emitted tool schema. Retry classification is consumed by
  the agent session's hard-error routing, which lives below any extension seam.

### Expected merge conflict zones

- MEDIUM: `utils/tool-schema-compat.ts` around root handling and `mergeRootObjectUnion`.
- MEDIUM: `utils/retry.ts` in the non-retryable pattern list and its renamed constant.
- LOW: `test/openai-completions-tool-schema-compat.test.ts`, `test/retry.test.ts`.


## 2026-08-03 - Hint-aware 429 retry-after propagation

### What changed and why

- `utils/retry-hint.ts` (new) owns the strict 429 retry-hint extractor: `extract429RetryAfterMs` plus
  canonical marker helpers. It parses `retry-after` / `retry-after-ms` headers, `x-ratelimit-reset*` epoch
  headers, recursive JSON `retryDelay` fields (Google RPC style), body prose ("try again in N s", "resets at
  <ISO8601>"), and SSE `event: error` payloads, normalizing every shape to a millisecond delay or a sentinel for
  absent hint. Explicit-zero (retry immediately) is distinct from absent-hint (no guidance), so callers never
  conflate “server said now” with “server said nothing.”
- `utils/provider-retry.ts` propagates the extracted hint as a structured `ProviderRetryDelayError` carrying
  the canonical marker, instead of leaving the delay embedded in an opaque error string. Non-429 retry-loop
  behavior (forced-eligibility, backoff) is intentionally preserved — the hint path only augments 429-class
  errors.
- `api/anthropic-messages.ts` and `api/openai-codex-responses.ts` emit the canonical markers at both the
  HTTP-status boundary and the SSE in-stream `event: error` boundary, so hints survive regardless of whether
  the 429 arrives as a status response or a mid-stream error event.

### Expected merge conflict zones

- MEDIUM: `utils/provider-retry.ts` around the 429 hint propagation and `ProviderRetryDelayError`.
- MEDIUM: `api/anthropic-messages.ts` and `api/openai-codex-responses.ts` at the status/SSE error
  boundaries.
- LOW: `utils/retry-hint.ts` (new file) and `package.json` `./utils/*` export.

## 2026-08-01 - Final Anthropic tool-pair normalization

### What changed and why

- `api/anthropic-tool-pairs.ts` owns the browser-safe wire sanitizer for Anthropic client `tool_use` /
  `tool_result` adjacency, deduplication, orphan removal, and interrupted-result synthesis.
- `api/anthropic-messages.ts` applies that sanitizer after `onPayload` and every built-in Anthropic request
  rewrite, immediately before request metadata extraction and SDK submission.
- The final boundary no longer depends on extension-runner liveness or hook registration order. A reload,
  extension, or late payload transform can remove one result from a parallel tool-call turn without sending an
  invalid request to Anthropic.
- `test/anthropic-final-tool-pair-guard.test.ts` deterministically removes one result in the last payload hook
  and asserts that the SDK receives both immediate result blocks, including a synthetic error result.

### Expected merge conflict zones

- MEDIUM: `api/anthropic-messages.ts` around the final request-sanitization pipeline.
- LOW: `api/anthropic-tool-pairs.ts` if upstream adds equivalent Anthropic wire normalization.

## 2026-07-31 - Recover Codex WebSocket fallback sessions

### What changed and why

- A transient pre-start Codex WebSocket failure no longer pins the session to
  SSE for the rest of the process lifetime. The fallback circuit now keeps
  immediate requests on SSE for 60 seconds, then lets the next fresh request
  probe WebSocket again.
- Recovery changes only a future request. The existing guard still propagates
  transport failures after the response stream starts, so no already-started
  or potentially billed response is retried through SSE.
- Production session cleanup now removes both live WebSocket resources and
  the session's fallback/debug state. Long-lived app-server processes no
  longer retain degraded routing after a session is closed.
- Fallback and debug-state ownership moved into
  `api/openai-codex-responses/fallback-state.ts`, reducing the oversized
  adapter while keeping the public debug API stable.

### Coverage

- `../test/openai-codex-fallback-recovery.test.ts` proves the immediate SSE
  cooldown boundary, post-cooldown WebSocket recovery, and immediate recovery
  after production cleanup.
- Existing Codex stream tests retain the post-start no-fallback guard,
  continuation recovery, connection-limit handling, and one-shot
  `cacheRetention: "none"` behavior.

### Expected merge conflict zones

- MEDIUM: Codex WebSocket debug/fallback state and session cleanup.

## 2026-07-31 - Align Codex prompt-cache affinity headers

### What changed and why

- Issue #589's donated 25-hour session contained an 8.5-minute HTTP/SSE
  fallback burst where 18 requests reused only 22,016 cached tokens and resent
  roughly 175k-180k uncached tokens, interleaved with 10 normal roughly
  196k-199k cache hits. No model, thinking-level, compaction, or custom-message
  transition occurred inside the burst.
- The session had previously recorded Codex WebSocket transport failures and
  fallen back to SSE. Senpi's Codex adapter sent the stable session ID as
  `prompt_cache_key`, `session-id`, and `x-client-request-id`, but omitted the
  official Codex `thread-id` affinity header on both SSE and WebSocket.
- `api/openai-prompt-cache.ts` now applies the complete stable affinity tuple,
  and both transports use it. Senpi has one durable conversation identifier at
  this layer, so `session-id`, `thread-id`, and `x-client-request-id` all carry
  the clamped Senpi session ID while `prompt_cache_key` remains unchanged.
- `cacheRetention: "none"` keeps its existing no-affinity SSE behavior.
- This fixes the client-controlled protocol divergence. Open upstream Codex
  reports show that the provider cache can still miss intermittently with
  byte-identical bodies and stable keys, so the change does not claim that a
  best-effort upstream cache becomes deterministic.

### Coverage

- `../test/openai-codex-cache-affinity.test.ts` drives the real SSE and
  WebSocket request builders, pins the complete header/body mapping, and
  preserves the disabled-cache boundary.

### Expected merge conflict zones

- LOW: additive prompt-cache header helper and the two Codex header builders.

## 2026-07-31 - Reshape unavailable Anthropic tool transcript records

### What changed and why

- Unavailable Anthropic `tool_use` history is still demoted to satisfy Anthropic's same-request tool-reference validation, but the assistant-role text now uses explicit `<unavailable-tool-call>` transcript records instead of an imitable `[Called tool ... with input: ...]` pseudo-action.
- The first record for each missing tool name in a request explains that the call is historical and lists a capped, request-derived set of tools actually available now; later records for that name are terse self-closing elements. Tracking is request-local, so concurrent requests cannot interfere.
- Historical call inputs are omitted entirely, removing large replayed patch bodies. Tool-result text remains available in `<unavailable-tool-result>` records; only literal closing-tag openers are narrowly neutralized so attacker-influenced output cannot escape the envelope.
- XML attribute values are escaped for exotic tool names. The text builders live in the non-public `utils/` surface rather than growing the already-large Anthropic adapter.
- Coverage drives the real fake-client request path for first/later behavior, request-derived list capping, input omission, exotic-name escaping, result preservation, and closing-tag neutralization. The existing tool-reference integrity test remains unchanged.

### Expected merge conflict zones

- LOW: unavailable-tool rewriting inside `api/anthropic-messages.ts` and its internal text helper import.

## 2026-07-30 - Map-less GPT-5.6 Sol preserves max reasoning

### What changed and why

- OpenAI-compatible map-less `gpt-5.6-sol` models now expose `xhigh` and `max` without requiring a generated
  `thinkingLevelMap`.
- Explicit maps remain authoritative: a missing level on an existing map stays unavailable, and `null` vetoes the
  heuristic. `supportsXhigh` and `supportsMax` share that precedence.
- `supportsMax` is exported from `models.ts` so OpenAI Responses, Azure Responses, Codex Responses, and
  Completions send `max` on the wire instead of clamping a UI-selected map-less Sol level to `high`.
- Coverage pins capability, negative non-Sol boundaries, and captured request payloads without live tokens.

## 2026-07-30 - Recover Kimi XTML response channels from thinking

### What changed and why

- Kimi-family streams now sanitize structural `think` / `response` / `message` XTML markers from final thinking
  content and promote text only when an explicit response-open boundary makes the split unambiguous.
- Recovery uses the existing code mask, so XTML-looking examples inside inline or fenced code remain literal.
  Closing-marker-only payloads are sanitized but never exposed as visible chain-of-thought.
- Model recovery composition now applies Kimi response-channel recovery even when no tools are registered, while
  leaked text-tool-call reconstruction remains conditional on available tools.
- Coverage: coding-agent runtime-boundary tests pin no-tools recovery, split markers, conservative malformed
  handling, code literals, ordinary Kimi thinking, non-Kimi isolation, and existing tool-call recovery.

## 2026-07-30 - Add the official Ollama Cloud dynamic provider

### What changed and why

- New `providers/ollama.ts` registers `ollama` as an OpenAI-compatible builtin using `OLLAMA_API_KEY` and
  `https://ollama.com/v1`.
- The provider discovers the current Cloud catalog from `/api/tags`, enriches each entry through `/api/show`,
  exposes only tool-capable models, and derives thinking, vision, and architecture-specific context metadata.
- Per-model inspection uses bounded concurrency and retains a last-known tool model when that tag's inspection
  fails beside usable results; complete inspection failure and aborts fail the refresh without replacing the cache.
  A successful discovery with no usable tool models also preserves the last-known catalog instead of publishing or
  persisting an empty replacement.
- Catalog reads use the shared auth-aware `ModelsStore` refresh lifecycle, so only a non-empty successful result is
  persisted and failed or empty refreshes cannot replace the last-known list. Subscription usage has no stable
  per-token dollar rate, so discovered models report zero cost instead of fabricating prices.
- Ollama's OpenAI-compatible endpoint does not accept OpenAI-only storage/developer/strict-tool fields; the model
  compatibility projection uses `max_tokens`, and Senpi's `max` reasoning level clamps to Ollama's supported
  `high` wire value.

### Expected merge conflict zones

- LOW: additive provider factory, provider registration, `KnownProvider`, environment-key map entries, and the
  existing Ollama reasoning-level map in `api/openai-completions.ts`.
- LOW: additive provider documentation and deterministic catalog fixtures.

## 2026-07-29 - Preserve invoke-recovery protocol provenance

### What changed and why

- `wrapStreamWithInvokeRecovery()` accepts typed recovery options carrying both the parser factory and the protocol
  identity. The previous parser-only argument selected Kimi XTML correctly but lost that provenance in shared
  diagnostics and recovered tool-call IDs.
- Successful Kimi recovery now reports `protocol: "kimi-xtml"` and allocates `recovered-kimi-xtml-*` IDs. Invalid
  content/native event order and collision failures use the same protocol identity instead of always claiming
  `antml`.
- The default and legacy parser-function call forms remain ANTML-compatible, preserving existing Claude/default
  recovery diagnostics and IDs.
- Coverage: the shared wrapper pins Kimi failure diagnostics, and the coding-agent runtime boundary pins successful
  Kimi diagnostics plus recovered IDs.

### Expected merge conflict zones

- MEDIUM: invoke-recovery wrapper, diagnostic, failure, and native projection constructor signatures.

## 2026-07-29 - Serialize OpenAI completion content block events

### What changed and why

- `api/openai-completions.ts` now closes the active thinking, text, or native tool-call block before starting the
  next block. The adapter previously accumulated every block and emitted all `*_end` events only after the wire
  stream finished, producing overlapping canonical lifecycles such as `thinking_start -> text_start` and
  `text_start -> toolcall_start`.
- Providers that put text, reasoning, and parallel tool-call deltas in the same chunk keep their established
  single-block aggregation. The adapter defers that mixed chunk's content events and replays text, thinking, and
  each tool call as complete sequential lifecycles, avoiding duplicate text/thinking starts without restoring
  overlapping events.
- The invoke-recovery wrapper correctly rejects overlapping canonical content lifecycles. Kimi K3 exposed the
  adapter bug when a normal response streamed reasoning, visible text, and native tool calls in sequence, causing
  the user-facing terminal error `Invalid assistant content event order`.
- Coverage: `test/openai-completions-stream-lifecycle.test.ts` drives a real local SSE endpoint through reasoning,
  text, and a native tool call and pins the sequential start/delta/end event order.
  `test/openai-completions-tool-choice.test.ts` pins mixed text/reasoning/parallel-tool aggregation and sequential
  event replay.

### Expected merge conflict zones

- LOW: the block lifecycle helpers inside `api/openai-completions.ts`.

## 2026-07-29 - Support static credential headers without a synthetic API key

### What changed and why

- `auth/headers.ts` defines the narrow, case-insensitive credential-header contract shared by auth discovery and
  request adapters. Standard authorization, API-key, API-token, auth-token, access-token, and client-secret header
  names count only when their effective value contains credential material; metadata such as `User-Agent`,
  request ids, and trace tokens does not.
- `api/openai-client-auth.ts` lets OpenAI-compatible adapters initialize from credential-bearing headers when
  `ModelAuth.apiKey` is absent. Header-only clients suppress the SDK's default `Authorization: Bearer ...` header
  unless an explicit Authorization or the existing Cloudflare AI Gateway authorization path owns that behavior.
- `api/openai-completions.ts` and `api/openai-responses.ts` use the shared client-auth resolver for HTTP and
  Responses WebSocket requests, so `x-api-key` and equivalent static credentials work without an invented bearer
  token.

### Coverage

- `test/auth-headers.test.ts` covers recognized names, metadata rejection, case-insensitive overrides, and empty
  authorization schemes.
- `test/openai-header-auth.test.ts` exercises real OpenAI-compatible request construction for Completions and
  Responses and proves metadata-only headers fail before any request is issued.

### Expected merge conflict zones

- LOW: additive auth/header helpers and root export.
- MEDIUM: the duplicated OpenAI client-auth setup removed from `api/openai-completions.ts` and
  `api/openai-responses.ts`.

## 2026-07-29 - Classify Anthropic credits_required as non-retryable billing exhaustion

### What changed and why

- `utils/retry.ts`: `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN` gains `credits_required` and
  `credits are required`, the Anthropic Console credit-exhaustion wording (a 429 `rate_limit_error` whose
  details carry `error_code: credits_required`). The account stays dead until the user buys credits or raises
  the spend limit, so same-model retries can never recover it. Callers now route the shape through the
  hard-error fallback branch, where coding-agent pins the billing fallback, instead of burning the same-model
  retry budget (1 + maxRetries dead requests) on every turn.
- Coverage: `test/retry.test.ts` pins the verbatim incident message as non-retryable.

### Expected merge conflict zones

- LOW: two strings appended to the non-retryable pattern list in `utils/retry.ts`.

## 2026-07-29 - Classify zero-event provider stream stalls

### What changed and why

- `utils/retry.ts` exports `isProviderStreamStallError()`: matches the agent-loop stream-watchdog failures
  ("Idle timeout waiting for provider stream after <n>ms" and "Provider stream start timed out after <n>ms")
  on `stopReason: "error"` messages. The class stays
  retryable (unchanged), but callers can now distinguish "the provider accepted the request and sent zero events
  for the whole idle budget" from fast transient failures. agent-session uses it to escalate a second consecutive
  stall to the fallback chain instead of replaying the identical payload for the rest of the same-model budget
  (evidence: donated session 019fa8da-43ad-70b7-b01b-8f34f4d907f2, records 1906/1919, where a hung gateway made
  every replay burn the full 300s idle budget).
- Coverage: `test/retry.test.ts` pins the stall class against the idle-timeout message, `Request timed out.`,
  and aborted stop reasons.

## 2026-07-29 - Classify provider stream and transport timeouts precisely

### What changed and why

- `utils/retry.ts` exports `isProviderStreamStallError()` for the two anchored agent-loop watchdog
  messages and `isProviderTimeoutError()` for those stalls plus the exact `Request timed out` transport
  shape. The shared classifier accepts transport timeouts reported as `aborted` while rejecting incidental
  timeout text from commands, MCP servers, and extensions.
- `../test/retry.test.ts` pins the observed positive shapes, negative lookalikes, and stop-reason policy.

### Expected merge conflict zones

- LOW: additive classifiers beside `isRetryableAssistantError()` in `utils/retry.ts`; keep
  `isProviderStreamStallError()` aligned with PR #453 when the branches meet.

## 2026-07-29 - kimi-xtml text tool-call protocol + ToolCallFormat union

### What changed and why

- `ToolCallFormat` gains `"kimi-xtml"` (Kimi K3 native XTML channel syntax); `getToolCallFormat()` whitelist, protocol registry, compat docs, and middleware TESTING.md updated accordingly. Protocol implementation lives in `tool-call-middleware/protocols/kimi-xtml/` (markers, parse, format, stream); details in `tool-call-middleware/changes.md`.

## 2026-07-28 - Demote unavailable Anthropic tool references instead of failing the request

### What changed and why

- `api/anthropic-messages.ts` gains a final payload pass, `demoteUnavailableToolReferences()`, applied after
  `sanitizeUnsupportedNativeTools()` on every request. Anthropic rejects a request whose message history references
  a tool that is neither defined in `tools` nor discovered through a `tool_reference` block in the same request
  (`400 invalid_request_error: Tool reference '<name>' not found in available tools`). Sessions outlive their
  tools: an MCP server can be absent after a `senpi --session` resume, an extension can stop registering a tool,
  or an `onPayload` hook can strip a definition while the history still carries the call.
- The pass collects defined tool names and names discovered via `tool_reference` blocks (including replayed
  server-side tool-search results), then demotes offending `tool_use` blocks to plain text, demotes their
  `tool_result` blocks in lockstep (preserving the original result text), and strips `tool_reference` entries
  whose definition vanished — so neither the original 400 nor an orphan-pairing 400 can occur.
- `../test/anthropic-tool-reference-integrity.test.ts` drives the full request path offline through a fake
  Anthropic client: single and mixed-turn demotion, still-available tools kept intact, deferred
  `tool_reference` discovery kept intact, and dangling-reference stripping after a payload hook removes a
  definition.

### Expected merge conflict zones

- LOW: the request-finalization chain inside `createRequest()` in `api/anthropic-messages.ts`.
- LOW: new unexported helpers near the other payload sanitizers in `api/anthropic-messages.ts`.

## 2026-07-28 - Retry OpenAI-compatible stream failures before the first chunk

### What changed and why

- `utils/provider-retry.ts` now prefetches the first SDK stream result inside the existing bounded, abortable provider
  retry policy. A retry creates a fresh request only when stream consumption fails before any wire chunk can reach
  the public event stream.
- `api/openai-completions.ts` uses that prefetch wrapper for OpenAI-compatible providers. Once the first chunk exists,
  the stream is replayed exactly once and any later failure remains terminal, preventing duplicated text or tool
  effects.
- The exact property-less gateway error `Upstream error from DigitalOcean: stream failed` is recognized as transient;
  arbitrary property-less errors remain non-retryable.
- `../test/openai-completions-retry.test.ts` covers recovery, retry exhaustion, non-retryable failures, and the
  post-first-chunk no-retry boundary. The isolated mock-loop driver
  `.agents/skills/senpi-qa/scripts/mock-loop-stream-retry.mjs` proves the same behavior through the real source CLI.

### Expected merge conflict zones

- LOW: the request creation/retry block in `api/openai-completions.ts`.
- LOW: shared provider retry classification and stream-prefetch helper in `utils/provider-retry.ts`.


## 2026-07-28 - OpenAI catalog gains `-fast` Priority-processing variants

### What changed and why

- `scripts/generate-models.ts`: new `OPENAI_PRIORITY_TIER_MODEL_IDS` (the OpenAI pricing page's
  Priority table: gpt-5.6-sol/terra/luna, gpt-5.5, gpt-5.4(+mini), gpt-5.2, gpt-5.1, gpt-5(+mini),
  gpt-4.1 family, gpt-4o family, o3, o4-mini) plus an emission pass that clones each eligible
  `openai` provider model into `<id>-fast` with `upstreamModelId` set to the base id and
  `serviceTier: "priority"`. Emission runs after metadata application so variants clone fully
  processed base models, and is scoped to the direct OpenAI provider (Azure clones and
  `openai-codex` are intentionally excluded).
- `src/model.ts`: `Model` gains optional `upstreamModelId` and `serviceTier` so catalog entries
  can carry the alias/tier defaults that previously only models.json or extension model
  definitions could express. This removes the need to hand-maintain `-fast` pseudo-models in
  models.json for stock OpenAI models.
- Variant `cost` rates intentionally equal the base model's: `api/openai-responses.ts`
  `applyServiceTierPricing()` multiplies usage cost by the service-tier multiplier (2x, 2.5x for
  gpt-5.5) at request time, so raised catalog rates would double-count. The request path rewrites
  the wire id to `upstreamModelId`, preserving the multiplier's `model.id === "gpt-5.5"` branch.
- Regenerated catalog: 18 `openai` `-fast` variants added; other provider shards carry routine
  upstream models.dev/OpenRouter drift (e.g. nvidia +14/-2, fireworks +/-2) from regeneration.
- `../test/openai-fast-models.test.ts`: pins variant presence/eligibility, cloned fields, base
  cost rates, non-recursion, and Azure/Codex exclusion.

### Expected merge conflict zones

- LOW: additive set + emission block in `scripts/generate-models.ts`; additive optional fields on
  `Model` in `src/model.ts`; regenerated `src/providers/data/*` shards (regenerate on conflict).


## 2026-07-27 - Codex reasoning summary null omits the field instead of sending "off"

### What changed and why

- `api/openai-codex-responses.ts` `buildRequestBody()` and the internal
  `api/openai-codex-responses/reasoning.ts` normalizer: `reasoningSummary: null` now omits the `summary`
  field from `body.reasoning` instead of sending the literal string `"off"`. The Codex backend's
  `ReasoningSummaryParam` accepts only `concise`, `detailed`, and `auto`, so every request carrying
  `reasoningSummary: null` failed with a 400 `invalid_enum_value`. The coding-agent builtin compaction
  (`summarizationReasoningOptions()`) passes exactly that value to keep summarization turns cheap, which
  made compaction unusable on Codex models. The adapter now also preserves the shipped legacy union while
  normalizing `"off"` to omission and `"on"` to `"auto"`. These semantics match the sibling adapters and
  the official OpenAI Codex CLI reference client, whose `ReasoningSummary::None` is encoded as an absent
  `summary` field for both ordinary and compaction requests. Current upstream pi-mono instead maps null to
  `"auto"`, so this fork intentionally follows the official Codex wire contract rather than claiming
  upstream parity.
- An extension cannot fix this: the invalid value is produced inside the wire adapter's request builder,
  below every extension hook.
- `../test/openai-responses-thinking-matrix.test.ts`: pins both `buildRequestBody()` branches — explicit
  `reasoningEffort` and the thinking-off fallback — across null, legacy `"off"` / `"on"`, and `"auto"`.

### Expected merge conflict zones

- LOW: `api/openai-codex-responses.ts` `buildRequestBody()` reasoning block and the internal
  `api/openai-codex-responses/reasoning.ts` normalizer. Upstream writes
  `summary: options.reasoningSummary ?? "auto"` without the null branch; a clean upstream touch of these
  two object literals should resolve by keeping the null-omit spread.

## 2026-07-27 - Retry Cloudflare 522 connection timeouts

### What changed and why

- `utils/retry.ts` adds `"522"` to the retryable provider-error patterns. Cloudflare surfaces an
  origin that stopped responding as `Error: error code: 522` (Connection timed out); the message
  matched no retryable pattern, so a transient gateway timeout dead-ended the turn instead of going
  through the existing bounded retry policy like the other 5xx statuses (500/502/503/504/524).

### Expected merge conflict zones

- LOW: `utils/retry.ts` retryable provider-error status patterns.

## 2026-07-27 - OAuth loader export for extension providers

- `oauth.ts` now also exports `loadAnthropicOAuth` and `registerBundledOAuthFlowLoaders` from
  `auth/oauth/load.ts` (bundler-safe variable-specifier dynamic import preserved), so coding-agent
  extension providers can reuse the Anthropic PKCE machinery without reaching into package internals.

## 2026-07-27 - Typed Responses remote-compaction capability

- Extracted `OpenAIResponsesCompat` and `SessionAffinityFormat` from the oversized `types.ts` into
  `openai-responses-compat.ts` while preserving their public exports.
- Added `supportsRemoteCompactionV2` so verified OpenAI Responses proxies can explicitly advertise the native
  `compaction_trigger` request contract. Unknown custom proxies remain disabled by default.

## 2026-07-27 - Honor disabled Azure Responses prompt caching

### What changed and why

- `api/azure-openai-responses.ts`: requests with `cacheRetention: "none"` now omit `prompt_cache_key`,
  matching the OpenAI Responses adapter instead of silently enabling Azure prompt-cache affinity from the
  session id.
- `../test/azure-openai-base-url.test.ts`: pins both the existing 64-character cache-key clamp and the
  disabled-cache omission path.

### Expected merge conflict zones

- LOW: `api/azure-openai-responses.ts` request payload construction.

## 2026-07-27 - Treat Anthropic policy blocks as classifier refusals

### What changed and why

- `utils/stop-details.ts`: `isClassifierRefusal()` now accepts typed refusal/sensitive details on mixed
  `toolUse` stops, matching Anthropic streams that finish with a policy block after emitting a tool call.
- The same helper recognizes Anthropic's legacy policy-block error text when a gateway omits typed
  `stopDetails`, while requiring the provider's full restrictions-and-Usage-Policy signature so ordinary
  policy documentation errors remain non-refusals.
- This routes both shapes through the existing immediate pinned model-fallback path instead of executing the
  partial tool call or continuing on the refusing model.

## 2026-07-26 - Cross-model replay hardening (foreign signatures, id collisions, thinking turn shape)

### What changed and why

- `api/openai-responses-shared.ts`: `convertResponsesMessages()` and `backfillReasoningSignatures()` now parse
  persisted reasoning signatures through a guarded `parseReasoningSignature()` that requires a JSON payload with
  `type === "reasoning"`. Foreign providers store non-JSON markers (Kimi's `"reasoning_content"`) or opaque
  payloads (Anthropic thinking signatures) in the same `thinkingSignature` field; when such a block reaches the
  converter with same-model provenance (aliased/custom providers, corrupted session state), the previous
  unguarded `JSON.parse` threw a client-side `SyntaxError` or leaked an invalid item to the API. Unparseable or
  non-reasoning signatures now demote to plain assistant text (empty text is dropped), mirroring the cross-model
  policy in `transformMessages`.
- `utils/tool-call-id.ts`, `api/anthropic-messages.ts`, `api/bedrock-converse-stream.ts`, and
  `api/google-shared.ts`: the Anthropic-compatible adapters now share one collision-safe id normalizer. Over-long
  ids keep a readable prefix plus a `shortHash` of the full id instead of blind 64-char prefix truncation. OpenAI
  Responses tool ids run 450+ chars, and two distinct ids sharing a 64-char prefix previously collapsed into
  duplicate tool ids in Bedrock/Google even after the Anthropic Messages fix, corrupting tool-result pairing.
- `api/anthropic-messages.ts` `buildParams()`: when a thinking-enabled request's final assistant turn contains
  `tool_use` but no leading thinking block — the normal outcome of replaying Kimi/OpenAI history, whose thinking
  demotes to text or drops — thinking is disabled for that request instead of failing with Anthropic's "final
  assistant message must start with a thinking block" 400 on every turn. Adaptive families that reject
  `thinking.type: "disabled"` use the existing valid fallback (`thinking` omitted plus
  `output_config.effort: "low"`).
- `../test/openai-responses-foreign-signature.test.ts`, `../test/anthropic-cross-model-history.test.ts`,
  `../test/bedrock-convert-messages.test.ts`, and `../test/google-shared-tool-call-id.test.ts`: cover foreign
  signature demotion, genuine reasoning-item replay, cross-adapter collision freedom, and both legal
  thinking-degradation wire forms.

### Expected merge conflict zones

- MEDIUM: `api/openai-responses-shared.ts` thinking/text branches of `convertResponsesMessages()` (text emission
  is now a shared `pushAssistantText` closure) and `backfillReasoningSignatures()`.
- LOW: `utils/tool-call-id.ts`, the three adapter imports/call sites, and the thinking-config block of
  `api/anthropic-messages.ts` `buildParams()`.

## 2026-07-27 - Export string-based transient-error classifier

### What changed and why

- `utils/retry.ts` now exports `isRetryableErrorMessage(errorMessage: string)` and `isRetryableAssistantError`
  delegates to it. Callers that hold a thrown `Error` instead of an `AssistantMessage` (the compaction
  extension's blocking summarization path) need the same transient-vs-terminal classification to decide
  between degrading gracefully and surfacing loudly. No pattern changes; classification behavior is identical.

### Expected merge conflict zones

- LOW: `utils/retry.ts` around `isRetryableAssistantError`.

## 2026-07-26 - Retry transient Codex upstream websocket failures

### What changed and why

- `utils/retry.ts` classifies `upstream_unavailable` provider errors as transient so the existing bounded retry policy
  retries Codex websocket proxy disconnects such as `ConnectionClosedOK`.
- The retry classifier and coding-agent event-contract tests pin the exact reported error through the existing retry
  lifecycle rather than introducing provider-specific retry behavior.

### Expected merge conflict zones

- LOW: `utils/retry.ts` transient transport error patterns.

## 2026-07-26 - Repair unpaired Anthropic server-tool blocks and let the pairing 400 retry

### What changed and why

A session died permanently with a 400 `invalid_request_error` reading "`web_search` tool use with id
`srvtoolu_...` was found without a corresponding `web_search_tool_result` block". The assistant turn had persisted two
`server_tool_use` (`web_search`) provider-native blocks and no result blocks - the stream ended
between the search call and its result - and every later request replayed the unpairable halves, so
the session could never recover on its own.

Anthropic validates that each `server_tool_use` is followed, inside the same assistant message, by
its matching `*_tool_result`, and rejects the mirror case too (a result whose `server_tool_use` is
missing).

- `api/anthropic-messages.ts`: assistant conversion now repairs the pairing across the whole
  conversation, not only inside the server-side-fallback boundary. `collectProviderNativeToolPairing`
  walks the conversation in order, tracking which server-tool uses are still resumable: a use answered
  by a result in its own or the next assistant message replays (the deferred-continuation shape the API
  documents); a pending use survives only tool results, because user text, a tool result that registers
  deferred tool names (whose references serialize sibling text after the results), or another
  assistant turn all close the turn; and a blank user message closes nothing because it serializes to
  nothing. Only the unpairable halves are dropped — a closed use and a result whose use is nowhere.
  The predicate covers the `mcp_tool_use` shape for when those blocks become replayable. Paired blocks,
  `fallback`, and `container_upload` replay byte-for-byte as before, so `encrypted_content` fidelity is
  untouched.
- `utils/retry.ts`: the pairing-error wording ("was found without a corresponding", anchored on the
  opening backtick of the result block name) joins the retryable provider-error patterns.
  The repaired history means the retried request is valid, so the session self-heals through the
  existing retry path; if it keeps failing, the error now also reaches the model-fallback chain
  instead of dead-ending the turn.
- `test/anthropic-web-search-replay-encryption.test.ts`: the byte-fidelity fixture gained the
  `server_tool_use` its result belongs to. The assertion is unchanged - the fixture was simply not a
  shape Anthropic can accept.

## 2026-07-26 - Preserve persisted freeform identity when replaying OpenAI Responses calls (#256)

### What changed and why

- `api/openai-responses-shared.ts`: custom Responses calls with no server item id now persist the shared
  `CUSTOM_TOOL_CALL_ITEM_ID_SENTINEL` (`"custom"`) and recover their `custom_tool_call` /
  `custom_tool_call_output` wire types from that evidence. The recovery uses the existing freeform input
  serializer, preserving raw `apply_patch` text during no-tool compaction and model/API replay. It never sends
  the sentinel as an item `id`.
- Active grammar metadata remains the higher-fidelity source when it is available: it continues to choose its
  named input property and retain real custom-call ids, while a sentinel still removes the invalid synthetic id.
- Focused AI and compaction wiremock tests pin raw-input round trips, matching custom result types, model-switch
  preservation, grammar precedence, and the no-invalid-id guard.

This deliberately diverges from upstream's #271 crash-only repair. That patch omitted the invalid sentinel id
but downgraded a historical freeform call to JSON `function_call` when the current request had no tool definitions.
Senpi's compaction path intentionally omits those definitions, so preserving the persisted freeform type is required
for type fidelity and byte-identical patch replay.

### Why extension system couldn't handle this

The persisted tool-call identity is decoded while constructing the provider request in `packages/ai`; extensions only
see the already-normalized context and cannot restore the Responses wire item type.

### Expected merge conflict zones

- HIGH: upstream owns `api/openai-responses-shared.ts`'s `convertResponsesMessages()` tool-call and tool-result
  branches and rewrote the same hunk in #271. Future upstream syncs will collide here; retain sentinel recovery,
  raw-input serialization, and the no-`custom`-id invariant when resolving.

## 2026-07-25 - Thinking-off actually disables reasoning; wire-exact effort ladders across adapters

### What changed and why

Turning thinking **off** silently kept paid reasoning on for several model families, and several
effort ladders degraded a requested level to a weaker wire value. Both are fixed adapter-side; the
generated catalog only gained one compat fact.

Wire truth was established by probing the live Anthropic Messages endpoint before any edit
(7 families x `thinking:{type:"disabled"}`, plus pin/display controls, `max_tokens: 16`):

| probe | result |
|---|---|
| `thinking:{type:"disabled"}` on opus-4-6 / 4-7 / 4-8 / 5, sonnet-4-6 / 5 | **200** - true disable works, kept as-is |
| `thinking:{type:"disabled"}` on `claude-fable-5` | **400** `"thinking.type.disabled" is not supported for this model. Thinking defaults to adaptive mode when not specified` |
| no `thinking` + `output_config:{effort:"low"}` on fable-5 / opus-5 | **200** (with and without an effort beta header) |
| `thinking:{type:"adaptive",display:"summarized"}` on opus-4-6 | **200** |

- `api/anthropic-messages.ts`: the thinking-off branch no longer silently omits the thinking field
  for adaptive families that reject `disabled`. Families that accept `disabled` keep sending it;
  families that cannot (encoded as `compat.supportsDisabledThinking: false`) now send **no** thinking
  block plus `output_config:{effort:"low"}`, because the API defaults to adaptive thinking when the
  field is absent - previously "off" billed full reasoning.
- `api/anthropic-messages.ts`: `ADAPTIVE_THINKING_MODEL_MARKERS` gained `opus-4-8`, `opus-5`,
  `sonnet-5`, `fable-5`, so models without the `forceAdaptiveThinking` compat pin (custom
  `models.json` entries, third-party gateways) get adaptive effort control instead of a
  budget-token request. `mapThinkingLevelToEffort` now floors the extended levels at the adaptive
  ladder's top tier via `NATIVE_XHIGH_EFFORT_MODEL_MARKERS`: `xhigh` -> native `xhigh` where the
  family has it, otherwise `max`; `max` -> `max` always. It previously returned `high` for
  everything except Opus 4.6/4.7, so a map-less Sonnet 4.6/5, Opus 4.8/5 or Fable 5 silently
  under-thought at `high`.
- `api/bedrock-converse-stream.ts`: `buildAdditionalModelRequestFields` returned `undefined` for a
  thinking-off turn, which let every adaptive Claude family on Bedrock fall back to the adaptive
  default. It now sends `thinking:{type:"disabled"}`, or `output_config:{effort:"low"}` for families
  that reject `disabled`; budget-based Claude still sends nothing (extended thinking is opt-in
  there). Its effort ladder got the same `xhigh`/`max` floor fix.
- `api/anthropic-messages.ts`: the "cannot disable thinking" fact is owned by code as well as the
  catalog (`DISABLED_THINKING_REJECTING_MODEL_MARKERS` + `cannotDisableThinking()`). `models.json`
  entries and third-party gateway rows carry no generated compat, so a custom Fable/Mythos model
  would otherwise take the `disabled` branch and get the probe-confirmed 400.
- `api/bedrock-converse-stream.ts`: `supportsAdaptiveThinking` and `supportsNativeXhighEffort` now
  include `opus-5`. Bedrock Opus 5 was classified as budget-based, so it sent
  `thinking:{type:"enabled",budget_tokens}` instead of adaptive + `output_config.effort`, and a
  thinking-off turn sent nothing at all and fell back to adaptive. It also gained the same
  family-marker check so application inference profiles and custom Fable rows never receive
  `disabled`.
- `models.ts` `supportsXhigh`: recognizes `gpt-5.6`, `opus-5`, `sonnet-5` and `fable-5`.
- `api/openai-completions.ts`: added the missing no-map fallback ladders (Kimi K3 `low/high/max`,
  DeepSeek and GLM 5.2 `high/max`, OpenRouter DeepSeek `high`-only, MiMo `minimal->low` /
  `xhigh->high`, Ollama `low/medium/high/max`) and made an explicit catalog `null` suppress the wire
  effort instead of forwarding the raw requested value. Applied consistently to `streamSimple`, every
  value-bearing `thinkingFormat` branch, and chat-template effort kwargs.
- `api/openai-responses.ts`, `api/azure-openai-responses.ts`, `api/openai-codex-responses.ts`:
  explicit `max: "max"` is preserved for GPT-5.6 instead of being clamped, an explicit
  `thinkingLevelMap` `null` wins for direct adapter options (including summary-default resolution),
  and Codex sends its catalog-directed off sentinel when agent-level off arrives as omitted reasoning.
- `api/google-generative-ai.ts`, `api/google-vertex.ts`: a runtime thinking-off request fell through
  to an *enabled* reasoning form (worst case `thinkingBudget: 24576` with `includeThoughts: true` on
  Gemini 2.5 Flash). Both `streamSimple` paths now route off to the adapter's disabled form.
  `api/mistral-conversations.ts` was audited and needed no change: off provably cannot reach the
  `?? "high"` fallback.
- `scripts/generate-models.ts`: Fable 5 on `anthropic-messages` is now encoded as
  `compat.supportsDisabledThinking: false` instead of `thinkingLevelMap.off: null`. Both express
  "never send `thinking.type: disabled`", but the compat form keeps `off` a **selectable** level, so
  the UI can offer off and the provider pins the cheapest effort. Bedrock/Converse Fable rows keep
  `off: null` unchanged. Regenerated data therefore differs only in those fable-5 rows (plus one
  incidental OpenRouter price refresh).

### Known limitation (deliberate)

For Fable 5 the API exposes **no** true off switch: `thinking.type: "disabled"` is rejected and an
absent thinking field means adaptive. `off` therefore maps to the cheapest adaptive effort rather
than zero reasoning. That is strictly better than the alternatives - before this change `off` was
hidden and the level clamped to the lowest selectable tier, which produced the *same* wire effort
while labelling it `minimal`. The level stays labelled `off` because it is the cheapest reasoning the
model can be asked for, and no other senpi surface can promise more.

### Why extension system couldn't handle this

The thinking-off wire shape, the effort ladder floors and the beta/compat gating all live inside the
provider request builders in `packages/ai`, below any extension-visible surface.

## 2026-07-23 - Session-scoped provider resolution via node-only AsyncLocalStorage subpath

### What changed and why

- New node-only subpath module `packages/ai/src/node/provider-scope.ts`, exported as
  `@earendil-works/pi-ai/node/provider-scope`. It owns an `AsyncLocalStorage<ProviderScope>` plus
  `runWithProviderScope` and `bindToProviderScope(fn)` (explicit callback binding for EventEmitter/
  watcher callbacks, because EventEmitter does not propagate ALS from registration time).
  `ProviderScope` carries `active|closed` state and a per-scope overlay `Map`.
- `api-registry.ts` stays browser-neutral: a synchronous scope-accessor install hook (default: none)
  lets the RPC host install a strict accessor. With no accessor installed, every classic path is
  byte-identical (browser smoke pins this). The faux fast path (`getRegisteredFauxProvider` short-circuit
  at `api-registry.ts:78-82`) consults the active scope first or is scope-keyed.
- Scope-aware behavior for ALL registry operations: `getApiProvider`, `getApiProviders`,
  `registerApiProvider`, `unregisterApiProviders`, `clearApiProviders`, `resetApiProviders`
  (`compat.ts:143-147`). In an active scope, resolution = `session overlay → immutable builtin set` —
  NEVER the mutable legacy global. After `close_session` the scope is closed and any lookup/mutation
  through it throws (no silent fallback). Reaching provider lookup in multi-session mode with NO
  active scope throws a diagnostic error (fail-loud, not fall-through).
- The image-provider registry is scoped identically to the API-provider registry (same overlay →
  immutable-builtins-only resolution, same closed-scope throws semantics).
- Builtin identity semantics preserved: `getBuiltinProviderForModel` (`compat.ts:127-140,173`)
  keeps reference-identity routing in `getBuiltinProviderForModel` / `builtinApiProviderInstances`
  while a scope holds unrelated overlay entries.
- Browser-safety approach: the synchronous scope-accessor install hook keeps `packages/ai` root and
  compat exports browser-neutral; the only `node:async_hooks` import lives behind the node-only
  subpath. Root/compat stay browser-safe; `npm run check:browser-smoke` stays green.

### What future refactors must NOT break

- Overlay → immutable-builtins-only resolution in an active scope; NEVER fall back to the mutable legacy
  global in multi-session mode.
- A closed scope must throw on any lookup/mutation (no silent fallback).
- Builtin identity semantics (`builtinApiProviderInstances` reference-identity routing in
  `getBuiltinProviderForModel`) must keep working while a scope holds unrelated overlay entries.
- Root/compat exports must stay browser-safe: no `node:async_hooks` (or any node-only) import reachable
  from root or compat; the scope accessor ships only from the node-only subpath.
- No new dependencies (`node:async_hooks` is built-in).

### Expected merge conflict zones

- MEDIUM: `api-registry.ts` scope-accessor install hook + the faux fast-path short-circuit.
- LOW: `compat.ts` builtin identity routing (additive guard only).

## 2026-07-22 - Drop tool results of errored/aborted assistants in transformMessages

### What changed and why

- `api/transform-messages.ts`: the pairing pass now records the toolCall ids of every assistant it skips
  because `stopReason === "error" | "aborted"` into `droppedCallIds` (mirroring the existing skip condition),
  and the emit loop no longer emits a toolResult whose `toolCallId` is in that set — unless the id is also
  declared by a kept assistant (`nextToolCallIndexById`), which still pairs through the normal windows.
  Previously the errored assistant was dropped while its result (a real one, or a placeholder synthesized by
  the compaction pipeline's `repairOrphanedToolResults`) survived, so the request carried a `role:"tool"`
  message whose `tool_call_id` no assistant declared; strict providers (apitopia/kimi openai-completions)
  reject it with `400 tool_call_id ... is not found`, permanently bricking compaction for the session.
  True orphans (id declared nowhere) and results of kept assistants are unchanged, and kept assistants'
  unanswered calls still get the synthetic "No result provided" result.
- `utils/tool-pair-repair.ts`: `repairOrphanedToolResults` no longer synthesizes placeholder results for
  toolCalls declared by errored/aborted assistants (defense in depth; those assistants are dropped by
  `transformMessages` anyway). The coding-agent compaction copy received the identical guard; the two
  files remain verbatim copies.
- `../test/transform-messages-errored-tool-results.test.ts`: drop cases (errored + real result, aborted +
  synthesized placeholder), preservation cases (kept pair, "No result provided" synthesis, true orphan
  passthrough), and an id re-declared by a later kept assistant. `../test/tool-pair-repair.test.ts`: no
  synthesis for errored/aborted assistants, synthesis kept for a kept re-declaration.

### Expected merge conflict zones

- LOW: `api/transform-messages.ts` second-pass pairing loop and toolResult emit branch;
  `utils/tool-pair-repair.ts` dangling-call synthesis loop.

## 2026-07-21 - OpenAI Responses provider-native completion reconciliation

### What changed and why

- `api/openai-responses-shared.ts`: opaque output items now occupy the existing output-index slot map, so
  `response.output_item.done` replaces the partial `added` payload with the final provider item. OpenAI web-search
  actions commonly arrive only on the done frame; retaining the added placeholder lost the final query/action before
  session persistence and app-server projection.
- `../test/openai-responses.provider-native.test.ts`: covers an action-less added web-search item followed by the
  completed done item.

### Expected merge conflict zones

- LOW: `api/openai-responses-shared.ts` output-slot creation and `response.output_item.done` finalization.

## 2026-07-22 - Omit non-"fc" item ids when replaying tool calls as function_call

- `api/openai-responses-shared.ts` `convertResponsesMessages()`: a `function_call` input
  item's `id` is now emitted only when it begins with "fc" — the Responses API rejects
  anything else (`Invalid 'input[N].id': 'custom'. Expected an ID that begins with 'fc'.`).
  Custom tool calls are stored with the `<call_id>|custom` sentinel (a `custom_tool_call`
  output carries no server-issued item id), so replaying them without their freeform tool
  registered — compaction summarization strips `freeform` from its tool list — previously
  sent `id: "custom"` and hard-failed the whole request, tripping the compaction circuit
  breaker. Omitting mirrors the existing different-model pairing-validation skip;
  server-issued `fc_…` ids still replay unchanged.
- `../test/openai-responses-custom-tools.test.ts`: sentinel omission plus a pin that
  genuine `fc` ids survive same-model replay.

### Expected merge conflict zones

- LOW: `convertResponsesMessages` function_call emission branch.

## 2026-07-20 - Typed classifier stop details

- Added optional typed refusal/sensitive stop details to assistant messages, preserving Anthropic classifier outcomes through streaming and faux provider errors.
- Exported `isClassifierRefusal` and excluded classifier outcomes from generic same-model retry classification.


## 2026-07-20 - Live tool-result pairing by source position + Retry unsigned Anthropic thinking replay as text

### What changed and why

#### Live tool-result pairing by source position

- `api/transform-messages.ts`: live history normalization now indexes tool results and replayable tool calls by
  source position. Each tool call consumes the earliest still-unconsumed matching result after its declaring
  assistant, emits that result adjacent to the assistant turn, or emits exactly one synthetic error result.
  A repeated ID establishes a new pairing window, so a delayed result cannot attach to an earlier call or be
  replayed twice across an intervening user turn. Aborted and errored assistant turns remain excluded.
- `../test/transform-messages-copilot-openai-to-anthropic.test.ts`: covers delayed normalized results across a
  user turn, partial multi-call results, reused IDs with prior orphaned results, trailing unresolved calls, and
  Anthropic-required tool-result adjacency.

#### Retry unsigned Anthropic thinking replay as text

- `AnthropicMessagesCompat.unsignedThinkingReplay` now explicitly controls replay of thinking blocks without a usable signature. The safe default is text replay for first-party/signing endpoints; the legacy `allowEmptySignature` flag remains an alias for Kimi-compatible empty-signature replay.
- When an endpoint rejects an empty replay signature with a pre-stream HTTP 400 containing `Invalid signature in thinking block`, the Anthropic adapter rebuilds the request with unsigned thinking demoted to text and retries exactly once. That learned fallback is scoped to the session, base URL, and model ID, without mutating shared `Model` metadata.
- Signed and redacted thinking replay remains byte-for-byte/native-state preserving. Non-signature 400s and errors after SSE content begins do not retry.

### Files modified

- `api/transform-messages.ts`
- `../test/transform-messages-copilot-openai-to-anthropic.test.ts`
- `types.ts`
- `api/anthropic-messages.ts`
- `../test/anthropic-unsigned-thinking-replay.test.ts`

### Expected merge conflict zones

- LOW: `api/transform-messages.ts` second-pass tool-result normalization.
- LOW: `AnthropicMessagesCompat` replay options and Anthropic request creation.
## 2026-07-17 - Video input modality for Kimi K3 (kimi-coding)

### What changed and why

- `types.ts`: `Model.input` union gains `"video"`. No new message content type: video payloads ride the
  existing `ImageContent` block with a `video/*` mimeType (helper `isVideoMimeType()` exported) to keep the
  message contract and the upstream merge surface unchanged.
- `api/transform-messages.ts`: `downgradeUnsupportedImages` now first replaces video-mime blocks with a
  placeholder for models without the `"video"` modality (user and toolResult content), then applies the
  existing image downgrade. Prevents cross-model replay from sending video blocks to providers that reject
  them.
- `api/anthropic-messages.ts`: `convertContentBlocks` and the user-message block mapping serialize
  video-mime blocks as `{type:"video", source:{type:"base64", media_type, data}}` — the wire shape the
  Kimi Anthropic-compatible endpoint accepts (verified against MoonshotAI/kimi-code kosong anthropic
  provider). The block is not in the official SDK union, so it is cast like the existing `tool_reference`
  escape hatch.
- `scripts/generate-models.ts` + regenerated `providers/kimi-coding.models.ts`: kimi-coding `k3` declares
  `input: ["text", "image", "video"]`.

### Files modified

- `types.ts`
- `api/transform-messages.ts`
- `api/anthropic-messages.ts`
- `../scripts/generate-models.ts`
- `providers/kimi-coding.models.ts` (generated)
- `../test/transform-messages-video.test.ts`

### Expected merge conflict zones

- LOW: `types.ts` `Model.input` union and `ImageContent` comment.
- MEDIUM: `api/anthropic-messages.ts` `convertContentBlocks` / `convertToolResult` if upstream reworks
  content serialization.
- LOW: `api/transform-messages.ts` `downgradeUnsupportedImages`.

## 2026-07-19 - Name-preserving apply_patch replay characterization and policy coverage

### What changed and why

- Added characterization + policy-table coverage for replaying mixed edit/apply_patch
  history across every KnownApi: Responses targets serialize a historical apply_patch call
  as `custom_tool_call` when a freeform apply_patch is declared and as `function_call`
  (name preserved, JSON `{input}` args) otherwise; Completions/Anthropic/Google/Bedrock/
  Mistral/pi-messages keep the stored name with native JSON-typed call entries.
- No production change was required: existing converters already implement the
  name-preserving truth table. Tests pin both branches plus per-API shape assertions so a
  future regression cannot silently rename or drop historical patch calls.

## 2026-07-17 - Truncation-recovery contract for ToolCall and toolcall_end

### What changed and why

- Truncated text-protocol tool calls were silently dropped, leaked as raw markup, or executed from a
  stale argument snapshot, with no public signal distinguishing a finalized (executable) call from
  one the parser could only partially recover. Consumers had no contract for "this tool call is
  incomplete; do not execute it; ask the model to retry."
- `ToolCall` gains optional `incomplete?: true` and `errorMessage?: string`, set by the text tool-call
  middleware when a truncated call could not be recovered. Carriers of `incomplete` MUST NOT be
  executed; they are surfaced as a failed tool result so the model re-issues the call next turn.
- The `toolcall_end` member of `AssistantMessageEvent` is redefined from an implicit "complete" to
  "finalized": a `toolcall_end` is executable iff `incomplete !== true`. Flagged ends still terminate
  the call (so the wrapper never holds a dangling partial) but are not executable. This is the
  release-note surface for the redefinition.
- `ToolCallFormat` gains `"morph-xml"` as the canonical id; `"xml"` is retained as a deprecated alias
  resolving to the same protocol, so existing `models.json` configs and compiled consumers of
  `getProtocol("xml")` keep working without a runtime normalization that rewrites stored config
  values.
- Flagged dangling-call diagnostics always append `Re-issue the tool call with complete arguments.` to parser-provided error messages without duplicating a final period.
- `compat.ts` now publicly re-exports `getToolCallFormat`, `getProtocol`, `transformContext`, and `wrapStreamWithToolCallMiddleware` for composed providers that need the text tool-call middleware.

### Files modified

- `types.ts` (`ToolCall`, `AssistantMessageEvent.toolcall_end`, `OpenAICompletionsCompat.toolCallFormat` doc)
- `tool-call-middleware/types.ts`, `tool-call-middleware/index.ts`, `tool-call-middleware/context-transformer.ts`
- `../test/tool-call-middleware/context-transformer.test.ts`, `../test/tool-call-middleware/stream-integration.test.ts`

### Why the higher-level extension system couldn't handle this alone

- The canonical `ToolCall` shape, the `toolcall_end` event contract, and the `ToolCallFormat` union
  are all exported from `pi-ai` and consumed by standalone `pi-ai` clients before any coding-agent
  extension runs.

### Expected merge conflict zones

- LOW: `types.ts` around the `ToolCall` and `AssistantMessageEvent` declarations.
- LOW: `tool-call-middleware/types.ts` `ToolCallFormat` union and `toolcall_end` variant.

## 2026-07-17 - Moonshot root object-union compatibility

### What changed and why

- `utils/tool-schema-compat.ts`: Moonshot normalization now flattens a root `anyOf`/`oneOf` of object parameter
  shapes into one `type: "object"` schema. Properties are merged and only branch-common required fields remain.
  Kimi rejects a root combiner without `type`, but also rejects a sibling root `type` beside that combiner, so the
  union must be represented as a permissive object at the function-parameter boundary.
- `../test/openai-completions-tool-schema-compat.test.ts`: covers the real `click`-style coordinate/index union and
  the final post-hook request payload.

### Why the higher-level extension system couldn't handle this alone

- The provider adapter owns the final wire schema after payload hooks and is the only layer shared by direct
  Moonshot requests and custom Moonshot-compatible gateways.

### Expected merge conflict zones

- LOW: `utils/tool-schema-compat.ts` if upstream expands its provider-specific schema normalizers.

## 2026-07-17 - Final-boundary Moonshot tool schema normalization

### What changed and why

- `api/openai-completions.ts`: re-normalizes function tool parameter schemas after `onPayload` and immediately before
  the OpenAI SDK request. Payload hooks can replace or inject tools after the ordinary `convertTools` pass; those tools
  previously bypassed the Moonshot/MFJS compatibility transform and could retain a parent `type` beside `anyOf`, which
  Moonshot rejects with HTTP 400.
- `../test/openai-completions-tool-schema-compat.test.ts`: captures the real HTTP request and locks the post-hook wire
  shape.

### Why the higher-level extension system couldn't handle this alone

- `before_provider_request` is exposed through `onPayload`, so the provider adapter is the only layer that can validate
  the complete tool list after every hook has run.

### Expected merge conflict zones

- LOW: `api/openai-completions.ts` around the `onPayload` callback and final request submission.

## 2026-07-16 - Anthropic native web_search endpoint guard and server_tool_use input streaming

### What changed and why

- `types.ts`: added `AnthropicMessagesCompat.supportsWebSearch`. Default (resolved in
  `getAnthropicCompat`): true only for the first-party `api.anthropic.com` endpoint; compatible providers and
  provider overrides can
  opt in per model via `compat`.
- `api/anthropic-messages.ts`: `sanitizeUnsupportedNativeTools` now also strips hook-injected native `web_search_*`
  tools when the resolved compat does not support them, mirroring the existing native computer tool guard and the
  OpenAI Responses `web_search_preview` compat guard (2026-05-15). Anthropic-compatible endpoints such as kimi-coding
  execute the server-side search but reject the replayed `server_tool_use` / `web_search_tool_result` blocks on the
  next request (kimi-coding 400s with `tool_call_id is not found`), wedging the session. Named `tool_choice` is
  preserved when a same-name function fallback remains and removed only when the retained tool list no longer
  contains that choice.
- `api/anthropic-messages.ts`: same-model provider-native replay also drops web-search server-tool blocks
  (`server_tool_use` named `web_search` and `web_search_tool_result`) when the endpoint lacks `supportsWebSearch`.
  Sessions that already recorded such blocks against an incompatible endpoint were permanently wedged — every
  request replayed the rejected blocks; dropping the pair loses the searched context but unwedges the session.
- `api/anthropic-messages.ts`: streaming now accumulates `input_json_delta` for Anthropic's confirmed
  provider-native tool-use blocks (`server_tool_use` and beta `mcp_tool_use`) and merges the parsed input into the stored raw block at
  `content_block_stop` (or in the abort/error finalizer for interrupted streams). Previously the block kept the
  `content_block_start` snapshot (`input: {}`), so every same-model replay sent the server tool call with an empty
  input. Unknown and result-shaped blocks are never touched; their raw provider payload must remain verbatim.

### Files modified

- `types.ts`
- `api/anthropic-messages.ts`
- `../test/anthropic-native-web-search-compat.test.ts`
- `../test/anthropic-provider-native-replay.test.ts`
- `../test/anthropic-web-search-replay-encryption.test.ts`
- `../test/anthropic.provider-native.test.ts`
- (see also `../../coding-agent/src/core/changes.md` for the models.json compat schema entry)

### Why the higher-level extension system couldn't handle this alone

- Extensions can inject native `web_search_*` tools via `before_provider_request`; the final payload is only known
  after all hooks run, so the provider is the last reliable guard before SDK submission (same rationale as the
  OpenAI Responses guard). Provider-native block capture during streaming happens inside `pi-ai` before any
  extension sees the message.

### Expected merge conflict zones

- MEDIUM: `api/anthropic-messages.ts` around `getAnthropicCompat`, `sanitizeUnsupportedNativeTools`, and the
  `content_block_delta` / `content_block_stop` streaming handlers.
- LOW: `types.ts` `AnthropicMessagesCompat` if upstream adds more compat flags.

## 2026-07-14 - Anthropic web search replay encrypted content correction

### What changed and why

- `api/anthropic-messages.ts`: same-model provider-native replay now preserves each nested `web_search_result` item's
  `encrypted_content` byte-for-byte before sending prior server-side web search results back in the next Anthropic
  request. The existing same-provider/api/model boundary, fallback pruning, and cross-model dropping behavior remain
  unchanged.
- Anthropic's current web-search contract requires `encrypted_content` to be passed back unmodified for multi-turn use.
  The July 8 stripping workaround was wrong under that contract: it discarded opaque provider-owned replay state after
  one observed 400, even though the raw session stored all seven encrypted fields and Senpi removed them during
  conversion.

### Files modified

- `api/anthropic-messages.ts`
- `../test/anthropic-provider-native-replay.test.ts`
- `../test/anthropic-web-search-replay-encryption.test.ts`

### Expected merge conflict zones

- LOW: `api/anthropic-messages.ts` around `sanitizeReplayableAnthropicProviderNativeBlock` and the provider-native
  replay path.

## 2026-07-06 - Anthropic server-side fallback replay contract

### What changed and why

- The server-side fallback beta (`server-side-fallback-2026-06-01`) emits a `fallback` content block mid-response when
  the serving model falls back (e.g. a `claude-fable-5` refusal replaced by the fallback model). Three fixes
  (2026-07-02 → 2026-07-06) make replaying such turns conform to the beta's contract:
  - `fallback` was added to `REPLAYABLE_ANTHROPIC_PROVIDER_NATIVE_TYPES`; dropping it on same-model replay mutated the
    latest assistant message's block sequence and the API rejected the next request of the turn with a 400
    `thinking … cannot be modified` error, wedging the session.
  - Blocks emitted before the final `fallback` marker belong to the discarded attempt and are now omitted on replay;
    replaying them verbatim left pre-boundary `tool_use` blocks without matching `tool_result`s, rejected with 400
    `tool_use ids were found without tool_result blocks`.
  - An unpaired pre-boundary `server_tool_use` (fallback interrupted the declined attempt before the server tool's
    result arrived) is also dropped; paired server-tool blocks and text still replay verbatim.

### Files modified

- `api/anthropic-messages.ts`
- `test/anthropic-provider-native-replay.test.ts`

### Why the higher-level extension system couldn't handle this alone

- Provider-native block replay filtering happens inside the Anthropic message transformer before any coding-agent
  extension can rewrite provider payloads.

### Expected merge conflict zones

- MEDIUM: `api/anthropic-messages.ts` around `REPLAYABLE_ANTHROPIC_PROVIDER_NATIVE_TYPES` and the assistant-turn
  replay/filter path.
- LOW: `test/anthropic-provider-native-replay.test.ts` fixtures if upstream restructures replay tests.

## 2026-07-02 - Upstream provider metadata and Codex SSE transport sync

### What changed and why

- `api/openai-codex-responses.ts`: accepted upstream zstd request-body compression for Codex Responses SSE while
  preserving the fork's senpi-branded Codex headers, stale response handling, service-tier support, and thinking support.
- `utils/oauth/device-code.ts` and `utils/oauth/github-copilot.ts`: accepted delayed GitHub Copilot device-code polling
  and related OAuth cleanup.
- Provider model catalogs were refreshed for Copilot, Fireworks, OpenCode, Cloudflare AI Gateway, Bedrock, and related
  providers while retaining fork-specific model capability metadata such as `supportsXhigh`.

### Files modified

- `api/openai-codex-responses.ts`
- `providers/amazon-bedrock.models.ts`
- `providers/cloudflare-ai-gateway.models.ts`
- `providers/fireworks.models.ts`
- `providers/github-copilot.models.ts`
- `providers/opencode-go.models.ts`
- `providers/opencode.models.ts`
- `utils/oauth/device-code.ts`
- `utils/oauth/github-copilot.ts`

### Why the higher-level extension system couldn't handle this alone

- Codex SSE request compression, OAuth polling, and generated provider metadata all live inside `pi-ai` before
  coding-agent extensions can intercept a request or model catalog entry.

### Expected merge conflict zones

- MEDIUM: `api/openai-codex-responses.ts` around request body creation, zstd encoding, headers, and stream response
  handling.
- LOW: `utils/oauth/device-code.ts` around polling cadence and error handling.
- LOW: provider `*.models.ts` catalogs when upstream regenerates model metadata.

## 2026-05-19 - Cloudflare Anthropic computer tool guard

### What changed and why
- `providers/anthropic.ts`: Cloudflare Anthropic routes now strip hook-injected native `computer_*` tools after `onPayload`, while preserving supported native tools such as `bash_20250124` and `text_editor_20250124`.
- Computer-use beta request headers are removed only for routes/models that reject the native computer tool.
- Added a regression matching the CF runtime error where `computer_20250124` is not one of the accepted tool tags.

### Files modified
- `providers/anthropic.ts`
- `../test/anthropic-on-payload-headers.test.ts`

### Why the higher-level extension system couldn't handle this alone
- The failing payload can be introduced by `before_provider_request`; the provider adapter is the final point that sees the complete Anthropic request before SDK submission.

### Expected merge conflict zones
- LOW: native-tool sanitization helpers near request metadata extraction.

## 2026-05-18 - Anthropic protected thinking replay

### What changed and why
- `providers/anthropic.ts`: signed Anthropic `thinking` replay now forwards the stored text exactly as-is instead of running it through local surrogate sanitization. Anthropic treats signed and redacted thinking blocks as protected replay state; rewriting them can make the next tool-result request fail with `thinking` / `redacted_thinking` modification errors.
- `providers/transform-messages.ts`: same-model preserved provider-state blocks are now copied rather than shared, and redacted thinking remains same-model only. Cross-model transforms still drop opaque redacted thinking state.
- Added regressions for signed thinking replay, redacted thinking replay, immutable same-model transforms, cross-model redacted thinking dropping, and retry context behavior after a failed assistant turn.

### Files modified
- `providers/anthropic.ts`
- `providers/transform-messages.ts`
- `../test/anthropic-thinking-disable.test.ts`
- `../test/transform-messages-copilot-openai-to-anthropic.test.ts`
- `../../coding-agent/test/suite/regressions/0000-anthropic-partial-thinking-replay.test.ts`

### Why the higher-level extension system couldn't handle this alone
- Anthropic protected thinking is serialized inside `pi-ai`'s provider adapter after history transformation. Extensions and coding-agent retry logic cannot safely repair a signed block once the provider has normalized or shared it.

### Expected merge conflict zones
- LOW: `convertMessages()` signed/redacted thinking block serialization in `providers/anthropic.ts`.
- LOW: same-model `preserveProviderState` branches in `providers/transform-messages.ts`.

## 2026-05-15 - OpenAI Responses `web_search_preview` compat guard

### What changed and why
- `providers/openai-responses.ts`: after `onPayload` hooks run, custom OpenAI Responses endpoints now strip native `web_search_preview` / `web_search_preview_2025_03_11` tools, the matching `tool_choice`, and `web_search_call.action.sources` includes unless `compat.supportsWebSearchPreview` explicitly opts in. Official `api.openai.com` endpoints keep the existing default support.
- `types.ts`: added `OpenAIResponsesCompat.supportsWebSearchPreview` so custom providers can declare support when they really pass OpenAI-native Responses tools through.
- Added regression coverage for hook-injected native web search on a custom Responses endpoint and the explicit opt-in path.

### Files modified
- `providers/openai-responses.ts`
- `types.ts`
- `../test/openai-responses-web-search-compat.test.ts`

### Why the higher-level extension system couldn't handle this alone
- External or user extensions can add provider-native tools through `before_provider_request`; the final OpenAI Responses payload is only known after all hooks have run. The provider is the last reliable guard before SDK submission.

### Expected merge conflict zones
- LOW: `streamOpenAIResponses()` request construction immediately after the `onPayload` callback.
- LOW: `OpenAIResponsesCompat` if upstream adds more Responses compatibility flags.

## 2026-05-15 - Opus 4.6/4.7 unsupported native computer tool guard

### What changed and why
- `providers/anthropic.ts`: after `onPayload` hooks run, Opus 4.6 and 4.7 requests now strip Anthropic's legacy native `computer_20250124` tool and remove `computer-use-2025-01-24` from hook-added `anthropic-beta` request headers.
- Added a regression to cover extension-style payload mutation where a native computer tool is injected alongside another supported native tool. The supported tool and remaining beta header survive; the Opus-rejected computer tool does not reach the SDK request body.

### Files modified
- `providers/anthropic.ts`
- `../test/anthropic-on-payload-headers.test.ts`

### Why the higher-level extension system couldn't handle this alone
- External or user extensions can add provider-native tools through `before_provider_request`; the final provider payload is only known after all hooks have run. The Anthropic provider is the last reliable guard before SDK submission.

### Expected merge conflict zones
- LOW: `streamAnthropic()` request construction immediately after the `onPayload` callback.
- LOW: native-tool sanitization helpers near request metadata extraction.

## 2026-05-15 - Anthropic `onPayload` request headers

### What changed and why
- `providers/anthropic.ts`: when an `onPayload` hook returns request metadata fields (`headers` / `extra_body`), the provider now forwards string-valued `headers` through the Anthropic SDK request options and strips both metadata keys from the JSON request body.
- Added a regression test for native computer-use extensions that inject `computer_20250124` plus `anthropic-beta: computer-use-2025-01-24` from `before_provider_request`. Previously the tool reached Anthropic but the beta header did not, producing a 400 where `computer_20250124` was not among the accepted tool tags.

### Files modified
- `providers/anthropic.ts`
- `../test/anthropic-on-payload-headers.test.ts`

### Why the higher-level extension system couldn't handle this alone
- Extensions can mutate the provider payload via `before_provider_request`, but Anthropic SDK request headers are assembled inside `pi-ai`. The provider must explicitly lift hook-added header metadata into SDK request options after `onPayload` runs.

### Expected merge conflict zones
- LOW: `streamAnthropic()` request construction around the `onPayload` callback and SDK `messages.create()` options.

## 2026-05-11 - Senpi-branded Codex originator and User-Agent

### What changed and why
- `providers/openai-codex-responses.ts` `buildBaseCodexHeaders()`: changed the hardcoded `originator: "pi"` and the `User-Agent: "pi (…)"` string to `"senpi"`. Upstream chose `"pi"` as the Codex CLI identity; this fork's identity is `senpi`.
- `auth/oauth/openai-codex.ts` `createAuthorizationFlow()`: changed the default `originator` parameter from `"pi"` to `"senpi"` and updated the JSDoc on `loginOpenAICodex` accordingly. Callers can still pass their own originator.

### Files modified
- `providers/openai-codex-responses.ts`
- `auth/oauth/openai-codex.ts`

### Why the higher-level extension system couldn't handle this alone
- The originator + User-Agent headers are built inside `pi-ai`'s Codex header constructor before the request leaves the library. Coding-agent extensions cannot intercept the header construction step.

### Expected merge conflict zones
- LOW: `buildBaseCodexHeaders()` body (3 lines) and the `originator` default parameter / JSDoc in `createAuthorizationFlow`.

## 2026-05-07 - Shared tool pair repair utility for compaction-safe histories

### What changed and why
- Added `utils/tool-pair-repair.ts` to centralize bidirectional `tool_use`/`tool_result` pairing repair in `pi-ai`.
- This supports both coding-agent builtin extensions and external `pi-ai` consumers that do not load coding-agent extensions.

### Files modified
- `utils/tool-pair-repair.ts`

### Why the higher-level extension system couldn't handle this alone
- Extension code alone is not available to standalone `pi-ai` consumers, so this shared history repair logic must live in `pi-ai`.

### Expected merge conflict zones
- None expected; this is a new additive utility file.

## 2026-04-13 - OpenAI Responses custom tool support for apply_patch

### What changed and why
- Added optional freeform grammar metadata to tool types.
- Updated OpenAI Responses request/history conversion to emit and preserve `custom` / `custom_tool_call` / `custom_tool_call_output` items for freeform tools. This was required to match Codex GPT `apply_patch` behavior instead of falling back to JSON function tools.

### Files modified
- `types.ts`
- `providers/openai-responses-shared.ts`

### Why the higher-level extension system couldn't handle this alone
- `pi-ai` only serialized tools as JSON function definitions for OpenAI Responses, so a builtin extension could not produce Codex-compatible freeform tools without core provider changes.

### Expected merge conflict zones
- `types.ts` tool model
- `providers/openai-responses-shared.ts` request/stream conversion paths

## 2026-04-17 - Claude Opus 4.7, `max` effort alignment, and extra-body pass-through

### What changed and why
- Added `claude-opus-4-7` to the Anthropic provider and its Bedrock cross-region profiles (`anthropic.*`, `us.*`, `eu.*`, `global.*`) so Opus 4.7 is available in the catalog and survives re-runs of `generate-models.ts`.
- Expanded `supportsXhigh()` to include `opus-4-7` / `opus-4.7` so the coding agent exposes `xhigh` for Opus 4.7 users.
- Expanded Anthropic adaptive thinking support (`supportsAdaptiveThinking`) and effort mapping (`mapThinkingLevelToEffort`) for Opus 4.7:
  - `xhigh` now maps to the native `"xhigh"` effort on Opus 4.7 (Anthropic's newest tier).
  - `xhigh` still maps to `"max"` on Opus 4.6 (Opus 4.6 doesn't support native `xhigh`).
  - Added explicit `"max"` to the effort type union for future use.
  - Cast through `{ output_config?: { effort: AnthropicEffort } }` while the @anthropic-ai/sdk upstream types still reject `"xhigh"`.
- Added `StreamOptions.extraBody` for pass-through custom body fields (matches opencode's provider `options`). Wired it through every builtin provider's payload builder (`anthropic`, `openai-responses`, `openai-completions`, `azure-openai-responses`, `openai-codex-responses`, `mistral`, `google`, `google-vertex`, `google-gemini-cli`, `amazon-bedrock`). A shared `applyExtraBody` helper and per-provider reserved-key sets live in `providers/simple-options.ts` to prevent users from overriding provider-managed fields (model id, messages, stream flag, etc.).

### Files modified
- `types.ts`
- `models.ts`
- `models.generated.ts`
- `providers/simple-options.ts`
- `providers/anthropic.ts`
- `providers/openai-responses.ts`
- `providers/openai-completions.ts`
- `providers/azure-openai-responses.ts`
- `providers/openai-codex-responses.ts`
- `providers/mistral.ts`
- `providers/google.ts`
- `providers/google-vertex.ts`
- `providers/google-gemini-cli.ts`
- `providers/amazon-bedrock.ts`
- `scripts/generate-models.ts`

### Why the higher-level extension system couldn't handle this alone
- Extra-body pass-through has to be read inside each provider's payload builder (pre-`onPayload` hook), which is core `pi-ai` territory; a coding-agent extension cannot reach into `pi-ai` provider payload construction.
- Opus 4.7 model metadata, xhigh capability detection, and adaptive thinking effort mapping all live in `pi-ai`. `supportsXhigh`, `supportsAdaptiveThinking`, and `mapThinkingLevelToEffort` are internal to the provider.
- Running `generate-models.ts` regenerates `models.generated.ts` from models.dev; the Opus 4.7 override block ensures the upstream regeneration keeps our entry.

### Expected merge conflict zones
- `scripts/generate-models.ts` Opus override block (lines around the 4.6 additions).
- `src/providers/anthropic.ts` `supportsAdaptiveThinking` / `mapThinkingLevelToEffort` / `AnthropicEffort`.
- `src/providers/simple-options.ts` (new exports).
- `src/models.ts` `supportsXhigh`.
- `src/types.ts` `StreamOptions.extraBody`.

## 2026-04-17 (follow-up) - "max" ThinkingLevel + tightened extraBody guards + Google `config` merge

### What changed and why
- Exposed Anthropic's native `"max"` effort through the unified `ThinkingLevel` surface: `StreamOptions.reasoning: "max"` maps to `max` on Opus 4.6/4.7, clamps to `high` on other adaptive models, and falls back to the `high` budget on budget-based Anthropic models. OpenAI-style providers clamp `max` to `xhigh` on xhigh-capable models (GPT-5.2/5.3/5.4) and to `high` otherwise via a new `clampMaxForOpenAI` helper.
- Extended the per-provider reserved-key sets so `extraBody` cannot stomp library-managed fields. New reservations include `metadata`, `temperature`, `store`, `stream_options`, `provider`, `providerOptions`, `tool_stream`, `prompt_cache_key`, `prompt_cache_retention`, `service_tier`, `promptMode`, `requestMetadata`. The Google reserved set now targets the inner `config` object (which the @google/genai SDK serializes as the HTTP request body) with `systemInstruction` / `tools` / `toolConfig` / `generationConfig` / `thinkingConfig` / `responseMimeType` / `responseSchema` / `cachedContent` / `abortSignal` / `httpOptions` reserved.
- Merged Google and Google Vertex `extraBody` into `params.config` instead of the top-level `GenerateContentParameters` so user-supplied fields actually reach the Gemini wire (the SDK does not serialize root-level unknown fields).
- Updated `adjustMaxTokensForThinking` / `clampReasoning` to accept the new `"max"` level without crashing on missing budget entries.

### Files modified (follow-up)
- `src/types.ts` (ThinkingLevel adds `"max"`)
- `src/providers/simple-options.ts` (added `clampMaxForOpenAI`, tightened reserved sets, Google reservations target `config`)
- `src/providers/anthropic.ts` (`mapThinkingLevelToEffort` native `max` case, JSDoc refresh, reserved keys `metadata` + `temperature`)
- `src/providers/openai-responses.ts`, `openai-completions.ts`, `openai-codex-responses.ts`, `azure-openai-responses.ts` (use `clampMaxForOpenAI` on xhigh-capable models)
- `src/providers/amazon-bedrock.ts` (budget table adds `max`, clamp `max` on budget-based path)
- `src/providers/google.ts`, `google-vertex.ts` (merge extraBody into `config`)

### Why the higher-level extension system couldn't handle this alone
- The `ThinkingLevel` union, provider effort mapping, and reserved-key sets all live inside `pi-ai`. Exposing `"max"` to the coding agent requires widening the shared union and updating every provider's payload builder and option-derivation logic.

### Expected merge conflict zones (follow-up)
- `src/types.ts` `ThinkingLevel` union.
- Each provider's `streamSimple<Provider>` reasoning mapping block.
- `src/providers/simple-options.ts` exported reserved-key sets.

## 2026-07-22 - Thinking content stream timing metadata

### What changed and why

- `ThinkingContent` now exposes optional `startedAt` and `endedAt` epoch-millisecond fields. The agent loop stamps these at provider stream-event receipt on a best-effort basis, allowing consumers to measure individual reasoning-block duration without changing provider event contracts.

### Expected merge conflict zones

- LOW: `src/types.ts` `ThinkingContent` interface.

## Client abort on Anthropic server-side fallback receipts (2026-07-25)

### What changed

- `utils/server-fallback-receipt.ts`: new module parsing Anthropic's `fallback` content block and the `fallback_message` entry in `usage.iterations`, plus the refusal-shaped rewrite applied to an aborted turn.
- `types.ts`: `StreamOptions.abortServerSideFallback` (opt-in), inherited by `SimpleStreamOptions` and `AnthropicOptions`; `api/simple-options.ts` forwards it through `buildBaseOptions`.
- `api/anthropic-messages.ts`: a provider-local `AbortController`, merged with the caller signal through `combineAbortSignals`, is passed to the request and the SSE iterator. A receipt block or a `fallback_message` usage entry aborts it and finalizes the turn as `{stopReason:"error", stopDetails:{type:"refusal"}}` with empty content plus `server_fallback_aborted` and `billing_incomplete_after_client_abort` diagnostics. A caller abort is checked first and always wins.

### Why the extension system couldn't handle this

Detection has to happen inside the Anthropic SSE loop while the stream is still open; nothing outside the provider can stop reading a response mid-flight.

### Expected merge conflict zones

- MEDIUM: `api/anthropic-messages.ts` streaming event loop and request-option construction.
- LOW: `types.ts` `StreamOptions`, `api/simple-options.ts` `buildBaseOptions` field list, `index.ts` export list.

## 2026-08-25 - Preserve upstream provider adapter behavior

### What changed

- `packages/ai/src/api/openai-completions.ts` and `packages/ai/src/providers/cloudflare-ai-gateway.ts` retain fork provider behavior while adopting upstream reasoning and typing fixes.

### Why

- Provider wire behavior is a runtime contract.

### Why this lives in the fork

- Adapter serialization and provider registration run below extension hooks.

### Expected merge conflict zones

- OpenAI Completions reasoning conversion and Cloudflare provider generic declarations.
