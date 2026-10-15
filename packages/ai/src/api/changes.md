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

Q's 2026-10-12 order removes the `/llama` llama.cpp feature from senpi and the desktop app entirely. The classify backend is part of that feature, not a shared capability.

### Why an extension could not handle it

The feature is built into the provider-neutral `ai` package's API surface; removing it requires deleting the wire implementation, which an extension cannot do from outside.

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
