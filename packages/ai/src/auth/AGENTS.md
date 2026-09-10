# packages/ai/src/auth

Generated: 2026-09-10. Commit `2d0fa41c5`. Score 12: shared credential resolution and OAuth boundary.

Credential storage, auth contexts, provider auth resolution, and bundled OAuth flows. Core auth stays browser-safe; Node-only OAuth flow dependencies remain behind loader boundaries.

## FILES

```text
types.ts             Auth contracts: Credential, CredentialStore, ApiKeyAuth, OAuthAuth, AuthContext
context.ts           AuthContext construction; fs access through an injected NodeFsModule shape
credential-store.ts  Default in-memory CredentialStore; apps inject persistent stores; keyed by Provider.id, one entry per provider (an entry may pool sibling slots under `accounts`)
headers.ts           Credential-header contract; case-insensitive (all names lowercased on set and get)
helpers.ts           Standard api-key auth helper: stored credential wins, else first set env var; includes prompt-based login
resolve.ts           Provider auth resolution (credential vs env, OAuth refresh paths)
oauth/               OAuth flows + variable-specifier loader / Bun static-loader injection
pool/                Credential slot projection, HRW selection, failure classification, stream failover
```

## oauth/

```text
load.ts              load*OAuth helpers; registerBundledOAuthFlowLoaders injects Bun's static bundle
pkce.ts              Shared PKCE machinery
device-code.ts       Shared device-code flow
oauth-page.ts        Local callback/result page rendering
anthropic.ts         Anthropic OAuth flow
anthropic-callback-listener.ts Local callback listener
authorization-input.ts       Shared pasted callback/code parsing
error-details.ts     OAuth error-detail formatting
cursor.ts            Cursor OAuth flow
github-copilot.ts    Copilot device flow
kimi-coding.ts       Kimi coding-plan flow
openai-codex.ts      Codex flow
openrouter.ts        OpenRouter flow
radius.ts            Radius flow
xai.ts               xAI flow
```

## INVARIANTS

- Header names are case-insensitive everywhere; never compare raw header keys, go through `headers.ts`.
- One entry per provider id in the store; an entry may pool sibling credential slots under `accounts` while its flat top-level fields stay a valid credential (the downgrade projection older binaries read). Persistent stores are injected by the app, never assumed.
- `oauth/load.ts` normally loads variable specifiers, rewriting `.ts` to `.js` in built output; Bun supplies static flows through `registerBundledOAuthFlowLoaders`. Do not eagerly import flows from browser-reachable code.
- Auth resolution order in `helpers.ts` (stored credential, then env) is load-bearing; don't reorder.
- `oauth/openai-codex.ts` and `oauth/radius.ts` carry `// NEVER convert to top-level imports - breaks browser/Vite builds` on their dynamic imports. Keep both the imports and the comments.
- Public `resolveProviderAuth` delegates to private `resolveProviderAuthWithSignal`; stored credentials own the provider. Failed refresh or an unsupported stored credential type must not fall through to ambient/env auth; explicit request-key overrides are handled separately.
- OAuth refresh double-checks expiry inside `CredentialStore.modify`, persists the rotated credential under that lock, and preserves slot siblings. Auth failures use `ModelsError` codes; cancellation remains signal-driven.
- `slotName` pins resolution to that stored slot: missing slots return undefined, never another account or ambient credentials.
- `pool/failover.ts` rotates only before committed output; after output, `senpi:no-turn-retry:` prevents replay. `pool/select.ts` hashes `key\0slot.name` with the caller's injected hasher and keeps auth blocks until re-login.

## WHERE TO LOOK

| Task | File |
|---|---|
| New OAuth provider flow | `oauth/<provider>.ts`, `oauth/load.ts`, and `../bun-oauth.ts` static bundle |
| Header semantics | `headers.ts` |
| Credential persistence / slot mutations | `credential-store.ts`, `pool/slots.ts` + app-side injected store |
| Account affinity / failover | `pool/select.ts`, `pool/classify.ts`, `pool/failover.ts`; `../../test/credential-pool-*.test.ts` |
| Env-vs-credential precedence | `helpers.ts`, `resolve.ts` |
| Codex auth token helpers shared with `../api/` | `../utils/openai-codex-auth.ts` |
