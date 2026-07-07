# Native tool-search preservation spike (todo 29)

Answers SPEC §14 open question #1 empirically, with zero real-API spend: **do
provider-native tool-search response blocks survive pi-ai's
parse → persist → re-serialise cycle byte-faithfully, so that a pure-extension
adapter (injecting request-side fields via the extension
`before_provider_request` event) is sufficient — or is a `packages/ai` (pi-ai)
seam required?**

Evidence: `packages/coding-agent/test/mcp/native-spike.test.ts` (6 assertions,
GREEN), fixtures in `test/mcp/fixtures/native-search-mocks.ts`. Raw run + git
scope check: `.omo/evidence/task-29-senpi-mcp-plugin.log`.

## STEP 0 — extension → harness → wire mapping (naming-collision warning)

The **only** payload surface `ExtensionAPI` exposes is the extension event
`before_provider_request` (`extensions/types.ts:729-734`), whose `payload` is
the raw provider request object and whose handler return value **replaces** the
payload. It is applied in `runner.ts` (~:1264) and reaches the wire through
`sdk.ts`. Do NOT confuse it with the identically-named packages/agent HARNESS
events: the harness `before_provider_request` only patches streamOptions, and
the harness `before_provider_payload` is the raw payload but is NOT
extension-exposed. All injection in todos 33/34 goes through the EXTENSION
event, exactly as the in-repo prior art does
(`builtin/anthropic-web-search/index.ts:137-139`,
`builtin/openai-web-search/index.ts:162-269`).

Prior art proves the request side already works end-to-end: anthropic-web-search
injects `{type:"web_search_..."}` into `payload.tools` via
`before_provider_request` and the model's `server_tool_use` /
`web_search_tool_result` blocks round-trip today. The spike therefore only had
to characterise the RESPONSE side.

## Anthropic Messages — verdict: **GO-pure-extension**

pi-ai preserves and replays unknown server-tool blocks with no code change:

- **Parse (no drop / no crash):** every unrecognised `content_block_start` type
  is captured as `{type:"providerNative", subtype:<type>, raw:<full block>}` —
  `packages/ai/src/api/anthropic-messages.ts:979-988`. `server_tool_use` and
  `tool_search_tool_result` land here verbatim (spike assertion **a**).
- **Persist:** the `providerNative` block (with `raw`) lives in the
  `AssistantMessage.content` that is written to session history.
- **Re-serialise (byte-faithful):** on the next request, same-model
  provider-native blocks are pushed back verbatim —
  `anthropic-messages.ts:1645-1648` gated by
  `isReplayableAnthropicProviderNativeBlock` (`:342-344`), and
  `tool_search_tool_result` is in `REPLAYABLE_ANTHROPIC_PROVIDER_NATIVE_TYPES`
  (`:325-340`, member at `:332`). Spike assertion **b** confirms the emitted
  request `messages[assistant].content` contains both blocks exactly.
- **No UI corruption:** native blocks have "no dedicated stream event variant"
  (`:987`), so the renderer only sees known text/thinking/toolcall events. Spike
  assertion **c** confirms no `error` event and only known event types.

**Consequence for todo 33:** proceed as a pure extension. Inject
`{"type":"tool_search_tool_bm25_20251119"}` + per-tool `defer_loading` and emit
`tool_reference` blocks via `before_provider_request`; the Anthropic response
path already carries everything back. No pi-ai change. `cache_control` lives on
the request tools array which the extension owns, so the HARD RULES
(≥1 non-deferred, never defer the search tool, never defer_loading+cache_control
on the same tool, ≤10k tools) are enforceable entirely in the extension.

## OpenAI Responses — verdict: **GO-with-ai-seam** (⇒ deferred; local Tier-B ships)

- **Parse (no drop / no crash):** unslotted output items (e.g.
  `tool_search_call`, `web_search_call`) are captured as `providerNative` —
  `packages/ai/src/api/openai-responses-shared.ts:487-495`. Spike assertion
  **a** confirms.
- **Re-serialise: BLOCKS ARE DROPPED.** The `providerNative` branch of
  `convertResponsesMessages` is an intentional no-op —
  `openai-responses-shared.ts:218` (`} else if (block.type === "providerNative") {}`)
  — and senpi sends `store: false` (`openai-responses.ts:370`), so nothing is
  re-sent. Spike assertion **b** confirms `tool_search_call` never re-enters the
  request. Hosted, self-contained tools (web_search resolves inside one turn)
  are unaffected, but **client-mode tool_search** — where the model emits
  `tool_search_call` and the client must reply with `tool_search_output`
  (same `call_id`) on the follow-up request — cannot be expressed: the call is
  not replayed and there is no `tool_search_output` emission path.
- **No UI corruption:** assertion **c** confirms (no `error` event).

A pure-extension OpenAI adapter is therefore **impossible** for the client-mode
protocol. The minimal fix is a `packages/ai` seam: re-serialise the
`tool_search_call` providerNative block and add a `tool_search_output` input
item in `openai-responses-shared.ts` (the `:218` branch + the assistant-output
builder), with the pi-ai provider test-matrix obligations (root AGENTS.md
:214-266) and a `packages/ai` CHANGELOG entry.

Per the plan's Must-NOT rule, an ai-seam requires explicit user sign-off and
ships as its OWN `feat(ai)` PR before todo 34. This autonomous run cannot obtain
that sign-off, so:

- **todo 34 (OpenAI native adapter) is NOT implemented in this wave.** Its
  artifact is this verdict doc (todo 36 step 8 attaches it on SKIP).
- **Local BM25 Tier-B (todos 30/31/32/35) is the shipped OpenAI path** and is
  fully provider-agnostic, so OpenAI users get adaptive tool exposure with zero
  dependency on the seam.
- When a maintainer approves the seam, todo 34 becomes a follow-up: the request
  injection (`{"type":"tool_search"}` + `defer_loading`, `web`-name 500
  workaround, #19486 compact-drop detector) mirrors todo 33 and reuses the
  fixtures already built here.

## Summary

| Provider | Parse | Persist | Re-serialise | Verdict |
| --- | --- | --- | --- | --- |
| Anthropic Messages | providerNative capture (`:979-988`) | history `raw` | verbatim replay (`:1645-1648`, REPLAYABLE `:332`) | **GO-pure-extension** → todo 33 proceeds |
| OpenAI Responses | providerNative capture (`:487-495`) | history `raw` | **dropped** (`:218` no-op, `store:false`) | **GO-with-ai-seam** → todo 34 deferred, Tier-B ships |
