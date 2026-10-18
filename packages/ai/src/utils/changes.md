## 2026-10-15 - Connection failures classify as network from structured transport codes (senpi#3228)

### What changed

- `packages/ai/src/utils/provider-diagnostic-vocabulary.ts`: `categoryForTransportCode` (closed allowlist: ECONNRESET, ECONNREFUSED, ETIMEDOUT, ENOTFOUND, EAI_AGAIN, EPIPE, UND_ERR_SOCKET, UND_ERR_CONNECT_TIMEOUT, UND_ERR_HEADERS_TIMEOUT, UND_ERR_BODY_TIMEOUT, UND_ERR_CLOSED, and the SDK class names APIConnectionError / APIConnectionTimeoutError -> `network`); `network` is a recognized category.
- `packages/ai/src/utils/provider-diagnostic-sources.ts`: `transportProviderDiagnosticFromError` walks up to 4 links of the `cause` chain reading only `code` (Node's fetch puts it two causes below the SDK error, Bun one), and falls back to the SDK connection error's class name (`name` or `constructor.name`) when no link has a code; never the message. The transport wrappers use it only when the adapter's classifier finds nothing.

### Why

A dropped connection had no category, so clients could not say "check connectivity".

### Why an extension could not handle it

The diagnostic is minted inside the provider transport wrappers in `pi-ai`, below any extension.

### Expected merge conflict zones

- `packages/ai/src/utils/provider-diagnostic-sources.ts`: `awaitProviderTransport` and `iterateProviderTransport`.

## 2026-10-14 - Thinking-mode refusal of a forced tool_choice is retried without it (senpi#3324)

### What changed

- `packages/ai/src/utils/tool-choice-fallback.ts`: the "does not support … tool_choice" refusal pattern accepts "this" and "the" besides "forced", so opencode-go's DeepSeek thinking models' `400 … Thinking mode does not support this tool_choice` is recognised by `isForcedToolChoiceUnsupportedError`. `sendWithForcedToolChoiceFallback` then retries once without `tool_choice`, and does not remember the refusal because it names thinking.

### Why

- The wording matched none of the six refusal patterns, and the message names no tool, so the forced first-turn `todo` choice was fatal. Subagents on `opencode-go/deepseek-v4.1-flash:high` died at launch (0 tool calls, about 1.6 s) whenever the upstream refused (senpi#3324, measured 1 to 2 of 3 launches by the reporter).

### Why an extension could not handle it

- The forced-choice retry runs inside the provider request path that every API shares; no hook sees the refusal before it is thrown.

### Expected merge conflict zones

- LOW: the third pattern in `isForcedToolChoiceUnsupportedError`.

## 2026-10-14 - Anthropic third-party billing rejection is terminal account exhaustion with its own explanation (senpi#3259)

### What changed

- `packages/ai/src/utils/retry.ts`: `ANTHROPIC_THIRD_PARTY_BILLING_MARKER` ("Third-party apps now draw from your extra usage") joins `QUOTA_EXHAUSTION_PATTERNS`, so the 400 classifies as non-retryable account exhaustion; `isAnthropicThirdPartyBillingMessage()` exposes the match.
- `packages/ai/src/utils/provider-failure-description.ts`: `describeProviderFailureForUser()` explains that rejection by billing path: on `anthropic` it names the subscription login ("Anthropic Subscription (Claude Pro/Max)" via `/login`), extra usage at https://claude.ai/settings/usage, or `/model`; on `anthropic-subscription` it offers extra usage or `/model` only.

### Why

- The 400 matched no classifier, so the hard-error fallback walked Opus 5.5 -> 5 -> 4.8 -> 4.6 on the same credential and every hop drew the same rejection (five requests, measured against a local mock), and the user saw only the raw body (senpi#3259).

### Why an extension could not handle it

- Retry classification and the user-facing failure text are shared by every provider and consumed inside the session retry/fallback engine; there is no hook between a provider error and its classification.

### Expected merge conflict zones

- LOW: the tail of `QUOTA_EXHAUSTION_PATTERNS` and the new constant above it in `retry.ts`; the import block and the first branch of `describeProviderFailureForUser()`.

## 2026-10-13 - Every typeless tool-parameter root gets `type: "object"` (senpi#3245, senpi#3250)

### What changed

- `packages/ai/src/utils/tool-schema-compat.ts`: `ensureRootObjectSchema` now adds `type: "object"` to a typeless root
  `allOf` and to an `anyOf`/`oneOf` union that cannot merge because a branch is not an object shape. Both previously
  went out typeless. The combiner stays beside the added type. (A typeless `$ref` root already got `type: "object"`
  before this change.) This supersedes the 2026-08-05 rule in `packages/ai/src/changes.md` that scalar and mixed root
  unions are left typeless.

### Why

DeepSeek and gateways forwarding to it reject every tool whose root parameters schema has no `type`
(`got 'type: null'`), so an unmergeable root union failed every tool call. Tool arguments are always JSON objects and
are validated locally against the original schema, so the stricter wire schema costs nothing in practice.

### Why an extension could not handle it

Tool-parameter normalization runs inside the OpenAI-compatible request builder after extensions hand over tools.

### Expected merge conflict zones

- `packages/ai/src/utils/tool-schema-compat.ts`: the tail of `ensureRootObjectSchema` and its doc comment.

## 2026-10-09 - Restore utils-tracker coverage for upstream-modified paths (senpi#3006)

### What changed

- `packages/ai/src/utils/error-body.ts`: terminal provider errors keep the provider Retry-After; shared quota-exhaustion wording (senpi#2198).
- `packages/ai/src/utils/estimate.ts`: token estimation maintenance on the v0.99.1 sync.
- `packages/ai/src/utils/event-stream.ts`: shared event-stream utility carried through integration repairs.
- `packages/ai/src/utils/overflow.ts`: context-overflow and rate-limit classification — Cursor-only `resource_exhausted` signatures, Kiro payload/context limits, [OI] context-window overflow, and the anthropic-subscription cold-seed refusal.
- `packages/ai/src/utils/pi-user-agent.ts`: the fork adds `forcePiUserAgent(headers)`, which deletes any case-variant `user-agent` header and forces the `User-Agent` to `getPiUserAgent()`; used so Kimi Coding requests always send the shared `pi (<platform>)` User-Agent.
- `packages/ai/src/utils/provider-retry.ts`: structured providerDiagnostic on failed provider turns (senpi#2197).
- `packages/ai/src/utils/text.ts`: request-option and content contract — metadata hooks, affinity, native blocks.
- `packages/ai/src/utils/transcript.ts`: TranscriptContext migration on the v0.99.1 sync.
- `packages/ai/src/utils/uuid.ts`: `fillRandomBytes` falls back to `Math.random` when `globalThis.crypto` is unavailable, with typed-array generics and an extracted `formatUuid()` keeping the time-ordered UUIDv7 generator typecheck-clean.

These files were covered by the parent tracker until senpi#2895 added this nearer tracker without listing them, hiding them from the audit's exact-nearest-tracker rule.

### Why

The repository audit requires every upstream-modified production path to be named by an entry in its exact nearest changes.md tracker. senpi#2895 introduced this tracker and named only the OAuth-refresh modules it touched, so the 9 pre-existing upstream-modified files beneath it lost the coverage the parent tracker had provided and were reported uncovered.

### Why an extension could not handle it

changes.md coverage is fork-owned documentation metadata; no extension or runtime hook can supply it.

### Expected merge conflict zones

- The `fillRandomBytes` random-byte source (the `Math.random` fallback) and the extracted `formatUuid()` in `packages/ai/src/utils/uuid.ts`, against upstream changes to its byte layout.
- The provider-specific pattern/regex lists in `packages/ai/src/utils/overflow.ts` (context-overflow / rate-limit classification), against upstream message-wording changes.
- `forcePiUserAgent` and `getPiUserAgent` in `packages/ai/src/utils/pi-user-agent.ts`, against upstream User-Agent changes.

## 2026-10-08 - Haiku 5.5 stays off for tool_reference loading until verified (senpi#2892, senpi#2914)

### What changed

- `packages/ai/src/utils/prompt-cache-ttl.ts`: the `defaultSupportsToolReferences` doc comment names Claude Haiku 5.5 as listed in Anthropic's tool-search table but kept off (the existing `haiku` exclusion) until a live probe; no behavior change.

### Why

The same table lists Haiku 4.5, which rejects client-side `tool_reference` blocks (#6474), and a rejection other than `Tool reference '…' not found` would fail the turn with no automatic demotion. senpi#2914 tracks the probe and the enable.

### Why an extension could not handle it

The `supportsToolReferences` default lives in the provider compat matrix.

### Expected merge conflict zones

- The `defaultSupportsToolReferences` doc comment in `prompt-cache-ttl.ts`.

## 2026-10-07 - Structured OAuth refresh retry facts (senpi#2893)

### What changed

- `packages/ai/src/utils/oauth-refresh-error.ts`: shared HTTP error, cycle-safe structured cause classification, closed log-safe cause classes, and cross-bundle unavailable brand.
- `packages/ai/src/utils/retry.ts`: retry a terminal OAuth-unavailable diagnostic before wording classification.

- `retry.ts` now defines `OAUTH_REFRESH_UNAVAILABLE_DIAGNOSTIC` itself, beside the classifier that reads it, so the `./utils/retry` and `./utils/provider-failure-description` entry graphs stay within budget. `oauth-refresh-error.ts` no longer exports it, and its cause walk is bounded at 16 links as well as cycle-safe.
### Why

Opaque transport prose cannot reliably identify transient refresh failures.

### Why an extension could not handle it

Shared retry decisions and cross-package error contracts are core request mechanics.

### Expected merge conflict zones

- `isRetryableAssistantError` and the new shared error module.
