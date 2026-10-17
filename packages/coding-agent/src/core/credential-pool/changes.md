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
