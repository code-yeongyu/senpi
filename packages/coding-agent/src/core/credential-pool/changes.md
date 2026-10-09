## 2026-10-07 - Retry a transient refresh on the same slot (senpi#2893)

### What changed

- `packages/coding-agent/src/core/credential-pool/classify.ts`: branded transient OAuth refresh returns `retry_same` with the existing attempt limit before status/message classification.

### Why

A healthy slot was failed or blocked when its refresh endpoint was temporarily unavailable.

### Why an extension could not handle it

Credential rotation invokes this classifier before an error reaches extension hooks.

### Expected merge conflict zones

- The first branch of `classifyCredentialFailure`; permanent login/account switching remains #2304's scope.
