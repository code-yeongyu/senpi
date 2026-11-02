## 2026-10-30 - Clear SIWC sessions atomically and confirm remote revocation (part of #5003)

### What changed

- `packages/ai/src/auth/types.ts`: adds the optional OAuth revocation hook, injectable logout backoff, and typed confirmation result.
- `packages/ai/src/auth/credential-store.ts`: atomically captures and clears selected slots before revocation outside the storage lock, retaining registration metadata and later login writes. Logout waits for in-flight exchanges and reports unconfirmed revocation for an unknown slot or failed discarded-token revocation.
- `packages/ai/src/auth/resolve.ts`: does not refresh a signed-out registration.
- `packages/ai/src/auth/pool/slots.ts`: `appendLoginSlot` lets a login after sign-out take over the signed-out credential (flat or pooled projection) instead of appending a sibling slot, so the provider resolves the new session and the retained registration survives.
- `packages/ai/src/auth/oauth-refresh.ts`: re-checks signed-out state and compare-and-swaps refresh writes; a cancelled or losing exchange revokes its newly minted token outside the store lock instead of restoring a signed-out slot. Logout collects exchanges through publication of the local clear and includes their cleanup failures in its result.

### Why

- `packages/ai/src/auth/types.ts`, `packages/ai/src/auth/credential-store.ts`, `packages/ai/src/auth/resolve.ts`, `packages/ai/src/auth/pool/slots.ts`, and `packages/ai/src/auth/oauth-refresh.ts`: SIWC sign-out must end the renewable session even when refresh is in flight, clear local secrets without remote confirmation, and retain the account/client mapping for a later sign-in.

### Why an extension could not handle it

- `packages/ai/src/auth/types.ts`, `packages/ai/src/auth/credential-store.ts`, `packages/ai/src/auth/resolve.ts`, `packages/ai/src/auth/pool/slots.ts`, and `packages/ai/src/auth/oauth-refresh.ts`: the provider hook, serialized credential mutation, and shared request-auth resolution are core auth contracts.

### Expected merge conflict zones

- `packages/ai/src/auth/types.ts`: OAuth hooks and logout options.
- `packages/ai/src/auth/credential-store.ts`: atomic slot selection, token clear, and revocation orchestration.
- `packages/ai/src/auth/resolve.ts`: stored OAuth resolution before refresh.
- `packages/ai/src/auth/pool/slots.ts`: `appendLoginSlot` signed-out branch.
- `packages/ai/src/auth/oauth-refresh.ts`: stored-slot view, in-flight exchange registry, compare-and-swap, and discarded-token cleanup.

## 2026-10-30 - A ChatGPT re-login replaces the saved account instead of appending a copy (senpi#5009)

### What changed

- `packages/ai/src/auth/types.ts`: `OAuthAuth.accountIdentity?(credential)` (optional, synchronous): the signed-in account a credential's own material belongs to, or `undefined`.
- `packages/ai/src/auth/helpers.ts`: `lazyOAuth` passes `accountIdentity` through without loading the flow module.
- `packages/ai/src/auth/pool/slots.ts`: `appendLoginSlot` takes `{ accountIdentity }`. A flat OAuth login whose identity matches saved accounts rewrites the first match in place (`replaceSameAccount`), keeping its name, label, source and position and dropping stale block fields. Later copies of the same account are removed, a pin/order naming one moves to the kept name, and the flat projection is re-pointed only when it carried one of them. A lone flat credential of the same account is overwritten. No identity, or no match, appends as before.

### Why

- oh-my-openagent#9633, senpi#4086: every re-login appended `login-N` and kept the old slot. Once the provider invalidated that token, session affinity kept ranking the dead slot first, and `/login` could not recover the session.

### Why an extension could not handle it

- The login write step is the shared persistence path inside `Models.login` and the auth store; no hook runs between the provider's login result and the write.

### Expected merge conflict zones

- LOW: the flat-login tail of `appendLoginSlot` and the `OAuthAuth` interface; `lazyOAuth`'s returned object.

## 2026-10-29 - Export the slot-selection block predicate (senpi#4885)

### What changed

- `packages/ai/src/auth/pool/select.ts`: the private `isBlocked` is exported as `isSlotBlocked`; `selectSlot` uses it unchanged.

### Why

- Account listings must answer "is this slot available" with the predicate selection uses, not a second copy that can drift (senpi#4365 follow-up).

### Why an extension could not handle it

- The predicate lives in the pool engine; callers outside it could only re-implement it, which is the bug.

### Expected merge conflict zones

- LOW: `isSlotBlocked` in `select.ts`.

## 2026-10-22 - Resolve slot-scoped requests through the store's own slot read (senpi#3858)

### What changed

- `packages/ai/src/auth/types.ts`: optional `CredentialStore.readSlot` reads one pooled slot already projected for a slot-scoped request.
- `packages/ai/src/auth/credential-read.ts`: `readSlotCredential` uses the store's `readSlot` when present and otherwise projects `read`. A projected key that is still an object raises `ModelsError("auth")` caused by `ConfigReferenceError` (`forbidden`), so an unresolved reference never reaches a provider.
- `packages/ai/src/auth/resolve.ts`: slot-scoped resolution reads through `readSlotCredential`; the flat credential is read only for unscoped requests.
- `scripts/check-entry-graphs.mjs`: the `./models` budget grows by `utils/config-reference-error.ts`.

### Why

- Reading the whole credential first resolved its flat key, so a pooled request failed on an unused account's broken reference, and the selected slot's reference reached the provider unresolved.

### Why an extension could not handle it

- Slot-scoped auth resolution is the cross-provider choke point in `resolve.ts`.

### Expected merge conflict zones

- MEDIUM: the slot branch of `resolveProviderAuthWithSignal` in `packages/ai/src/auth/resolve.ts`.
- LOW: the `CredentialStore` interface in `packages/ai/src/auth/types.ts`.

## 2026-10-22 - Extract the credential-store read without behavior changes (senpi#3858)

### What changed

- `packages/ai/src/auth/credential-read.ts`: holds the unchanged `readCredential` store read and its `ModelsError` wrapping, moved from `resolve.ts`.
- `packages/ai/src/auth/resolve.ts`: imports the moved read.
- `scripts/check-entry-graphs.mjs`: the `./models` entry budget grows by this one leaf module.

### Why

- Isolates the store read that reference-object support extends, so the behavior edit lands in a focused module and `resolve.ts` stays within the size boundary.

### Why an extension could not handle it

- Provider auth resolution is a core auth internal.

### Expected merge conflict zones

- LOW: the `readCredential` import in `packages/ai/src/auth/resolve.ts`.
- LOW: the `./models` budget comment in `scripts/check-entry-graphs.mjs`.

## 2026-10-21 - ApiKeyAuth.keyOptional for providers that work without a key (senpi#3869)

### What changed

- `packages/ai/src/auth/types.ts`: `ApiKeyAuth` gains optional `keyOptional`. A provider sets it when it works without a key (a local server such as llama.cpp); `Models.login` then drops a blank key instead of refusing it with `EmptyApiKeyError`.

### Why

- senpi#3867 refuses blank API-key saves. The refusal must apply only to providers that need a key, and that has to come from provider metadata rather than a list of names (senpi#3869 review).

### Why an extension could not handle it

- `Models.login` reads the flag from the provider's auth contract, which lives in `pi-ai`.

### Expected merge conflict zones

- LOW: the field list of `ApiKeyAuth` next to `ambientOnly`.

## 2026-10-09 - Restore auth-tracker coverage for upstream-modified paths (senpi#3006)

### What changed

- `packages/ai/src/auth/credential-store.ts`: documentation only; the store comment says an entry may be pooled.
- `packages/ai/src/auth/helpers.ts`: shared auth helpers carried through the v0.99.1 sync and Copilot token re-exchange (senpi#2297).
- `packages/ai/src/auth/types.ts`: auth resolution types — ambient shared-cloud credential chains (senpi#2327), immutable account ids (senpi#1495), and the `ApiKeyAuth.ambientOnly` compatibility marker.

These files were covered by the parent tracker until senpi#2895 added this nearer tracker without listing them, hiding them from the audit's exact-nearest-tracker rule.

### Why

The repository audit requires every upstream-modified production path to be named by an entry in its exact nearest changes.md tracker. senpi#2895 introduced this tracker and named only the two files it touched, so the 3 pre-existing upstream-modified files beneath it lost the coverage the parent tracker had provided and were reported uncovered.

### Why an extension could not handle it

changes.md coverage is fork-owned documentation metadata; no extension or runtime hook can supply it.

### Expected merge conflict zones

- The `ApiKeyAuth` / auth-resolution type fields (ambient markers, account-id metadata) in `packages/ai/src/auth/types.ts`, against upstream auth-contract changes.
- The `rejectedTokenStatuses` passthrough in `packages/ai/src/auth/helpers.ts`, against upstream changes to the OAuth refresh input shape.
- The doc comment in `packages/ai/src/auth/credential-store.ts` (an entry may be pooled), against upstream edits to the same comment; the code is unchanged.

## 2026-10-07 - Preserve transient OAuth exchange failures (senpi#2893)

### What changed

- `packages/ai/src/auth/oauth-refresh.ts`: preserve caller cancellation; log one JSON-encoded provider/optional-slot/closed-cause line per transient exchange without changing stored credentials. JSON encoding prevents object inspection or embedded newlines from splitting the log record.
- `packages/ai/src/auth/resolve.ts`: map transient exchanges to a symbol-branded OAuth ModelsError while preserving permanent errors and message text.

### Why

Transport failures during refresh lost their retryability and ended unattended turns.

### Why an extension could not handle it

Exchange classification and credential resolution happen before provider requests or extension recovery hooks.

### Expected merge conflict zones

- The exchange catch in `oauth-refresh.ts` and error mapping in `resolve.ts`.

## 2026-10-16 - A pool holds one kind of credential (#3448)

### What changed

- `packages/ai/src/auth/pool/slots.ts`: `appendLoginSlot` replaces a stored credential of the other kind instead of appending the login as a slot; the store backs up what it replaces.
- `packages/ai/src/auth/pool/kinds.ts` (new): `slotKind` (only from a slot's own material; a slot with neither tokens nor a key is unclassified) `unusedSlotKinds`, which names the other-kind slots of a mixed pool so the store can report them, and `slotsOfOwnKind`, the slots a credential can project (rotation selects only from these).

### Why

- `packages/ai/src/auth/pool/slots.ts`: slots are projected through the top-level type, so a key slot under an OAuth credential projected to nothing and was never used (omo-desktop-app#2793).

### Why an extension could not handle it

- `packages/ai/src/auth/pool/slots.ts` is the pool algebra every credential write goes through.

### Expected merge conflict zones

- `packages/ai/src/auth/pool/slots.ts`: the start of `appendLoginSlot`.
