This temporary research document records the implementation basis in git history. It will be deleted in the final cleanup commit.

# Provider/session recovery research

## Goal of the research

Find concrete failure modes where persisted conversation history can keep sending an invalid provider payload after an interrupted tool call, a 400 invalid-request response, compaction, or a provider/model switch. Prefer fixes in the coding-agent extension layer; only touch core loops when no extension hook can see the final request shape.

## Local senpi/pi-mono map

### Existing repair layers

1. `packages/ai/src/providers/transform-messages.ts`
   - `transformMessages()` normalizes messages immediately before provider-specific conversion.
   - It normalizes foreign tool-call IDs, drops `error`/`aborted` assistant messages, and synthesizes missing `toolResult` messages for assistant tool calls with no result.
   - It does not remove orphan `toolResult` messages that have no preceding assistant tool call.

2. `packages/ai/src/utils/tool-pair-repair.ts`
   - `repairOrphanedToolResults()` is the shared utility used by compaction.
   - It inserts synthetic results for dangling tool calls.
   - For orphan tool results, it replaces content with `TOOL_RESULT_PLACEHOLDER` but keeps the message role as `toolResult`, which still becomes provider-native tool output in provider converters.

3. `packages/coding-agent/src/core/extensions/builtin/tool-pair-guard/`
   - This is the intended extension-layer guard before provider requests leave the process.
   - `sanitize-anthropic-payload.ts` removes orphan Anthropic `tool_result` blocks from request `messages`.
   - `sanitize-openai-responses-payload.ts` removes orphan OpenAI Responses output items and inserts synthetic outputs for missing function/custom outputs.
   - `index.ts` wires both through the `before_provider_request` event.

4. `packages/coding-agent/src/core/extensions/builtin/compaction/index.ts`
   - The compaction builtin uses `repairOrphanedToolResults(convertToLlm(...))` during emergency context pruning.
   - It also detects context overflow via `overflow.isContextOverflowError()` on `message_end`.

5. `packages/coding-agent/src/core/agent-session.ts`
   - `_isRetryableError()` retries rate limits, 5xx, network, WebSocket, timeout, and overloaded errors.
   - Context overflow is excluded from generic retry and handled by compaction.
   - `_handleRetryableError()` removes the error assistant message from live agent state, keeps session history, backs off, and calls `agent.continue()`.
   - `setModel()` and `_cycleFavoriteModel()` persist model changes and emit `model_select` so extensions can adjust prompt state.

### Current gap selected for implementation

OpenAI Chat Completions-compatible providers use `packages/ai/src/providers/openai-completions.ts`. A `toolResult` message is converted to a Chat Completions `role: "tool"` message with `tool_call_id`. If the matching assistant `tool_calls` entry was lost or compacted away, the request is malformed and OpenAI-compatible APIs commonly reject it with HTTP 400 invalid request errors such as `tool_call_id not found` or `tool messages must respond to preceding tool calls`.

The extension guard already covers Anthropic and OpenAI Responses. It does not cover Chat Completions payloads, even though this is the shared API for OpenAI-compatible providers such as Groq, Cerebras, Together, OpenRouter, Fireworks-compatible paths, local OpenAI-compatible servers, and other catalog entries.

This is extension-layer visible because the final Chat Completions payload is available in `before_provider_request` as `{ messages: [...] }` after provider conversion and extension payload mutations. No agent-loop or provider-core change is required for the selected fix.

## Sibling repository comparison

### `../ai` (Vercel AI SDK)

Observed patterns:

- Prompt conversion validates tool-call/tool-result pairing and raises `MissingToolResultsError` when a tool call is sent without results before the next assistant turn.
- Tool-call parsing has a repair hook (`experimental_repairToolCall`) that can retry malformed arguments through a repair model call.
- Error hierarchy distinguishes missing tools, invalid tool input, failed repair, and missing tool results.
- API error extraction tests cover JSON, HTML, malformed JSON, empty response bodies, and status-preserving extraction.

Useful lesson: validate/repair at the model boundary instead of letting a poisoned history repeatedly reach the provider.

### `../opencode`

Observed patterns:

- `session/retry.ts` separates retryable provider failures from context overflow. It respects provider retry headers and avoids retrying prompt-too-long failures as ordinary transient errors.
- `session/processor.ts` cleans up interrupted tool calls and halts/retries through explicit session processor states.
- `session/message-v2.ts` converts pending/running tool calls into error outputs so stored history does not contain unresolved tool-use blocks.
- `provider/transform.ts` performs provider-specific message transforms, including tool ID scrubbing and sequence repair for providers that cannot accept tool-to-user adjacency.

Useful lesson: persisted pending tool calls must be normalized to explicit tool errors before the next provider call.

### `../free-code`

Observed patterns:

- `services/api/errors.ts` has specific HTTP 400 diagnostics for `tool_use`/`tool_result` mismatch, duplicate tool-use IDs, prompt-too-long, bad model, and payload size errors.
- `utils/messages.ts` has `ensureToolResultPairing()` that synthesizes missing tool results and strips orphan tool results before provider submission.
- `services/api/withRetry.ts` handles 429/529, provider fallback, fast-mode fallback, persistent retry mode, stale connection recovery, and max-token reductions for context overflow.

Useful lesson: orphan output should be dropped or converted into normal user-visible diagnostic text, not retained as a provider-native tool result.

### `../codex`

Observed patterns:

- Local search did not surface a better extension-layer pattern than the Chat Completions/Responses boundary repair already present in senpi.
- Codex-style flows emphasize provider-specific request shape differences, which supports keeping this fix in `tool-pair-guard` instead of adding generic core mutations.

## External SDK / OSS patterns

### Vercel AI SDK

Sources from public repo/docs:

- `packages/ai/src/generate-text/tool-call-repair-function.ts`
- `packages/ai/src/generate-text/parse-tool-call.ts`
- AI SDK docs for tool repair and `lastAssistantMessageIsCompleteWithToolCalls`

Pattern:

1. Parse and validate tool calls.
2. If a known tool has invalid input, allow a repair callback.
3. If repair fails, preserve structured invalid-call information rather than poisoning normal tool history.
4. Require tool results before continuing.

### Anthropic SDK

Observed pattern:

- `ToolRunner` automates the tool-use loop and structured `ToolError` feedback.
- The SDK still expects the transcript sent to the API to obey Anthropic ordering; caller-side guard logic remains valuable.

### agent-pi message-integrity guard

Observed pattern:

- Before every provider call, track current assistant `tool_use` ids.
- Synthesize missing results for unsatisfied tool uses.
- Drop orphan tool results because those are the direct 400-causing payload entries.

This maps closely to senpi's existing `tool-pair-guard` extension.

### Cline / OpenClaw / LobeHub / Inconvo / Nuum patterns

Observed patterns:

- Rebuild history from the last valid state after invalid provider requests.
- Validate transcript tool-call inputs and remove calls for unavailable tools.
- Recover malformed provider-specific argument shapes before sending.
- Feed invalid tool-call errors back as model-visible diagnostics instead of silently swallowing them.

## Risk list after research

1. Chat Completions orphan `tool` messages are unguarded. Selected for this implementation.
2. Google/Gemini `functionResponse` orphan handling is not guarded in `tool-pair-guard`. Deferred because adding Google requires separate payload-shape tests and provider-specific expectations.
3. `repairOrphanedToolResults()` keeps orphan `toolResult` role messages. This is safe only when a later provider-specific guard drops them; standalone `pi-ai` consumers and providers without guards may still see malformed payloads. Deferred to avoid changing shared library semantics without broader provider tests.
4. Generic HTTP 400 retry should not blindly retry. The safer pattern is pre-request sanitization for known malformed transcript shapes, then explicit diagnostics for remaining 400s.

## Acceptance criteria for selected implementation

1. Chat Completions payloads without a `messages` array are returned unchanged.
2. Valid assistant `tool_calls` plus matching `role: "tool"` messages are returned unchanged by reference.
3. Orphan `role: "tool"` messages with missing, empty, duplicate, or unseen `tool_call_id` are removed without mutating the original payload.
4. Assistant tool calls missing a tool output get a synthetic `role: "tool"` result immediately after the assistant message.
5. The `tool-pair-guard` extension applies Anthropic, OpenAI Responses, and OpenAI Chat Completions sanitizers in one pre-request pass.
6. Tests fail before the fix and pass after the fix.
7. `npm run check`, targeted tests, LSP diagnostics, and manual QA all pass.
