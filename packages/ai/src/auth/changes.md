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
