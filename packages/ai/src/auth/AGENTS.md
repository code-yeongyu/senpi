# packages/ai/src/auth

Generated: 2026-08-24. Commit `baf15a54d`.

Credential storage, auth contexts, provider auth resolution, and bundled OAuth flows. Everything here must stay browser-safe; Node access goes through injected/lazy boundaries only.

## FILES

```text
types.ts             Auth contracts: Credential, CredentialStore, ApiKeyAuth, OAuthAuth, AuthContext
context.ts           AuthContext construction; fs access through an injected NodeFsModule shape
credential-store.ts  Default in-memory CredentialStore; apps inject persistent stores; keyed by Provider.id, one entry per provider (an entry may pool sibling slots under `accounts`)
headers.ts           Credential-header contract; case-insensitive (all names lowercased on set and get)
helpers.ts           Standard api-key auth helper: stored credential wins, else first set env var; includes prompt-based login
resolve.ts           Provider auth resolution (credential vs env, OAuth refresh paths)
oauth/               Bundled OAuth flow implementations + loader registry
```

## oauth/

```text
load.ts              registerBundledOAuthFlowLoaders(loaders) — registry of per-provider flow loaders
pkce.ts              Shared PKCE machinery
device-code.ts       Shared device-code flow
oauth-page.ts        Local callback/result page rendering
anthropic.ts         Anthropic OAuth flow
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
- OAuth flows register through `registerBundledOAuthFlowLoaders`; don't import flow modules eagerly from browser-reachable code.
- Auth resolution order in `helpers.ts` (stored credential, then env) is load-bearing; don't reorder.
- `oauth/openai-codex.ts` and `oauth/radius.ts` carry `// NEVER convert to top-level imports - breaks browser/Vite builds` on their dynamic imports. Keep both the imports and the comments.
- `resolveProviderAuth` / `resolveProviderAuthWithSignal` in `resolve.ts` is the cross-provider choke point (credential, env, OAuth refresh, error paths); it raises `ModelsError` with a `ModelsErrorCode`, not bare `Error`.

## WHERE TO LOOK

| Task | File |
|---|---|
| New OAuth provider flow | `oauth/<provider>.ts` + register in `oauth/load.ts` |
| Header semantics | `headers.ts` |
| Credential persistence | `credential-store.ts` + app-side injected store |
| Env-vs-credential precedence | `helpers.ts`, `resolve.ts` |
| Codex auth token helpers shared with `../api/` | `../utils/openai-codex-auth.ts` |
