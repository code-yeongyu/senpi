## 2026-10-26 - The remaining provider families capture block seeds at emission (senpi#4285, part of #4272)

### What changed

- `packages/ai/src/api/bedrock-converse-stream.ts`: the stream is created with capture. Each `signature` reasoning
  delta, which grows `thinkingSignature` with no event, records a `message_block_metadata` `thinkingSignatureDelta`;
  the first `redactedContent` of a block records `redacted: true` (plus `thinkingSignature: ""` when a signature had
  accumulated) before the placeholder `thinking_delta`.
- `packages/ai/src/api/mistral-conversations.ts`, `packages/ai/src/api/pi-messages.ts`: the stream is created with
  capture. Their tool argument text grows by exactly the emitted deltas and is parsed on every delta (Pi keeps it in
  the converter's closure-local `toolJson` store), so the default capture already records the raw spelling and the
  parse frontier; Mistral's object arguments are recorded in the spelling the adapter emitted.
- `packages/ai/src/api/google-generative-ai.ts`, `packages/ai/src/api/google-vertex.ts`: the stream is created with
  capture. A thought signature that `retainThoughtSignature` installs on a text or thinking block records a
  replacement `textSignature`/`thinkingSignature`; the tool delta (`JSON.stringify` of complete arguments) carries
  `parsedThrough: 0`, so the complete parsed seed stays authoritative; native parts and the candidate's
  `groundingMetadata`/`urlContextMetadata` blocks, appended with no event, record `message_block_state` insert and end
  sharing one frozen copy.
- `packages/ai/src/api/cursor-agent.ts` (fork-only): the stream is created with capture; an MCP argument delta
  carries the parse frontier at Cursor's throttled reparse (`kStreamingLastParseLen`), so the stale preview survives
  until the next 1024-unit reparse.
- `packages/ai/src/api/devin-agent.ts`, `packages/ai/src/api/devin-agent/stream-state.ts` (fork-only): the stream is
  created with capture; a replaced `thinkingSignature` and a tool name that arrives after its start record
  `message_block_metadata`.

### Why

- These adapters mutate public blocks with no event (Bedrock signature growth and redaction, Google signatures and
  native/grounding blocks, Devin signatures and late names) or hold raw argument text in adapter state; only the
  adapter knows those facts at emission time (R3.C6.2, ruling 05 D1-D3). S02a-1 covered Anthropic, Responses and
  Completions; this completes the producer side.

### Why an extension could not handle it

- The mutations happen inside adapter closures before any event exists; no hook exposes the emitted spelling, the
  parse frontier or the event-less native blocks.

### Expected merge conflict zones

- LOW: each adapter's stream construction line.
- LOW: `bedrock-converse-stream.ts` `handleContentBlockDelta` signature and redaction branches.
- LOW: `google-generative-ai.ts`/`google-vertex.ts` text/thinking delta branches, the `functionCall` delta push, the
  native-part branch and the grounding/urlContext metadata branches.

## 2026-10-25 - Anthropic, Responses and Completions capture seeds and native transitions at emission (senpi#4277, part of #4272)

### What changed

- `packages/ai/src/api/anthropic-messages.ts`: the stream is created with capture. Unknown (native) blocks record a
  `message_block_state` insert at `content_block_start` and an end at `content_block_stop` after `raw.input` is
  parsed; each `signature_delta` records only its delta as `thinkingSignatureDelta`.
- `packages/ai/src/api/openai-responses-shared.ts`: `processResponsesStream` enables capture on its stream; a
  `function_call` start carries its possibly nonempty raw prefix (`item.arguments`) while its parsed seed stays
  `{}`; native items record insert and replacement end in original index order, including image reconciliation
  and terminal backfill; an `arguments.done` that does not extend the streamed prefix records an authoritative
  `message_tool_arguments_reset`.
- `packages/ai/src/api/openai-responses.ts`, `packages/ai/src/api/openai-codex-responses.ts`,
  `packages/ai/src/api/azure-openai-responses.ts`: the stream is created with capture, so `start` is captured too.
- `packages/ai/src/api/openai-completions.ts`: the stream is created with capture. Deferred mixed-event flushes
  emit starts whose coverage matches what they already hold: replayed deltas start at offset 0, and a tool start's
  raw prefix is the deferred normalized deltas (function or grammar spelling) with its parse frontier at their end.
  Per-chunk `reasoning_details` signature growth is not recorded (each chunk re-serializes the whole list); the
  `thinking_end` block and the terminal message carry the final signature.
- `packages/ai/src/api/lazy.ts`: the lazy wrapper is carrier-aware. Its forwarder reads the inner stream with
  `assistantEvents`, so events keep their carriers and progress records cross to the outer stream as they are read
  without an extra forwarder turn; the outer stream registers a records reader that keeps its cancellation.

### Why

- These adapters mutate public blocks without an event (native insert/end, signature growth, raw replacement) and
  hold raw argument spelling in adapter state; only the adapter knows them at emission time (R3.C6.2, ruling 05
  D1-D3). Builtin providers load through `lazyApi`, so the lazy wrapper must carry what the adapter captured.

### Why an extension could not handle it

- The mutations happen inside adapter closures before any event exists; no hook exposes the emitted raw spelling,
  coverage or native transitions.

### Expected merge conflict zones

- LOW: each adapter's stream construction line.
- LOW: `anthropic-messages.ts` `content_block_start` native branch, `signature_delta` branch and the
  `content_block_stop` `providerNative` branch.
- MEDIUM: `openai-responses-shared.ts` `createSlot` (function call and native slots), the image backfill loop,
  the `arguments.done` branch and the native `output_item.done` branches.
- LOW: `openai-completions.ts` `flushDeferredBlocks`.
- LOW: `lazy.ts` `setCancellationHandler` and the source iterator in `lazyStream`.

## 2026-10-22 - Anthropic stable-prefix cache checkpoints (senpi#3242)

### What changed

- `packages/ai/src/api/anthropic-messages.ts`: `convertMessages` puts `cache_control` on the last `text`/`tool_use` block of an assistant message carrying `promptCacheBreakpoint` (never on a thinking block). Two hints are honoured when the system block holds a checkpoint (OAuth identity or a system prompt), and the second takes the tools checkpoint's slot because the system checkpoint covers the tools before it. Otherwise only the oldest hint is honoured. A hinted request drops the preceding tool-loop checkpoint, so a request never exceeds four breakpoints; a turn with ten or more parallel tool calls can then push the previous entry past the 20-block lookback and re-write the tail since the cut (bounded by the 10% block budget).
- `packages/ai/src/api/pi-messages.ts`: strips `promptCacheBreakpoint` from assistant messages before sending, because the pi-messages wire carries `context.messages` as they are.

### Why

- `packages/ai/src/api/anthropic-messages.ts`: Anthropic finds earlier cache entries only within about 20 blocks before a breakpoint, and the breakpoints sat at the end of the conversation. A context-reduction step's request therefore read only the system prefix and re-wrote everything after it (400K-780K tokens per step on 1M windows in the reports). A checkpoint at the last message the frontier leaves unchanged lets the next step read that prefix.
- `packages/ai/src/api/pi-messages.ts`: the pi-messages wire carries `context.messages` as they are, so a request-local hint must not leak onto it.

### Why an extension could not handle it

- `packages/ai/src/api/anthropic-messages.ts`: breakpoint placement is the adapter's own request construction, after every extension payload hook.
- `packages/ai/src/api/pi-messages.ts`: the adapter serializes the message list itself.

### Expected merge conflict zones

- `packages/ai/src/api/anthropic-messages.ts`: `buildParams` (marker count, `toolCacheControl`, the `convertMessages` call), `convertMessages` (assistant branch, final checkpoint block) and the new `markAssistantMessageCacheCheckpoint`.
- `packages/ai/src/api/pi-messages.ts`: the `context.messages` mapping in the request payload.

## 2026-10-21 - usage.reasoning is left unset when the provider reports no reasoning count (senpi#3879)

### What changed

- `packages/ai/src/api/openai-completions.ts`: `usage.reasoning` is set only when `completion_tokens_details.reasoning_tokens` is a finite number (through `utils/reported-count.ts` `reportedCount`); absent, `null` or non-finite leaves it unset, and a reported 0 stays 0. It used to be `|| 0`.
- `packages/ai/src/api/openai-responses-shared.ts`: `usage.reasoning` is set only when `output_tokens_details.reasoning_tokens` is a finite number (through `utils/reported-count.ts` `reportedCount`); absent, `null` or non-finite leaves it unset, and a reported 0 stays 0. It used to be `|| 0`.
- `packages/ai/src/api/google-generative-ai.ts`: `usage.reasoning` is set only when `usageMetadata.thoughtsTokenCount` is a finite number (through `utils/reported-count.ts` `reportedCount`); absent, `null` or non-finite leaves it unset, and a reported 0 stays 0. It used to be `|| 0`.
- `packages/ai/src/api/google-vertex.ts`: `usage.reasoning` is set only when `usageMetadata.thoughtsTokenCount` is a finite number (through `utils/reported-count.ts` `reportedCount`); absent, `null` or non-finite leaves it unset, and a reported 0 stays 0. It used to be `|| 0`.

### Why

- `packages/ai/src/api/openai-completions.ts`: `Usage.reasoning` is documented as "left undefined by providers that don't" expose a breakdown, but these adapters zero-filled it, so a client could not tell a reported zero from no data and showed "Reasoning 0" for providers that never report it (desktop #3729 review).
- `packages/ai/src/api/openai-responses-shared.ts`: `Usage.reasoning` is documented as "left undefined by providers that don't" expose a breakdown, but these adapters zero-filled it, so a client could not tell a reported zero from no data and showed "Reasoning 0" for providers that never report it (desktop #3729 review).
- `packages/ai/src/api/google-generative-ai.ts`: `Usage.reasoning` is documented as "left undefined by providers that don't" expose a breakdown, but these adapters zero-filled it, so a client could not tell a reported zero from no data and showed "Reasoning 0" for providers that never report it (desktop #3729 review).
- `packages/ai/src/api/google-vertex.ts`: `Usage.reasoning` is documented as "left undefined by providers that don't" expose a breakdown, but these adapters zero-filled it, so a client could not tell a reported zero from no data and showed "Reasoning 0" for providers that never report it (desktop #3729 review).

### Why an extension could not handle it

- `packages/ai/src/api/openai-completions.ts`: usage parsing happens inside the adapter's stream before any extension sees the message.
- `packages/ai/src/api/openai-responses-shared.ts`: usage parsing happens inside the adapter's stream before any extension sees the message.
- `packages/ai/src/api/google-generative-ai.ts`: usage parsing happens inside the adapter's stream before any extension sees the message.
- `packages/ai/src/api/google-vertex.ts`: usage parsing happens inside the adapter's stream before any extension sees the message.

### Expected merge conflict zones

- LOW: `packages/ai/src/api/openai-completions.ts`, the `reasoning` line of the usage object.
- LOW: `packages/ai/src/api/openai-responses-shared.ts`, the `reasoning` line of the usage object.
- LOW: `packages/ai/src/api/google-generative-ai.ts`, the `reasoning` line of the usage object.
- LOW: `packages/ai/src/api/google-vertex.ts`, the `reasoning` line of the usage object.

## 2026-10-22 - Replace Biome with oxlint and oxfmt (senpi#3976)

### What changed

- `packages/ai/src/api/google-shared.ts`: the empty `providerNative` branch gains a comment saying those blocks are not replayed to Google (oxlint `no-lone-blocks`).
- `packages/ai/src/api/openai-completions.ts`: an `oxlint-disable-next-line eslint/no-unassigned-vars` comment on `streamedReasoningDetails`, citing senpi#3934, which tracks the lost serialize-once.

### Why

- The repository moved lint and format from Biome to oxlint 1.89.0 and oxfmt 0.74.0 (senpi#3976). oxlint reports this site where Biome did not; the change keeps behaviour identical.

### Why an extension could not handle it

- Lint configuration and source comments are read by the linter before any agent code runs.

### Expected merge conflict zones

- The `providerNative` branch of the Google message conversion and the reasoning-details declaration in `openai-completions.ts`. senpi#3934 removes the disable comment when it restores the assignment.

## 2026-10-21 - Responses cache affinity follows the stable prefix (omo#10775)

### What changed

- `packages/ai/src/api/openai-prompt-cache.ts`: derives a bounded, versioned key from model id, leading instructions, and the sorted tool schema set, excluding session ids and conversation messages.
- `packages/ai/src/api/openai-responses.ts`, `packages/ai/src/api/openai-codex-responses.ts`, and `packages/ai/src/api/azure-openai-responses.ts`: use that derivation whenever caching is enabled, including native GPT-5.6+ requests and prewarm. Subscription transport headers and WebSocket ownership remain session-scoped.
- `packages/ai/src/api/openai-responses-shared.ts`: emits Responses tools in name order without mutating the caller's array.

### Why

- `packages/ai/src/api/openai-prompt-cache.ts`: session UUID keys prevent new sessions and task children with identical prefixes from sharing cache affinity.
- `packages/ai/src/api/openai-responses.ts`, `packages/ai/src/api/openai-codex-responses.ts`, and `packages/ai/src/api/azure-openai-responses.ts`: all Responses transports need the same prefix-derived body key so API-key, subscription, Azure, prewarm, and compaction calls agree.
- `packages/ai/src/api/openai-responses-shared.ts`: stable tool ordering is required for identical provider-prefix bytes.

### Why an extension could not handle it

- `packages/ai/src/api/openai-prompt-cache.ts`: the derivation is shared provider behavior, not a session extension concern.
- `packages/ai/src/api/openai-responses.ts`, `packages/ai/src/api/openai-codex-responses.ts`, and `packages/ai/src/api/azure-openai-responses.ts`: these adapters construct cache fields before extension payload hooks and are shared by every session.
- `packages/ai/src/api/openai-responses-shared.ts`: the adapter serializes tool schemas after extension tool registration, so an extension cannot enforce transport-wide ordering.

### Expected merge conflict zones

- `packages/ai/src/api/openai-prompt-cache.ts`: shared derivation and clamp.
- `packages/ai/src/api/openai-responses.ts`, `packages/ai/src/api/openai-codex-responses.ts`, and `packages/ai/src/api/azure-openai-responses.ts`: imports and request builders.
- `packages/ai/src/api/openai-responses-shared.ts`: `convertResponsesTools`.

## 2026-10-20 - chatgpt-subscription failures carry a classified providerDiagnostic (senpi#3771)

### What changed

- `packages/ai/src/api/openai-codex-responses.ts`: the HTTP refusal, the in-stream `error` event and the `response.failed` event attach a diagnostic from `codexHttpProviderDiagnostic` / `codexEventProviderDiagnostic` to the error they throw, and the outer `catch` copies `readProviderDiagnostic(error) ?? transportProviderDiagnosticFromError(error)` onto `output.providerDiagnostic` for `stopReason: "error"`. `response.failed` uses `describeChatGptUsageLimitEvent` on its nested `response.error` like the `error` branch does.
- `packages/ai/src/api/openai-codex-responses/provider-diagnostic.ts` (fork-only): reads `error.code`/`error.type`, the inline or HTTP status, and `resets_at`/`resets_in_seconds`. A recognized code classifies (`usage_limit_reached`, `usage_not_included` -> `quota`; `rate_limit_exceeded` -> `rate_limit`) with `resetsAt`; otherwise a classifying status, then a safe lowercase error type (or the event type) as the code of an `unknown` diagnostic.

### Why

The adapter never minted a diagnostic, so every ChatGPT-subscription failure, a usage limit included, read "could not be classified (chatgpt-subscription, no code)".

### Why an extension could not handle it

The diagnostic rides the provider's thrown error inside the adapter, before any extension sees the failure.

### Expected merge conflict zones

- LOW: the HTTP `throw` in the retry loop, the outer `catch` of `stream()`, and the `error` / `response.failed` branches of `mapCodexEvents` in `openai-codex-responses.ts`.

## 2026-10-19 - ChatGPT subscription Fast and Ultrafast costs use the included-usage rates (oh-my-openagent#10540)

### What changed

- `packages/ai/src/api/openai-codex-responses.ts`: `getServiceTierCostMultiplier` returns 2.5 for `priority`/`fast` on every model (was 2, or 2.5 for `gpt-5.5` only) and 8 for GPT-6 Astra / GPT-6.1 Sol `ultrafast` (was 6). The `openai-responses.ts` adapter keeps the API rates (2x, 6x).

### Why

- This adapter serves only the ChatGPT subscription lane, which spends the plan's included usage. [OpenAI's Codex pricing page](https://developers.openai.com/codex/pricing) meters Fast at 2.5x Standard and Ultrafast at 8x against included usage; 2x and 6x are the purchased-credit and API rates. A Geeky · Normal run on `gpt-6.1-sol-fast` used about 60% of a weekly limit while the shown cost tracked the lower rate.

### Why an extension could not handle it

- The multiplier is applied inside the adapter after the terminal usage event; an extension never sees the pre-multiplier cost.

### Expected merge conflict zones

- LOW: `getServiceTierCostMultiplier` in `openai-codex-responses.ts`.

## 2026-10-18 - Anthropic request bodies are gzip-compressed where the endpoint accepts it (senpi#3643)

### What changed

- `packages/ai/src/api/anthropic-messages.ts`: `createClient` receives `withGzipRequestBodies(options.fetch)` when `getAnthropicCompat(model).supportsGzipRequestBody` is true, so the SDK's fetch sends 4096+ character bodies with `Content-Encoding: gzip`.
- `packages/ai/src/api/warm-prompt-cache.ts`: the Anthropic prewarm client wraps its fetch the same way.

### Why

- Claude Code 2.1.302 gzips first-party request bodies; long sessions re-upload 0.5-8 MB of JSON per turn, which gzip shrinks 2.2x at the median (measured in senpi#3643).

### Why an extension could not handle it

- The SDK client and its fetch are built inside the adapter; an extension can supply `options.fetch` per call but cannot apply a per-model compat default to every request and to the prewarm.

### Expected merge conflict zones

- LOW: `packages/ai/src/api/anthropic-messages.ts` import block and the `createClient(...)` call in `openClient`; `packages/ai/src/api/warm-prompt-cache.ts` import block and the `new Anthropic({ fetch })` line.

## 2026-10-14 - Shared Vertex ADC resolution for Model Garden open models

### What changed

- `packages/ai/src/api/google-vertex.ts`: `buildGoogleAuthOptions` and the GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT lookup move to the new fork-only, browser-safe `google-vertex-env.ts` and are imported back, unchanged in behavior.
- `packages/ai/src/api/google-vertex-adc.ts` (fork-only): `getVertexAdcAccess` returns an ADC access token, target project and quota project through google-auth-library, the same credential chain `@google/genai` uses; it is Node-only and reached solely through its lazy boundary `google-vertex-adc.lazy.ts`, so browser bundles that include `google-vertex.ts` never pull google-auth-library.

### Why

- `packages/ai/src/api/google-vertex.ts`: sharing its credential and project environment helpers lets the `vertex-model-garden` builtin call Vertex Model Garden open models through the OpenAI-compatible endpoint with a bearer token, without a second credential path.

### Why an extension could not handle it

- `packages/ai/src/api/google-vertex.ts`: the extension owns registration and transport, but the credential and project environment helpers it must reuse were private to this adapter; sharing them requires moving them to an importable module.

### Expected merge conflict zones

- LOW: `packages/ai/src/api/google-vertex.ts`, the import block and the two helper bodies (`buildGoogleAuthOptions`, `resolveProject`).

## 2026-10-21 - Advertised [CC] floor 2.1.306 (senpi#3854)

### What changed

- `packages/ai/src/api/anthropic-messages.ts`: `claudeCodeVersion` moves 2.1.296 -> 2.1.306 to match the @anthropic-ai/claude-agent-sdk 0.3.306 bump in `packages/coding-agent/package.json` (and its regenerated `install-lock`).

### Why

- The Releasability gate's SDK currency check failed on main once 0.3.305/0.3.306 were published; the floor must track the pinned SDK's shipped [CC] version (senpi#2033).

### Why an extension could not handle it

- The advertised [CC] identity is a build-time constant; it is not runtime extension surface.

### Expected merge conflict zones

- The single `claudeCodeVersion` declaration line.


## 2026-10-13 - Advertised [CC] floor 2.1.296 (senpi#3258)

### What changed

- `packages/ai/src/api/anthropic-messages.ts`: `claudeCodeVersion` (the bundled [CC] version and the floor of the advertised `claude-cli/<version>`) moves 2.1.292 -> 2.1.296 to match the @anthropic-ai/claude-agent-sdk 0.3.296 bump in `packages/coding-agent/package.json`.

### Why

- The floor must track the pinned claude-agent-sdk's shipped [CC] version; the currency regression (senpi#2033) floors the advertised version at the SDK's and fails when they drift.

### Why an extension could not handle it

- The advertised [CC] identity is a build-time constant a downstream installer rewrites byte-for-byte; it is not runtime extension surface.

### Expected merge conflict zones

- The single `claudeCodeVersion` declaration line.


## 2026-10-12 - Recover from expired native web search payloads (senpi#3201)

### What changed

- `packages/ai/src/api/anthropic-web-search-expiry.ts`: new fork-only helpers. `isExpiredWebSearchContentError` matches `400 ... Invalid \`encrypted_content\` in \`search_result\` block`; `expiredWebSearchReplayIds` returns the `tool_use_id`s of the web search results replayed at or before the rejected `messages.N` index (every result when the index is missing); `demoteExpiredWebSearchReplay` rewrites those pairs to text (`Searched the web for: <query>` plus a list of result titles and URLs).
- `packages/ai/src/api/anthropic-messages.ts`: when a request fails with that 400, `stream` marks the newly expired search ids, retries with them demoted, and repeats while the error names a not-yet-demoted search. The ids are remembered per (session, base URL, model) in `expiredWebSearchReplays`, cleared by the same session-resource cleanup as the other replay fallbacks. Search results that were never rejected keep replaying byte-for-byte (#208).
- `packages/ai/test/anthropic-web-search-expiry.test.ts`: a local endpoint that rejects the stale payload proves the retry, that the newer search pair keeps its `encrypted_content`, the session memory, and that an unrelated 400 is not retried.

### Why

- Live 2026-10-12 (claude-opus-5-5 through a multi-account Anthropic gateway): a web search at 08:10:42Z replayed fine until 08:15:37Z, then every same-model request failed with `messages.37.content.0: Invalid \`encrypted_content\` in \`search_result\` block`. The payload is only valid for the account that produced it; when the gateway's candidate pool no longer contained that account, every remaining account rejected it (five 400s on one request). History only grows, so the session failed on that model until a cross-model fallback dropped the blocks, then failed again after the fallback reverted. The gateway now degrades such replays itself, but any account change (credential rotation, another gateway, a re-login) hits the same rejection in the client. Stripping only `encrypted_content` (#150) is rejected because the field is required.

### Why an extension could not handle it

- The rejection is decided by the wire payload the provider assembles from history; an extension's `before_provider_request` hook cannot see the HTTP error to retry, and demoting every search up front would discard valid page contents.

### Expected merge conflict zones

- LOW: one more `Set` beside `toolReferenceReplayFallbacks` and its cleanup loop, one demotion call in `createRequest`, and one retry branch in the fork-only retry block; `anthropic-web-search-expiry.ts` is fork-only.

## 2026-10-12 - Remove the /llama llama.cpp integration (senpi#3202)

### What changed

- `packages/ai/src/api/llama-cpp-classify.ts`: deleted. This classifier API existed only to back the removed `/llama` extension; it had no consumers outside it.
- `packages/ai/src/api/llama-cpp-classify.lazy.ts`: deleted alongside its eager twin.

### Why

- `packages/ai/src/api/llama-cpp-classify.ts`: Q ordered removal of the `/llama` feature; this backend had no other consumers.
- `packages/ai/src/api/llama-cpp-classify.lazy.ts`: the lazy entry point exists only for that deleted backend.

### Why an extension could not handle it

- `packages/ai/src/api/llama-cpp-classify.ts`: an extension cannot remove a shipped API implementation.
- `packages/ai/src/api/llama-cpp-classify.lazy.ts`: an extension cannot remove its shipped lazy entry point.

### Expected merge conflict zones

- `packages/ai/src/api/llama-cpp-classify.ts`: deleted; upstream edits will conflict.
- `packages/ai/src/api/llama-cpp-classify.lazy.ts`: deleted alongside.

## 2026-10-11 - Replay opted-in GLM server-result pairs (senpi#3125 delta)

### What changed

- `packages/ai/src/api/anthropic-messages.ts`: native replay predicates moved to `anthropic-native-replay-blocks.ts`. An opted-in same-model GLM native `tool_result` is paired with its preceding `server_tool_use` and replays unchanged; disabled routes strip the search pair.

### Why

- The live z.ai Anthropic coding-plan response returns `tool_result`, not `web_search_tool_result`, even with a zero search usage counter. The old allowlist dropped its result and the now-unpaired use on the next request.

### Why an extension could not handle it

- The provider adapter owns native response capture and final transcript replay.

### Expected merge conflict zones

- Native replay predicates and pairing classification.

## 2026-10-11 - Server search wire type and replay (senpi#3122)

### What changed

- `packages/ai/src/api/openai-responses.ts`: treats current `web_search` and legacy preview declarations as native search under the exact endpoint's capability gate. Resolves the optional `webSearchToolType` declaration without adding capability by URL inference.
- `packages/ai/src/api/openai-responses-shared.ts`: replays completed/failed `web_search_call` items only on the same originating provider/API/model, preserving native result state while preventing cross-provider leakage.
- Related focused Responses compatibility, same-route replay and foreign-route tests passed; a real ChatGPT subscription search and output-item replay returned HTTP 200.

### Why

The active model should search in-turn, with valid replay on its next request.

### Why an extension could not handle it

The API adapters own final wire filtering and conversion of stored native blocks.

### Expected merge conflict zones

The native tool-type predicate, compatibility defaults, and provider-native input conversion branch.

## 2026-10-10 - allowed_tools only on the native OpenAI endpoint, with a refusal fallback (senpi#3080)

### What changed

- `packages/ai/src/api/openai-responses.ts`: `getCompat` resolves `supportsAllowedTools` through `supportsAllowedToolChoice`, which now also requires a native OpenAI API host (`api.openai.com` or a regional `*.api.openai.com`). A flagged model behind a Responses-compatible gateway is never sent `allowed_tools`; the session and the agent loop use the same predicate and send only the active tools there.
- `packages/ai/src/api/openai-responses.ts`: `applyAllowedToolsChoice` and its helpers moved to the fork-only `openai-responses-allowed-tools.ts`. A request carrying `tool_choice: allowed_tools` that is refused with an HTTP 400, or by a WebSocket error event before any content, is sent once more over HTTP with top-level function and custom tools restricted to the allowed ones and no `tool_choice`. The model (api, provider, baseUrl, id) is then remembered for the process, so later requests go straight to the restricted shape. A retry that fails too records nothing, and outer provider retries resend the restricted request. Tools that transcript items load in place are not filtered.

### Why

An `openai/gpt-6.1-sol` session whose `openai` provider pointed at a Responses-compatible gateway failed every turn with `Invalid value: 'allowed_tools'` (param `tool_choice.type`) until its goal hit the continuation cap. A provider `baseUrl` override keeps the catalog compat, which flags every cache-write-priced `openai` row `supportsAllowedTools`, and nothing recovered when an endpoint rejected the choice.

### Why an extension could not handle it

`tool_choice` is built after `onPayload` returns, and the retry depends on the provider's response, so a `before_provider_request` hook can neither see nor recover the refused request.

### Expected merge conflict zones

- The request send block in `stream` (the WebSocket catch, `createRequest` and the `start` push), and the import list.

## 2026-10-09 - Gemini 3+ replays unsigned tool-call steps as text (Vertex 400 fix)

### What changed

- `packages/ai/src/api/google-shared.ts`: `convertMessages` gains `requiresThoughtSignatureReplay` (Gemini major version >= 3). When an assistant step in the current turn (after the last user message carrying content) lacks a valid thought signature on its first tool call, the step is replayed as text rather than unsigned `functionCall` parts: each call becomes `[Tool Call: <name> (id: <id>)]` and its paired result `[Tool Result: <name> (id: <id>)]` (`textToolCallIds` preserves pairing). Earlier turns retain structured function calls. If tool results contain images and the model supports them, `inlineData` parts are appended in the same user turn; if images exist but the model does not support them, `transform-messages.ts` has already replaced them with placeholder text before this converter runs, so the unreachable non-vision placeholder branch was dropped. The current-turn boundary is the last user message that carries content, so a user turn holding only an image (a pasted screenshot) also ends the current turn; empty user messages are not boundaries.

### Why

Gemini 3+ strictly validates replayed tool calls: the first `functionCall` part of every step in the current turn must carry the thought signature the model returned, or Vertex/AI Studio answer 400 "Function call is missing a thought_signature in functionCall parts" (enforced even at MINIMAL thinking; https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thought-signatures). A session that switches to a Gemini 3 model mid-thread replays tool-call steps recorded by other models, which carry no signature, causing every subsequent Gemini turn to fail with this 400 (reproduced from cross-provider history replayed after a mid-session model switch). The documented `skip_thought_signature_validator` escape hatch is rejected by Vertex, which is why upstream removed it (pi-mono #4032); text replay is the remaining documented-safe shape ("either include the full context or omit it entirely"). Earlier turns do not require thought signatures and remain structured.

### Why an extension could not handle it

The signature replay decision lives in the provider adapter's message conversion, which runs after every extension hook; extensions only see the already-built request.

### Expected merge conflict zones

- LOW: the `block.type === "toolCall"` branch and the new `textToolCallIds` set in `convertMessages`, plus the top of the `msg.role === "toolResult"` branch, in `packages/ai/src/api/google-shared.ts`.

## 2026-10-09 - Restore api-tracker coverage for upstream-modified paths (senpi#3006)

### What changed

- `packages/ai/src/api/azure-openai-responses.ts`: [OI]-family adapter divergence (option normalization, extraBody and reasoning ladders) carried through the v0.99.1 sync.
- `packages/ai/src/api/cloudflare.ts`: Cloudflare base-URL routing on the v0.99.1 core.
- `packages/ai/src/api/constrained-sampling.ts`: `constrainedSampling: false` honored as an explicit opt-out, distinct from absent, in the strict-JSON and grammar resolvers.
- `packages/ai/src/api/github-copilot-headers.ts`: Copilot refusal explanation and one re-exchange of a token GitHub refuses (senpi#2297).
- `packages/ai/src/api/google-generative-ai.ts`, `packages/ai/src/api/google-shared.ts`, `packages/ai/src/api/google-vertex.ts`: Google adapter re-divergence (FinishReason exhaustiveness, same-role message folding) carried through the v0.99.1 sync.
- `packages/ai/src/api/openai-completions.ts`: forced tool_choice fallback, in-band refusal retry, reasoning_details replay, endpoint-advertised reasoning efforts, and gateway prompt-cache parsing.
- `packages/ai/src/api/openai-prompt-cache.ts`: [OI] adds `applyChatGptSubscriptionCacheAffinityHeaders`, which sets the session-id, thread-id and x-client-request-id headers from the session id for prompt-cache affinity.
- `packages/ai/src/api/openai-responses-shared.ts`: Astra Ultrafast tier, prefix prewarm with prompt_cache_diagnostics, nested WebSocket error surfacing, and the completion-phase watchdog.
- `packages/ai/src/api/openai-responses.lazy.ts`: lazy Responses loader prewarmed with the GPT-5.6+ prefix (senpi#2096).
- `packages/ai/src/api/openrouter-images.ts`: OpenRouter images on the v6 model surface.
- `packages/ai/src/api/pi-messages.ts`: model-only text audience without changing provider payloads.
- `packages/ai/src/api/simple-options.ts`: context-exhausted refusal, not a shrink to one token.
- `packages/ai/src/api/transform-messages.ts`: cross-provider message transform contract preserving redacted thinking on same-model transforms.

These files were covered by the parent tracker until senpi#2895 added this nearer tracker without listing them, hiding them from the audit's exact-nearest-tracker rule.

### Why

The repository audit requires every upstream-modified production path to be named by an entry in its exact nearest changes.md tracker. senpi#2895 introduced this tracker and named only the files it touched, so the 15 pre-existing upstream-modified files beneath it lost the coverage the parent tracker had provided and were reported uncovered.

### Why an extension could not handle it

changes.md coverage is fork-owned documentation metadata; no extension or runtime hook can supply it.

### Expected merge conflict zones

- The context-room clamp in `packages/ai/src/api/simple-options.ts` (max-token clamping moved to `context-room.ts` and re-exported), against upstream changes to the token-budget options; and the cache-affinity header helper in `packages/ai/src/api/openai-prompt-cache.ts`, against upstream changes to the prompt-cache header set.
- The forced-`tool_choice` fallback and `reasoning_details` replay logic in `packages/ai/src/api/openai-completions.ts`, against upstream Completions changes.
- The Responses shared helpers (tool placement, prefix prewarm, completion-phase watchdog) in `packages/ai/src/api/openai-responses-shared.ts`, against upstream Responses changes.
- The Google conversion/thinking-level logic in `packages/ai/src/api/google-shared.ts`, `packages/ai/src/api/google-generative-ai.ts`, and `packages/ai/src/api/google-vertex.ts`, against upstream Google adapter changes.
- The cross-provider message coercion in `packages/ai/src/api/transform-messages.ts`, against upstream message-shape changes.

## 2026-10-08 - Sol Ultrafast uses published sixfold pricing (senpi#2975)

### What changed

- `packages/ai/src/api/openai-responses.ts` and `packages/ai/src/api/openai-codex-responses.ts`: Ultrafast estimated costs apply the published 6x Standard multiplier to GPT-6.1 Sol as well as GPT-6 Astra. The pricing lookup uses `upstreamModelId ?? id`, covering pinned aliases while leaving the wire request unchanged.

### Why

- [OpenAI's pricing page](https://developers.openai.com/api/docs/pricing) now lists Sol Ultrafast at $12/$0.60/$15/$60 per million input/cached-input/cache-write/output tokens, and $24/$1.20/$30/$90 for long context. Both tables are 6x Standard. Matching only the catalog id undercounted the native alias by sixfold.

### Why an extension could not handle it

- Both adapters calculate streamed usage costs internally after response processing.

### Expected merge conflict zones

- LOW: `getServiceTierCostMultiplier` and `applyServiceTierPricing` in both adapters.

## 2026-10-08 - A configured anthropic-beta header is merged with the betas the request body needs (senpi#2957)

### What changed

- `packages/ai/src/api/anthropic-messages.ts` `getBetaFeatures`: a configured `anthropic-beta` header (model `headers` or per-request `options.headers`) used to replace the whole computed beta list. It now owns only the optional betas, and the betas the request body depends on are appended to it, de-duplicated, configured order first. Those betas come from the request shape `buildParams` decided (`BetaDependentShape`):
  - OAuth identity;
  - mid-conversation effort markers, plus thinking binding when thinking is on;
  - native tool changes;
  - `fallbacks` in the body (`server-side-fallback-2026-07-01`, which a configured header also dropped before).

  Interleaved thinking is stripped from a configured list on adaptive models, as it already was from the client headers.
- `buildParams`: `anthropic-beta: null` makes the request take a shape that needs no beta:
  - the current tool list instead of native tool changes;
  - top-level effort instead of per-message effort markers and `block_binding`;
  - no `fallbacks`.

  The client-level fallback beta follows the same rule. Only an OAuth token, whose credential depends on its identity betas, still fails, before sending, with an error that names them.

### Why

A proxy route that sets its own `anthropic-beta` header dropped `mid-conversation-output-config-2026-07-01` while senpi still sent the mid-conversation effort message. Claude Haiku, Opus and Sonnet 5.5 then failed the first request with `400 messages.1.output_config: Extra inputs are not permitted`. A `null` header must keep working: a request it would otherwise invalidate switches shape instead of failing.

### Why an extension could not handle it

The beta list and the request shape are assembled inside the provider's request builder, after every extension hook has run.

### Expected merge conflict zones

- `getBetaFeatures` (with `configuredBetaHeader`, `defaultOptionalBetas`) and the `nativeToolChanges` / effort / `fallbacks` decisions in `buildParams`.

## 2026-10-08 - Claude Haiku 5.5 joins the adaptive-only families (senpi#2892)

### What changed

- `packages/ai/src/api/anthropic-messages.ts`: `ADAPTIVE_THINKING_MODEL_MARKERS` and `NATIVE_XHIGH_EFFORT_MODEL_MARKERS` gain `haiku-5-5`, and `DISABLED_THINKING_REJECTING_MODEL_MARKERS` gains `haiku-5-5` / `haiku-5.5`, so a Haiku 5.5 row without generated compat (a `models.json` entry, a gateway row) sends adaptive thinking with an effort instead of `budget_tokens` and pins effort `low` for a thinking-off turn instead of `thinking.type: "disabled"`.
- `packages/ai/src/api/anthropic-messages.ts`: the `DISABLED_THINKING_REJECTING_MODEL_MARKERS` comment says which entries the live 400 verified (Fable 5, Opus 5.5, Sonnet 5.5), and that Haiku 5.5 is listed by choice: its docs accept `disabled` at effort `high` or below, and a real thinking-off is senpi#2927.
- `packages/ai/src/api/anthropic-messages.ts`: the managed-effort branch comment no longer claims these families accept `thinking.type: "disabled"`; it names `disableThinkingForRequest` as the thinking-off path.
- `packages/ai/src/api/bedrock-converse-stream.ts`: `supportsAdaptiveThinking`, `supportsNativeXhighEffort` and `rejectsDisabledThinking` match `haiku-5-5` (and the dotted spelling for the last), for the same reason on Bedrock Converse.

### Why

Claude Haiku 5.5 rejects `thinking: {type: "enabled", budget_tokens}` (400) and documents only an unset or adaptive `thinking` with `output_config.effort` low..max. It accepts forced `tool_choice`, so `FORCED_TOOL_CHOICE_REJECTING_MODEL_ID` in `utils/prompt-cache-ttl.ts` deliberately stays unchanged.

### Why an extension could not handle it

The family marker lists are private to the API adapters.

### Expected merge conflict zones

- The three marker arrays in `anthropic-messages.ts`; the three family predicates in `bedrock-converse-stream.ts`.

## 2026-10-08 - Per-message Anthropic effort reaches the wire (senpi#2912)

### What changed

- `packages/ai/src/api/anthropic-tool-references.ts`: `demoteUnavailableToolReferences` drops a message only when the demotion itself emptied it. A message that arrived with `content: []` (the per-message effort marker) passes through untouched. Side effect: a non-marker empty message (one an `onPayload` hook adds; `convertMessages` never produces one) now also reaches the API instead of being dropped silently.
- `packages/ai/src/api/anthropic-tool-references.ts`: the all-references-gone decision for a native search pair is collected over the whole request instead of per message. A pair can span two assistant messages (a deferred server tool resumes in the continuation), and the `server_tool_use` left alone in the earlier message was kept while its result was demoted to text, an unpaired use. Now it is dropped too, and the message it emptied is removed. That is the only rewrite that empties a message.
- `packages/ai/src/api/anthropic-messages.ts`: `managedEffortForRequest` decides the effort of a per-message-effort request once, for both the active marker (`buildParams`) and the recorded `providerThinkingLevel` (`stream`). That is the caller's effort with thinking on, `low` for a thinking-off turn on a family that cannot disable thinking, and none when thinking is disabled. `disableThinkingForRequest` removes every effort marker when it emits `thinking: { type: "disabled" }` (the same rule as senpi#1399).

### Why

The demotion pass (5ecb30463) dropped every message whose rebuilt content was empty. Per-message effort markers (4e69b0c28) are deliberately content-less, so every marker was deleted after `onPayload`, and every catalog row with per-message effort (Opus 5 / 5.5, Sonnet 5.5, Fable 5.1) always ran at the top-level effort `high`. Once the markers reach the wire, a thinking-off turn must not carry a contradicting marker: the active marker said `high` beside the pinned top-level `low`, and historical markers beside `thinking.type: "disabled"` are a 400.

### Why an extension could not handle it

Both passes run inside the provider's request pipeline after every extension hook (`onPayload`).

### Expected merge conflict zones

- `demoteUnavailableToolReferences`'s empty-message check in `anthropic-tool-references.ts`.
- `disableThinkingForRequest`, the `providerThinkingLevel` line in `stream` and the `activeEffort` line in `buildParams` in `anthropic-messages.ts`.

## 2026-10-07 - Lazy request setup preserves OAuth retry diagnostics (senpi#2893)

### What changed

- `packages/ai/src/api/lazy.ts`: attach the fixed OAuth-unavailable diagnostic with provider-only details when asynchronous authentication setup fails transiently.

### Why

The lazy stream converted the branded auth error into plain text, causing an immediate fallback instead of same-model recovery.

### Why an extension could not handle it

The lazy setup converter owns the assistant message before session retry hooks see it.

### Expected merge conflict zones

- `createSetupErrorMessage` in `lazy.ts`.

## 2026-10-08 - Mistral sends consecutive user turns as one user message (senpi#2920)

### What changed

- `packages/ai/src/api/mistral-conversations.ts`: `toChatMessages` appends every user turn through `appendUserMessage`, which merges it into the previous message when that message is also a user message (string content becomes a text chunk), as the OpenAI Chat converter does for non-OpenAI endpoints.

### Why

The coding agent now sends a blocking ask-user answer's own words as a user message right after the tool results, so a following steer or prompt produced two user messages in a row; Mistral's role-order rules are not documented to accept that.

### Why an extension could not handle it

The Mistral message mapping runs inside the provider adapter after every extension hook.

### Expected merge conflict zones

- LOW: the `msg.role === "user"` branch of `toChatMessages` and the new `appendUserMessage` helper above it in `mistral-conversations.ts`.

## 2026-10-13 - Generation-4 ids use discrete thinking levels (senpi#3292)

### What changed

- `packages/ai/src/api/google-shared.ts`: `usesGoogleThinkingLevel` also matches generation-4 and later ids through `isGoogleGeneration4OrLaterModelId` (`packages/ai/src/google-thinking-generation.ts`, anchored to a complete id or a `models/` namespace), so both adapters (`google-generative-ai`, `google-vertex`) send `thinkingLevel` and, when thinking is off, clamp to the lowest supported level instead of sending `thinkingBudget`.

### Why

The provider documents that its generation-4 models support only `LOW`, `MEDIUM` and `HIGH`, and reject a thinking budget (or `MINIMAL`) with HTTP 400. Under the generation-3-only match, every request to those models failed.

### Why an extension could not handle it

The thinking wire form is chosen inside the shared Google request builder, below any extension hook.

### Expected merge conflict zones

The id matchers in `usesGoogleThinkingLevel`.

## 2026-10-16 - One mid-stream WebSocket drop no longer moves a chatgpt-subscription session to SSE (senpi#3442)

### What changed

- `packages/ai/src/api/openai-codex-responses.ts`: the WebSocket catch block passes the failure phase (`before_message_stream_start` or `after_message_stream_start`) to `recordWebSocketFailure`, and a completed WebSocket response calls `recordWebSocketSuccess`.
- `packages/ai/src/api/openai-codex-responses/fallback-state.ts`: `recordWebSocketFailure` takes that phase. A failure before output still arms the 60 s SSE cooldown at once. A failure after output starts arms it only on the second one in a row (`CODEX_WEBSOCKET_MID_STREAM_FAILURES_BEFORE_FALLBACK`); `recordWebSocketSuccess` and `clearWebSocketFallbackState` reset the run.

### Why

Every mid-stream close (1006 reset, 1011, 1001, even 1000) armed the cooldown, so the agent's retry of that turn and every request in the next minute went over SSE. Upstream Codex retries a dropped stream on a fresh WebSocket and switches to HTTPS only after `stream_max_retries` (`codex-rs/core/src/responses_retry.rs`). A before-output failure keeps the cooldown because that same request is served over SSE with no visible error.

### Why an extension could not handle it

Transport selection and the fallback cooldown live inside the provider adapter, below every extension hook.

### Expected merge conflict zones

- MEDIUM: the WebSocket `catch` block in `stream()` of `openai-codex-responses.ts` (upstream calls a two-argument `recordWebSocketFailure` that adds the session to a permanent fallback set).
- LOW: `fallback-state.ts` has no upstream counterpart.

## 2026-10-18 - ChatGPT usage-limit refusals name the limit and the next step (senpi#3615)

### What changed

- `packages/ai/src/api/openai-codex-responses.ts`: `parseErrorResponse` takes the response headers and delegates the usage-limit wording to `describeChatGptUsageLimitResponse`; the in-stream `error` event branch uses `describeChatGptUsageLimitEvent` for a `usage_limit_reached`/`usage_not_included` event before falling back to the `Codex error:` text.
- `packages/ai/src/api/chatgpt-usage-limit.ts` (fork-only): reads `x-codex-rate-limit-reached-type` and `x-codex-credits-has-credits` next to the body's `plan_type` and `resets_at`, and states the workspace-credits, spend-cap, has-credits or plan case plus the ways to keep going. Codex's free-form `x-codex-promo-message` is left out: a model name in it would make the fallback layer scope the limit to one model. Its closing sentence starts with `ACCOUNT_LIMIT_NEXT_STEP_LEAD` from `utils/provider-failure-description.ts`, whose account-limit projection keeps any message carrying that lead as written (retry marker stripped) instead of replacing it with the generic switch-provider sentence (seen in CLI QA: the projection hid the new text). The dependency runs api -> utils so the `./utils/*` and `./models` entry graphs stay within budget.

### Why

Every refusal read "You have hit your ChatGPT usage limit (<plan> plan)." whether the account had credits ChatGPT did not apply, the workspace ran out of credits, or a spend cap was hit, and it never said what to do. Codex CLI reads the same headers (`codex-rs/protocol/src/error.rs`). It sends no credit opt-in flag, so the wording is the part we can match.

### Why an extension could not handle it

The error text is built inside the provider adapter from the raw response before any extension sees the failure, and the headers are gone by then.

### Expected merge conflict zones

- LOW: `parseErrorResponse` in `openai-codex-responses.ts` (signature gains `headers`) and the `type === "error"` branch of `mapCodexEvents`.

## 2026-10-19 - Debug-flagged request skeleton log for every Anthropic request (senpi#3727)

### What changed

- `packages/ai/src/api/anthropic-request-shape-log.ts` (new): when `SENPI_DEBUG_REQUEST_SHAPE` names a file, each request appends one JSON line with the time, provider, model and, per message index, the role plus each block's type and `id` / `tool_use_id`. No text, input, thinking or result content is written; the file is created with mode 0600.
- `packages/ai/src/api/anthropic-messages.ts`: `createRequest`'s `send` logs the exact params of every attempt (after every sanitizer) before calling the client, because the SDK throws on a non-2xx and the rejected attempt is the one to rebuild. Main turns, side requests (compaction, titles, summaries) and the forced-tool-choice / unsigned-thinking / expired-search retries are all covered.

### Why

A 400 named `messages.1` while the reconstructed main-turn payload had the pair at `messages.8`; without the sent shape the failing request cannot be rebuilt.

### Why an extension could not handle it

`before_provider_request` runs before the provider's own sanitizers rewrite the payload, so an extension would log a different shape than the one sent, and side requests bypass it.

### Expected merge conflict zones

- `anthropic-messages.ts`: the import block and the end of `createRequest`.
