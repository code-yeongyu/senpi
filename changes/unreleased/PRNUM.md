<!-- changes-log: packages/coding-agent/src/core/changes.md -->
## 2026-11-02 - Session titles survive reasoning that eats the title budget (senpi#5471)

### What changed

- `packages/coding-agent/src/core/session-title-generator.ts`: `generateSessionTitle()` returns a typed `SessionTitleOutcome` (`titled`, `fallback`, `untitled`, `unparsed`) instead of `string | undefined`. When a reasoning-free 64-token request ends at `length` with no usable text (the model thought through the whole budget), it retries once with the 1024-token reasoning budget, still without a reasoning level. When that answer is also empty, the outcome is a `fallback` title built from the first user message plus a typed `title_model_returned_no_text` warning. Requests that answer inside 64 tokens are unchanged.
- `packages/coding-agent/src/core/session-title-answer.ts` (new): `readTitleAnswer()` (the `<title>` parser and sanitizer, moved out of the generator) tells an empty or cut-off answer apart from an unparsable one; `fallbackSessionTitle()` cuts the first prompt line at a word boundary (48 characters).
- `packages/coding-agent/src/core/session-title-attempts.ts` (new): `SessionTitleAttempts` applies an outcome to the session: a fallback sets the name, writes one `session_title_fallback` warn line to `logs/session.log` and shows one `warning` notice naming the model and budget; failed or unparsable attempts are counted and title generation stops after three per session (`session_title_failed` lines carry `attempt` and `willRetry`).
- `packages/coding-agent/src/core/agent-session.ts`: `_startSessionTitleGeneration()` skips once the attempts are exhausted; `_generateSessionTitle()` hands the outcome and failures to `SessionTitleAttempts`.

### Why

- On gateways that serve reasoning models and cannot turn thinking off (LiteLLM -> vLLM with Kimi, GLM, Qwen, gpt-oss), reasoning tokens count against `max_tokens`, so the 64-token title budget ended with `content: null`. The missing `<title>` was a clean `undefined`: no log line, no notice, the session stayed unnamed, and the same request was re-sent after every prompt (senpi#5471, reported by jerilkuriakose).
- The reasoning budget only applied when a reasoning level was sent, which these providers reject, so it could never be reached.

### Why an extension could not handle it

- Title generation, its retry policy and the session name write are private `AgentSession` work started at turn end; no hook observes the title response.

### Expected merge conflict zones

- LOW: `_startSessionTitleGeneration()` and the try/catch of `_generateSessionTitle()` in `agent-session.ts`.
- LOW: `generateSessionTitle()` and `buildTitleOptions()` in `session-title-generator.ts`.

<!-- changes-log: packages/coding-agent/CHANGELOG.md -->
### Fixed
- Session titles no longer silently stay empty on reasoning models behind gateways that cannot turn thinking off: a title cut off by reasoning is retried once with room for the answer, a model that still returns no text names the session from the first message with one warning, and a failing title is no longer re-requested after every prompt (at most three attempts per session). Thanks to @jerilkuriakose for the report ([#5471](https://github.com/code-yeongyu/senpi/issues/5471)).
