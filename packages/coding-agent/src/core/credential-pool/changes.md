## 2026-11-09 - A 403 that refuses one model no longer blocks the credential slot (senpi#3972)

### What changed

- `packages/coding-agent/src/core/credential-pool/classify.ts`: in the 403 branch, a refusal scoped to one model the plan does not include now fails the request instead of blocking the slot, matched by the new `MODEL_SCOPED_REFUSAL_TEXT` patterns. Every pattern is anchored on plan/subscription entitlement wording, so an account-wide refusal that merely mentions a model ("Access to model gpt-x denied: your account is not enabled") still blocks the slot as `auth_error`. The same refusal arriving as 429 (z.ai error code 1311) also fails the request instead of taking a `rate_limit` cooldown; a structured limit code still outranks the prose.

### Why

- With the built-in z.ai provider, GLM-5.3 failed with "The provider rejected the credentials" / "No credential slots available" while GLM-5.2 worked with the same key: the refusal was model-level (the plan does not include GLM-5.3), but a 403 whose body mentions subscription, account or organization became `auth_error`, blocking the slot for every model on that provider until the re-probe (senpi#3972). The vendor's actual refusal reads "Your current subscription plan does not yet include access to GLM-5.3" — "yet" in the middle and no word "model" — so a model-word pattern cannot see it.

### Why an extension could not handle it

- Credential failure classification runs in the shared pool before any extension sees the error; no extension hook can un-block a slot the classifier already poisoned.

### Expected merge conflict zones

- LOW: the `MODEL_SCOPED_REFUSAL_TEXT` patterns and the added checks in the 403 and 429 branches of `classify.ts`.

## 2026-11-09 - Export the model-block matcher (senpi#6254)

### What changed

- `packages/coding-agent/src/core/credential-pool/model-scope.ts`: exports `modelBlockApplies(key, modelId)`, a wrapper around the existing private `applies` (unchanged), so session code matches model blocks exactly as the pool does.

### Why

- Session code had a second, divergent copy of this rule.

### Why an extension could not handle it

- The matcher is internal to the credential pool.

### Expected merge conflict zones

- LOW: the export list of `model-scope.ts`.

## 2026-10-30 - Select accounts by configured strategy (senpi#5068)

### What changed

- `packages/coding-agent/src/core/credential-pool/selection-order.ts`: share cache-affine, stored-order fill-first, and round-robin ordering.
- `packages/coding-agent/src/core/credential-pool/round-robin-state.ts`: hold process-local per-provider cursors and account choices for stable affinity keys.
- `packages/coding-agent/src/core/credential-pool/rotation-slots.ts`: carry the strategy in the rotation policy.
- `packages/coding-agent/src/core/credential-pool/rotation-stream.ts`: pass the strategy and this session's round-robin turn into the shared slot pick, and retain round-robin replacements after a block or skip (pins are never remembered).
- `packages/coding-agent/src/core/credential-pool/session-slot.ts`: `SlotPickPolicy` carries `strategy` and `roundRobinOffset`; `orderRotationSlots` orders through `orderAccounts`, so the stream and `selectSessionSlot` apply the same strategy.

### Why

- `packages/coding-agent/src/core/credential-pool/rotation-stream.ts` previously offered only affinity ordering, not stored-order filling or cursor-based distribution of new sessions.

### Why an extension could not handle it

- `packages/coding-agent/src/core/credential-pool/rotation-stream.ts` selects credentials before dispatching provider requests.

### Expected merge conflict zones

- LOW: imports and selection callback in `packages/coding-agent/src/core/credential-pool/rotation-stream.ts`, ordering helpers in `packages/coding-agent/src/core/credential-pool/selection-order.ts`, and the policy type in `packages/coding-agent/src/core/credential-pool/rotation-slots.ts`. Failure classification and block lifetimes are unchanged.

## 2026-10-30 - Prefer reported subscription headroom (senpi#5053)

### What changed

- `packages/coding-agent/src/core/credential-pool/selection-order.ts`: add a pure preference for accounts whose live reported windows are below 95% usage.
- `packages/coding-agent/src/core/credential-pool/session-slot.ts`: `pickRotationSlot` applies the preference after the pin and the normal account ordering (`orderRotationSlots`) when the policy carries limit readings, and holds the per-session memory of a headroom move (`rememberedHeadroomAccount` / `rememberHeadroomAccount`), so the stream and auxiliary requests pick the same account.
- `packages/coding-agent/src/core/credential-pool/rotation-stream.ts`: passes the live limit readings and the remembered account to `pickRotationSlot`, and remembers a move the preference made (never a pinned pick).

### Why

- `packages/coding-agent/src/core/credential-pool/rotation-stream.ts` selected an account already near its subscription limit even when another account had reported headroom.

### Why an extension could not handle it

- `packages/coding-agent/src/core/credential-pool/rotation-stream.ts` selects the credential before the provider request runs.

### Expected merge conflict zones

- LOW: imports and the `select` callback in `packages/coding-agent/src/core/credential-pool/rotation-stream.ts`, and `SlotPickPolicy` / `pickRotationSlot` in `packages/coding-agent/src/core/credential-pool/session-slot.ts`; classification and block lifetimes are unchanged.

## 2026-11-03 - An ISO reset after "Resets at" is read (senpi#5596)

### What changed

- `packages/coding-agent/src/core/credential-pool/reset-time.ts`: `usageLimitReset` reads an ISO instant introduced by "resets [at]" in prose (with or without seconds, fractional seconds, `Z` or an offset) as an absolute reset, after the JSON and relative readers and before the clock reader. A timestamp not introduced by "resets" is ignored.

### Why

- "Weekly usage limit reached. Resets at 2026-11-03T02:40:02Z" returned no reset, so the pool fell back to the 60 s rate-limit backoff and retried a spent account every minute for a limit hours away.

### Why an extension could not handle it

- The reset parser is shared by the credential pool, retry-fallback and the Anthropic subscription lane; no extension hook sits before it.

### Expected merge conflict zones

- LOW: the reader order in `usageLimitReset`.

## 2026-10-30 - The all-blocked outcome carries the soonest unblock time (senpi#3975)

### What changed

- `packages/coding-agent/src/core/credential-pool/failover.ts`: when no slot can serve and every slot not out for auth or a disabled account waits on a rate limit (at least one), the thrown refusal carries `credentialPoolBlockedDiagnostic(soonest rate-limit reset)`; a slot with an unknown block keeps the refusal unclassified, and a disabled slot's re-probe time is never the pool's reset, and a forwarded terminal event goes through the new optional `withPoolRetryAt` hook. This happens only when the refusal is itself a limit (no attempt ran, or the last attempt was blocked for a rate limit): a probe refused for auth, billing or a missing model keeps its own classification and status, which the goal's 401/403 block reads. Pools blocked only for re-authentication are unchanged.
- `packages/coding-agent/src/core/credential-pool/rotation-stream.ts`: `withPoolRetryAt` keeps a provider-classified limit's own reset (or adds the pool's), turns a failure with no diagnostic or an unclassified 429 into the pool's rate limit, and leaves anything else (auth, a 402/403/404 status) as the provider said.

### Why

- senpi#3975: after the cooling probe failed, the pool forwarded the probed slot's own error, which carried no reset, so the goal retried before any slot could serve.

### Why an extension could not handle it

- The refusal is produced inside the pool engine, before any event reaches an extension.

### Expected merge conflict zones

- LOW: the no-candidate branch of `runCredentialFailover` and the options passed in `streamWithCredentialRotation`.

## 2026-10-27 - One slot pick for the stream and auxiliary callers (senpi#3924)

### What changed

- `packages/coding-agent/src/core/credential-pool/session-slot.ts` (new): `pickRotationSlot` (pin, else affinity order with the user's account order) and `selectSessionSlot` (that pick over the stream's first-attempt candidates; when the stream would refuse it throws the stream's refusal).
- `packages/coding-agent/src/core/credential-pool/rotation-stream.ts`: `streamWithCredentialRotation`'s `select` calls `pickRotationSlot`. `ModelRuntime.getSessionAuth` loads `selectSessionSlot` from `session-slot.ts` with a dynamic import next to the rotation stream.
- `packages/coding-agent/src/core/credential-pool/failover.ts`: `attemptCandidates` (untried unblocked slots, else the cooling probe: the rate-limited slot due back first) and `noSlotsError` are extracted from `runCredentialFailover` and exported, so the stream and `selectSessionSlot` share one all-blocked rule.

### Why

- Auxiliary requests must authenticate as the account the session's turns use; sharing the pick keeps the two from drifting.

### Why an extension could not handle it

- Slot selection is internal to the credential pool.

### Expected merge conflict zones

- LOW: the `select` callback in `rotation-stream.ts`; the candidate/refusal lines at the top of `runCredentialFailover`'s loop in `failover.ts`.

## 2026-10-30 - A guessed limit backoff stops at 30 minutes (senpi#4091)

### What changed

- `packages/coding-agent/src/core/credential-pool/classify.ts`: `rateLimitCooldown` caps the guessed exponential term at `GUESSED_BACKOFF_CAP_MS` (30 minutes). A server hint still floors the cooldown, and a provider-stated usage reset still blocks until that reset, capped at 48 hours.

### Why

- A limit with no parseable reset doubled its cooldown on every failed half-open probe, up to 48 hours, so a spent account stayed blocked for hours after its provider window had reset.

### Why an extension could not handle it

- The cooldown is computed inside the credential pool's failure classifier.

### Expected merge conflict zones

- LOW: the constants block and `rateLimitCooldown` in `classify.ts`.

## 2026-10-30 - The generic pool announces its account switches (senpi#2304, senpi#5017)

### What changed

- `packages/coding-agent/src/core/credential-pool/rotation-stream.ts`: `onRotate` records the account a pre-output failover left, and the next account's attempt emits one `emitProviderAccountFailover(provider, from, to, reason)` (`account_disabled` maps to `billing`). Nothing is emitted after committed output or when no account is left.

### Why

- Only the Anthropic subscription lane emitted `account_failover`; the generic pool switched accounts with no signal to RPC clients or the TUI.

### Why an extension could not handle it

- The switch happens inside the core credential-pool engine that `ModelRuntime` drives; no extension hook observes it.

### Expected merge conflict zones

- LOW: the `runCredentialFailover({...})` options in `streamWithCredentialRotation`.

## 2026-11-01 - slotsStartedByLogin is module-private (senpi#5281)

### What changed

- `packages/coding-agent/src/core/credential-pool/login-health.ts`: `slotsStartedByLogin` is no longer exported; only `retireLoginSlotHealth` in the same file calls it. No behavior change.

## 2026-10-30 - Apply SIWC account recovery without invented resets (part of #5003)

### What changed

- `packages/coding-agent/src/core/credential-pool/classify.ts` consumes shared SIWC recovery before prose: pauses usage with a guessed cooldown capped at 30 minutes, disables ineligible accounts, marks invalid identity for sign-in, and keeps credentials healthy for transient or request failures.

### Why

- `packages/coding-agent/src/core/credential-pool/classify.ts` previously confused account, configuration, and provider faults when the provider's prose contained auth or billing words.

### Why an extension could not handle it

- `packages/coding-agent/src/core/credential-pool/classify.ts` runs before rotation persists account health and selects another credential.

### Expected merge conflict zones

- `packages/coding-agent/src/core/credential-pool/classify.ts`: early structured classification.

## 2026-10-30 - An account block survives a token refresh; a login clears the slot it replaced (senpi#4093)

### What changed

- `packages/coding-agent/src/core/credential-pool/state-store.ts`: `storedSlotRevisions` returns an account key (HMAC over provider, slot name and the account identity: the API key, or the ChatGPT account id plus the JWT `sub`) and the material key (`storedCredentialRevision`). `applicableStoredState` is the one rule for which stored health applies: a rejected-token entry only to the material it rejected, every other verdict to the account, a legacy material-keyed entry until its next write.
- `packages/coding-agent/src/core/credential-pool/rotation-slots.ts` and `packages/coding-agent/src/core/credential-pool/rotation-stream.ts`: selection uses that rule; `auth_error` is recorded under the material key, every other block under the account key, and a success re-keys the entry to the account.
- `packages/coding-agent/src/core/credential-accounts.ts`: account listings use the same rule.
- `packages/coding-agent/src/core/credential-pool/login-health.ts` (new): `slotsStartedByLogin` names every stored slot a login created or gave new material, and `retireLoginSlotHealth` drops their stored pool health. Both login paths use it: `AuthStorage.login` and `ModelRuntime.login` (the TUI `/login` and account commands).

### Why

- Health was keyed to an HMAC over the access and refresh tokens, so a routine OAuth refresh dropped every block on the account, `account_disabled` included, and the spent or disabled account was tried again.

### Why an extension could not handle it

- The health sidecar, slot selection and login persistence are internal to the credential pool and `AuthStorage`.

### Expected merge conflict zones

- LOW: the stored-slot loop of `listRotationSlots`, `persistBlock`/`onSuccess` in `streamWithCredentialRotation`, the stored branch of `summarizeInStoredOrder`, and `AuthStorage.login`.

## 2026-10-30 - The provider's structured limit code outranks the limit prose (senpi#3216)

### What changed

- `packages/coding-agent/src/core/credential-pool/rotation-events.ts`: the rotation error carries the adapter's sanitized provider diagnostic through `attachProviderDiagnostic`, next to the HTTP status it already carried.
- `packages/coding-agent/src/core/credential-pool/classify.ts`: `limitFromProviderCode` reads that diagnostic. A code proven from structured fields decides the limit before any prose: `rate_limit_exceeded` is a throttle whose only hint is the server's Retry-After header (the adapter's `retry-after-ms` marker), never the window reset its prose names; `usage_limit_reached` / `usage_not_included` is a spent account blocked until the diagnostic's `resetsAt`, and a `resetsAt` already past falls back to the reset the response names. Anthropic's `rate_limit_error` comes on every 429, spent Claude windows included, so it decides nothing and keeps the existing hint rules. Without such a code the prose rules are unchanged.

### Why

- The ChatGPT adapter words every 429 with an error object as a spent account, so a per-request throttle with a far window reset blocked a healthy account for up to 48 hours.

### Why an extension could not handle it

- The classification runs inside the credential pool before any extension sees the failure.

### Expected merge conflict zones

- LOW: the rate-limit branch of `classifyCredentialFailure` and `rotationErrorFromEvent`.

## 2026-10-30 - An auth failure of one pooled account fails over (senpi#2304, senpi#3037, senpi#5010)

### What changed

- `packages/coding-agent/src/core/credential-pool/classify.ts`: before any auth prose, a failed refresh (`ModelsError` code `oauth` in the cause chain) classifies as `failover` with `auth_error` only when its `OAuthTokenEndpointError` cause refused the credential (`isRefusedGrant`: the adapter's `credentialRefused`, any 401, a 400 naming `invalid_grant`, `refresh_token_*` or `token_revoked`, or a 403/404 whose OAuth code does; an OAuth code in `CLIENT_FAULT_CODES` outranks all of them). Any other failed refresh skips every blocking branch: it retries the same account when the first error code in its cause chain is in `NETWORK_FAULT_CODES`, or, with no code and no token-endpoint answer, when its text matches `NETWORK_TEXT`, and fails the request otherwise. A provider diagnostic in the auth category or with an auth token code (`token_revoked`, `token_invalidated`, ...; not `token_expired`) classifies as `failover` with `auth_error` unless a provider fault or a 429 takes precedence, including statusless network/timeout faults. `REVOKED_TOKEN_TEXT` joins `INVALID_KEY_TEXT` as the prose last resort under the same provider-fault guard, matching token revocation but not a session, page or request token, nor unrelated session invalidation.
- `packages/coding-agent/src/core/credential-pool/rotation-events.ts`: `rotationErrorFromEvent` attaches the event's whole provider diagnostic, not only its HTTP status.

### Why

- A refused refresh token (no status) and a statusless revoked-token frame classified as `fail_request`, so one dead account dead-ended a pool with healthy siblings, and a pinned dead account was selected on every request.

### Why an extension could not handle it

- Classification runs inside the core credential-pool engine that `ModelRuntime` drives; no extension hook sees the failure before it is classified.

### Expected merge conflict zones

- LOW: the auth branch of `classifyCredentialFailure` and the regex and code-set block above it in `classify.ts`; `rotationErrorFromEvent` in `rotation-events.ts`.

## 2026-10-30 - The health file reads past fields another engine version wrote (senpi#4090)

### What changed

- `packages/coding-agent/src/core/credential-pool/state-store.ts`: the document, provider, lane, slot, lease and model-block schemas are `z.looseObject`. Unknown fields are read past, and a slot write keeps the unknown fields of the document, the provider, the lane and every other slot (`mutateSlotState` spreads the provider and lane instead of rebuilding them); a slot this engine rewrites holds only the fields this engine knows. Known fields keep their validation and `schemaVersion` stays `1`. `CredentialSlotState` is declared rather than inferred from the loose schema, so writers keep compile-time checks on the known fields.

### Why

- Every engine version on a machine shares `credential-pool-state.json`. A strict schema made a reader that met one unknown field replace the whole file, dropping every provider's blocks and the installation key, so no version could ever add a field safely.

### Why an extension could not handle it

- The health sidecar's parsing is internal to the credential pool.

### Expected merge conflict zones

- LOW: the schema declarations at the top of `state-store.ts` and the provider/lane rebuild in `mutateSlotState`.

## 2026-10-30 - An unsettled probe hands its lease back; a leased slot names its retry time (senpi#4094)

### What changed

- `packages/coding-agent/src/core/credential-pool/failover.ts`: `runCredentialFailover` takes an optional `releaseSlot(slot)`, run once in a `finally` when the request leaves a selected slot with neither a success nor a persisted block (an abort, a request-scoped failure, exhausted same-slot retries, the caller stopping the stream). A same-slot retry also runs it before listing slots again, so the retry is never refused by the request's own lease.
- `packages/coding-agent/src/core/credential-pool/rotation-stream.ts`: `releaseSlot` hands back only the half-open probe lease this request took (`heldLeaseId`), matched by lease id; the `lease` copied from the shared file may be another request's and is never released.
- `packages/coding-agent/src/core/credential-pool/rotation-slots.ts`: `releaseProbeLease` is shared with the model-block lease release. A listed slot carries the non-persisted `heldLeaseId` only when this listing took the lease and kept it. A slot whose probe another request holds stays listed, blocked until that lease expires with reason `probe_in_flight`, instead of being dropped.

### Why

- A probe that ended without a verdict kept its 30 s lease, and every other caller dropped the slot, so a one-slot pool refused with "No credential slots available" and no retry time.

### Why an extension could not handle it

- The probe lease and the slot listing are internal to the credential pool engine.

### Expected merge conflict zones

- LOW: the `try`/`finally` around the attempt loop in `runCredentialFailover`; the lease branches of `listRotationSlots` and `listEnvRotationSlots`.

## 2026-10-30 - The pool's reset reader uses the shared wall-clock parser (senpi#1771)

### What changed

- `packages/coding-agent/src/core/credential-pool/reset-time.ts`: reads a wall-clock reset with `clockResetMs` from `@earendil-works/pi-ai/utils/retry-hint` instead of its own copy; behavior unchanged.

### Why

- One parser for one text, so the pool and the retry-hint extractor cannot drift apart again.

### Why an extension could not handle it

- The reset reader is internal to the credential pool's classifier.

### Expected merge conflict zones

- LOW: the imports and `usageLimitReset` in `reset-time.ts`.

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
