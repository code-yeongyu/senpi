<!-- changes-log: packages/ai/src/api/changes.md -->
## 2026-11-02 - openai-completions keeps proxy-returned thought signatures on replayed tool calls (senpi#4564)

### What changed

- `packages/ai/src/api/openai-completions.ts`: a streamed tool-call delta's `provider_specific_fields.thought_signature` (sent by OpenAI-compatible proxies such as LiteLLM when they serve Gemini) is kept on the tool call's `thoughtSignature`. `convertMessages()` sends it back as `provider_specific_fields: { thought_signature }` on the replayed assistant tool call (function and custom calls). A `thoughtSignature` that holds a legacy encrypted reasoning detail keeps travelling through `reasoning_details` and is not sent here. Tool-call ids are still normalized for every replay, so the c44e3d1481 protection for long or foreign ids is unchanged.

### Why

- LiteLLM returns Gemini's thought signature twice: appended to the tool-call id after `__thought__`, and in `provider_specific_fields`. On the next request it reads the field first and falls back to the id. senpi dropped the field while parsing and normalized the id (character replacement plus the 40-character cut), so the turn after every tool call answered `400 Invalid value at '...thought_signature' (TYPE_BYTES)` or `400 Invalid thought signature.` (senpi#4564, reported by bluet). Sending the field back is enough for the proxy, which prefers it over the id.
- `transformMessages()` already drops `thoughtSignature` when a tool call is replayed to a different model, so a signature only reaches the model that produced it.

### Why an extension could not handle it

- Stream parsing and the request payload are built inside the provider adapter; extensions see neither the raw tool-call deltas nor the replayed `tool_calls` entries.

### Expected merge conflict zones

- LOW: the `choice.delta.tool_calls` loop in `streamOpenAICompletions` and the `assistantMsg.tool_calls` mapping in `convertMessages()`.

<!-- changes-log: packages/ai/CHANGELOG.md -->
### Fixed
- OpenAI-compatible providers that return a tool call's thought signature in `provider_specific_fields` (LiteLLM serving Gemini) no longer fail the request after every tool call: the signature is kept and sent back on the replayed tool call. Thanks to @bluet for the report ([#4564](https://github.com/code-yeongyu/senpi/issues/4564))
