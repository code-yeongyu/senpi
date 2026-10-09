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
