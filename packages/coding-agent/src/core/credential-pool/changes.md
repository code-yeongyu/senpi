## 2026-10-12 - Keep wrongly long credential blocks out and record why each block happened (senpi#3216)

### What changed

- `packages/coding-agent/src/core/credential-pool/rotation-stream.ts`: `onSuccess` clears `failureCount` with the block, so a served request ends the failure streak; `persistBlock` writes one debug-log line per block through `block-log.ts`.
- `packages/coding-agent/src/core/credential-pool/classify.ts`: `HINTLESS_COOLDOWN_CAP_MS` (one hour) caps a cooldown that comes from the slot's own backoff; a provider reset hint (retry-after, reset field, reset prose) still sets any block up to `COOLDOWN_CAP_MS`. A `rate_limit` block records `cooldownSource: "hint" | "backoff"`.
- `packages/coding-agent/src/core/credential-pool/classify.ts` / `failover.ts`: a rate limit records `scope`: `account` when the text says the account's quota is spent, `unknown` for a plain 429 or throttle text. An `unknown` throttle's cooldown, hint included, stays within the hintless cap, and when a second account in the same request answers with an `unknown` throttle the request stops with the provider's error instead of blocking every account in the pool.
- `packages/coding-agent/src/core/credential-pool/block-log.ts` (new): formats the reason, cooldown source, model, failure count, until-time and a redacted 300-character provider excerpt; the account is named only by a short hash of its lane and slot name.

### Why

Unused ChatGPT subscription accounts carried 31-34 hour `rate_limit` blocks while their quota was untouched. `failureCount` never reset, so after about eleven transient 429s over an account's lifetime one more plain 429 blocked it for 60 s * 2^11 (34 h). Nothing recorded which response caused a block.

### Why an extension could not handle it

Rotation, classification and block persistence run inside the model runtime before any extension hook sees the request.

### Expected merge conflict zones

- None upstream: `credential-pool/` is fork-only.

## 2026-10-07 - Retry a transient refresh on the same slot (senpi#2893)

### What changed

- `packages/coding-agent/src/core/credential-pool/classify.ts`: branded transient OAuth refresh returns `retry_same` with the existing attempt limit before status/message classification.

### Why

A healthy slot was failed or blocked when its refresh endpoint was temporarily unavailable.

### Why an extension could not handle it

Credential rotation invokes this classifier before an error reaches extension hooks.

### Expected merge conflict zones

- The first branch of `classifyCredentialFailure`; permanent login/account switching remains #2304's scope.
