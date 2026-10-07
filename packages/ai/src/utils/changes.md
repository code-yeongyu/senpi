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
