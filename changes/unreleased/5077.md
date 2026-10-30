<!-- changes-log: packages/ai/src/api/changes.md -->
## 2026-10-30 - Preserve SIWC admission and stream failures (part of #5003)

### What changed

- `packages/ai/src/api/openai-responses.ts` preserves direct-admission detail bodies, attaches SIWC diagnostics before HTTP retries, and names unsupported parameters.
- `packages/ai/src/api/openai-responses-shared.ts` preserves structured stream error codes and parameters and requires `response.completed` on SIWC routes.

### Why

- `packages/ai/src/api/openai-responses.ts` previously lost direct-admission bodies and retried terminal account restrictions.
- `packages/ai/src/api/openai-responses-shared.ts` previously collapsed structured failures into prose and accepted incomplete SIWC responses.

### Why an extension could not handle it

- `packages/ai/src/api/openai-responses.ts` owns the SDK request and retry boundary before extension delivery.
- `packages/ai/src/api/openai-responses-shared.ts` owns the Responses event decoder before extension delivery.

### Expected merge conflict zones

- `packages/ai/src/api/openai-responses.ts`: client construction, request retries, and error formatting.
- `packages/ai/src/api/openai-responses-shared.ts`: terminal and error event branches.

<!-- changes-log: packages/ai/src/changes.md -->
## 2026-10-30 - Identify the SIWC credential route (part of #5003)

### What changed

- `packages/ai/src/types.ts` adds the per-credential `OpenAIResponsesCompat.siwc` route marker.
- `packages/ai/src/provider-diagnostic.ts` preserves a validated SIWC route on structured diagnostics.

### Why

- `packages/ai/src/types.ts` must distinguish plan usage from API-key and Codex routes without token heuristics.
- `packages/ai/src/provider-diagnostic.ts` must preserve the status-only direct-admission policy across error boundaries.

### Why an extension could not handle it

- `packages/ai/src/types.ts` defines the adapter's shared compatibility contract.
- `packages/ai/src/provider-diagnostic.ts` validates diagnostics before retry and pool consumers read them.

### Expected merge conflict zones

- `packages/ai/src/types.ts`: `OpenAIResponsesCompat`.
- `packages/ai/src/provider-diagnostic.ts`: diagnostic fields and sanitizer.

<!-- changes-log: packages/ai/src/utils/changes.md -->
## 2026-10-30 - Share exact SIWC recovery decisions (part of #5003)

### What changed

- `packages/ai/src/utils/siwc-errors.ts` defines the shared exact-code recovery table and direct-admission status policy.
- `packages/ai/src/utils/provider-diagnostic-vocabulary.ts` recognizes the SIWC code/status pairs.
- `packages/ai/src/utils/provider-diagnostic-sources.ts` marks diagnostics from the SIWC adapter.
- `packages/ai/src/utils/provider-retry.ts` and `packages/ai/src/utils/retry.ts` use structured SIWC recovery before retry headers or prose.

### Why

- `packages/ai/src/utils/siwc-errors.ts` keeps HTTP, assistant, and pool recovery on one classification path.
- `packages/ai/src/utils/provider-diagnostic-vocabulary.ts` must preserve exact provider codes rather than guessing from prose.
- `packages/ai/src/utils/provider-diagnostic-sources.ts` distinguishes code-less SIWC admission failures from generic provider statuses.
- `packages/ai/src/utils/provider-retry.ts` and `packages/ai/src/utils/retry.ts` must not replay usage limits, eligibility restrictions, or invalid requests.

### Why an extension could not handle it

- `packages/ai/src/utils/siwc-errors.ts`, `packages/ai/src/utils/provider-diagnostic-vocabulary.ts`, and `packages/ai/src/utils/provider-diagnostic-sources.ts` are shared transport and classification contracts.
- `packages/ai/src/utils/provider-retry.ts` and `packages/ai/src/utils/retry.ts` decide retries before extension recovery.

### Expected merge conflict zones

- `packages/ai/src/utils/siwc-errors.ts`: new file.
- `packages/ai/src/utils/provider-diagnostic-vocabulary.ts`: code/status mappings.
- `packages/ai/src/utils/provider-diagnostic-sources.ts`: diagnostic adapters.
- `packages/ai/src/utils/provider-retry.ts` and `packages/ai/src/utils/retry.ts`: retry classification.

<!-- changes-log: packages/coding-agent/src/core/credential-pool/changes.md -->
## 2026-10-30 - Apply SIWC account recovery without invented resets (part of #5003)

### What changed

- `packages/coding-agent/src/core/credential-pool/classify.ts` consumes shared SIWC recovery before prose: pauses usage with a guessed cooldown capped at 30 minutes, disables ineligible accounts, marks invalid identity for sign-in, and keeps credentials healthy for transient or request failures.

### Why

- `packages/coding-agent/src/core/credential-pool/classify.ts` previously confused account, configuration, and provider faults when the provider's prose contained auth or billing words.

### Why an extension could not handle it

- `packages/coding-agent/src/core/credential-pool/classify.ts` runs before rotation persists account health and selects another credential.

### Expected merge conflict zones

- `packages/coding-agent/src/core/credential-pool/classify.ts`: early structured classification.

<!-- changes-log: packages/ai/CHANGELOG.md -->
### Fixed
- Classify Sign in with ChatGPT admission and streaming errors using exact provider codes, preserve direct-admission details, and avoid retrying terminal restrictions or invalid requests.

<!-- changes-log: packages/coding-agent/CHANGELOG.md -->
### Fixed
- Apply Sign in with ChatGPT account recovery without invented reset times, while retaining healthy credentials during temporary service failures.
