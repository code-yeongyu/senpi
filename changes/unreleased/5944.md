<!-- changes-log: packages/ai/src/api/changes.md -->
## 2026-10-30 - SIWC prewarm eligibility follows resolved cache support (senpi#5101)

### What changed

- `packages/ai/src/api/openai-responses-prompt-cache.ts`: shares the SIWC-aware explicit-cache capability resolver between prewarm eligibility and the adapter.
- `packages/ai/src/api/openai-responses.ts`: uses that resolver in `getCompat`.

### Why

- `packages/ai/src/api/openai-responses-prompt-cache.ts`: inherited explicit-cache support must not make SIWC plan usage eligible for prewarm.
- `packages/ai/src/api/openai-responses.ts`: eligibility and request construction must resolve the same capability.

### Why an extension could not handle it

- `packages/ai/src/api/openai-responses-prompt-cache.ts`: eligibility runs before adapter loading or extension request hooks.
- `packages/ai/src/api/openai-responses.ts`: the adapter owns resolved wire capabilities.

### Expected merge conflict zones

- LOW: `packages/ai/src/api/openai-responses-prompt-cache.ts` capability and eligibility helpers.
- LOW: `packages/ai/src/api/openai-responses.ts` prompt-cache imports and `getCompat`.

<!-- changes-log: packages/coding-agent/src/core/extensions/builtin/compaction/changes.md -->
## 2026-10-30 - SIWC remote compaction never falls through to the compact endpoint (senpi#5101)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/compaction/openai-remote.ts`: retains the Responses v2 stream route for SIWC, then returns to local summarization if v2 is disabled or produces no checkpoint; timeout metadata names that same next step.

### Why

- `packages/coding-agent/src/core/extensions/builtin/compaction/openai-remote.ts`: SIWC plan usage supports streaming POST `/v1/responses`, not `/v1/responses/compact` or a WebSocket fallback.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/builtin/compaction/openai-remote.ts`: the builtin remote-compaction runner owns the transport fallback chain.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/core/extensions/builtin/compaction/openai-remote.ts` v2 timeout next-step selection and fallback boundary.

<!-- changes-log: packages/ai/CHANGELOG.md -->
### Fixed

- Sign in with ChatGPT models are ineligible for prompt-cache prewarm even when their catalog enables explicit caching (#5101).

<!-- changes-log: packages/coding-agent/CHANGELOG.md -->
### Fixed

- Sign in with ChatGPT compaction uses Responses v2 when available and otherwise local summarization, without calling the unsupported compact endpoint (#5101).
