## 2026-10-17 - envSlotVarNames: every name the env slots read (senpi#3531)

### What changed

- `packages/coding-agent/src/core/credential-pool/env-slots.ts`: `envSlotVarNames()` lists the primary variable and `<VAR>_2` .. `<VAR>_16` for every provider with env slots, `anthropic-subscription` (`CLAUDE_CODE_OAUTH_TOKEN`) included. It uses the same `primaryEnvVar` and `MAX_ENV_SLOT_INDEX` as `discoverEnvSlots`.

### Why

senpi#3531: the host daemon allowlist must pass exactly the names slot discovery reads.

### Why an extension could not handle it

Slot discovery is core credential resolution, not an extension surface.

### Expected merge conflict zones

- `packages/coding-agent/src/core/credential-pool/env-slots.ts`: the import line and the new function above `discoverEnvSlots`.

## 2026-10-07 - Retry a transient refresh on the same slot (senpi#2893)

### What changed

- `packages/coding-agent/src/core/credential-pool/classify.ts`: branded transient OAuth refresh returns `retry_same` with the existing attempt limit before status/message classification.

### Why

A healthy slot was failed or blocked when its refresh endpoint was temporarily unavailable.

### Why an extension could not handle it

Credential rotation invokes this classifier before an error reaches extension hooks.

### Expected merge conflict zones

- The first branch of `classifyCredentialFailure`; permanent login/account switching remains #2304's scope.
