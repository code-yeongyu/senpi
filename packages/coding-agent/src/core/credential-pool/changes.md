## 2026-10-29 - Committed pool health publishes an account change

### What changed

- `packages/coding-agent/src/core/credential-pool/rotation-stream.ts`: `persistBlock` publishes `emitProviderAccountsChanged(providerId)` once its block write has committed, including when no other account can take over. `onSuccess` publishes once its write has committed only when that write lifted a block (an account block, a block reason, or a model block on the model that served); a healthy account answering again publishes nothing. A write `writeHealthUnlessStoreBusy` skipped because the state file stayed locked publishes nothing, and a write that throws never reaches the publish.

### Why

- RPC clients reread `get_provider_accounts` on `auth_accounts_changed`. The generic pool persisted blocks and releases to the health sidecar without ever publishing, so an account row kept showing an account as available after the pool blocked it (most visibly a single account that exhausted with nothing to rotate to), and kept showing it blocked after a success released it. Only the Anthropic subscription lane published, and only from its failover callback.

### Why an extension could not handle it

- The health writes happen inside the credential rotation that wraps the provider request; no extension hook sees when a sidecar write commits or is skipped.

### Expected merge conflict zones

- LOW: the `onSuccess` and `persistBlock` callbacks passed to `runCredentialFailover` in `streamWithCredentialRotation`.

## 2026-10-21 - Resolve typed policy-slot references (senpi#3858)

### What changed

- `packages/coding-agent/src/core/credential-pool/rotation-slots.ts`: policy slot values accept the shared reference union and read named reference environment values from the supplied environment source. A failed reference skips only that slot with a diagnostic naming its field and reason, never its value, printed once per process rather than on every request. Stored, discovered environment and healthy policy slots remain usable; when no slot remains, the request propagates the named reference failure.

### Why

- Policy slots need the same reference and origin contract as provider keys. An empty explicit request environment must not silently inherit ambient process credentials, and an unused broken slot must not fail a request that can use another slot.

### Why an extension could not handle it

- Rotation chooses credentials before invoking the provider request path.

### Expected merge conflict zones

- LOW: `RotationSources.policy.slots` and the policy-slot resolution loop.

## 2026-10-22 - Temporary failures never become auth blocks (senpi#2081)

### What changed

- `packages/coding-agent/src/core/credential-pool/classify.ts`: `ACCOUNT_POOL_REFUSAL_NOTE` marks a local refusal from a provider that runs its own account pool, and that refusal now fails the request instead of blocking the outer slot. A 408, 5xx or 529 status decides before body text, so "unauthorized" or "billing" in such a body no longer means `auth_error` or `account_disabled`. A 429 that mentions authentication, and a 403 that reports a rate limit, now cool down. Only a 401, or auth text on a non-temporary status, blocks a slot as `auth_error`.
- `packages/coding-agent/src/core/credential-pool/classify.ts` also treats a statusless failure that names a timeout, reset, gateway or overload as temporary, so a custom provider's non-standard body can no longer persist a block.
- `packages/coding-agent/src/core/credential-pool/state-store.ts`: `clearProvider()` drops a provider's health entries; a clean file is only read. `ModelRuntime` uses it to retire the outer-slot blocks older builds left for a lane that now owns its account selection.
- `packages/coding-agent/src/core/credential-pool/failover.ts`: when no slot can serve, the error names each slot with its reason and the time it is due back, instead of a bare "No credential slots available".

### Why

senpi#2081: the outer pool wraps the Anthropic Subscription lane, which picks from all of its accounts itself. When one account was revoked and another was briefly rate-limited, the lane reported "authentication error". The outer pool then persisted `auth_error` against every outer slot within one request, and every later request failed with "No credential slots available" until the re-probe time or a re-login, even with the pinned account healthy.

### Why an extension could not handle it

Credential rotation classifies and persists slot health before an error reaches extension hooks.

### Expected merge conflict zones

- The early branches of `classifyCredentialFailure` (auth, 403, billing and rate-limit order).
- The no-candidate throw in `runCredentialFailover`.

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
