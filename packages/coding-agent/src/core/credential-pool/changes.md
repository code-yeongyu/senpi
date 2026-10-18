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

## 2026-10-16 - Rotation never hands a session the other kind's slot (#3486)

### What changed

- `packages/coding-agent/src/core/credential-pool/rotation-slots.ts`: `listRotationSlots` lists only `slotsOfOwnKind(credential)`, so a mixed pool written by older builds (an API key appended under an OAuth login) offers only its OAuth slots to per-session selection.

### Why

- `packages/coding-agent/src/core/credential-pool/rotation-slots.ts`: HRW selection could pick the key slot, which the OAuth credential cannot project, so that session resolved no credential (#3486 review, TUI footer showed `openrouter@login-2`).

### Why an extension could not handle it

- `packages/coding-agent/src/core/credential-pool/rotation-slots.ts` builds the candidate set every pooled request selects from.

### Expected merge conflict zones

- `packages/coding-agent/src/core/credential-pool/rotation-slots.ts`: the stored-lane loop in `listRotationSlots` and its imports.
