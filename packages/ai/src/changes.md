# AI Source Changes

## 2026-08-11 - Optional availability `check` on `OAuthAuth`

### What changed and why

Added an optional `check?(input)` to `OAuthAuth` (`auth/types.ts`) and taught `checkProviderAuth` (`models.ts`) to consult it in the stored-OAuth-credential branch. Previously that branch was a pure structural short-circuit — `provider.auth.oauth ? {configured} : undefined` — so any stored OAuth credential, including an empty sentinel envelope with zero accounts, reported the provider as configured. The fallback engine reads configured-ness through `hasConfiguredAuth`, so such a provider was never skipped as `unauthenticated`. `ApiKeyAuth` already exposes an equivalent `check`; this makes the OAuth path symmetric. When `check` is absent, behavior is byte-identical to before, so every existing OAuth provider is unaffected. This cannot be extension-local: the short-circuit lives in `ModelsImpl.checkProviderAuth`, which no extension hook reaches, and `OAuthAuth` had no `check` to supply.

### Expected merge-conflict zones

LOW in `auth/types.ts` (additive optional field on `OAuthAuth`); LOW in `models.ts` `checkProviderAuth` (one stored-OAuth branch expanded, existing behavior preserved when `check` is undefined).

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
- `utils/oauth/openai-codex.ts` `createAuthorizationFlow()`: changed the default `originator` parameter from `"pi"` to `"senpi"` and updated the JSDoc on `loginOpenAICodex` accordingly. Callers can still pass their own originator.

### Files modified
- `providers/openai-codex-responses.ts`
- `utils/oauth/openai-codex.ts`

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
