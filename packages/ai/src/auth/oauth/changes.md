## 2026-10-27 - The hand-rolled Anthropic OAuth (PKCE) flow is removed (senpi#4436, S7)

### What changed

- `packages/ai/src/auth/oauth/anthropic.ts`: deleted (`loginAnthropic`, `loginAnthropicCopyCode`, `refreshAnthropicToken`, `anthropicOAuth`, the browser/copy-code login methods).
- `packages/ai/src/auth/oauth/anthropic-callback-listener.ts`: deleted (the loopback listener on port 53692).
- `packages/ai/src/auth/oauth/authorization-input.ts`, `packages/ai/src/auth/oauth/error-details.ts`: deleted; their only user was `anthropic.ts` (the other providers keep their own local parsers).
- `packages/ai/src/auth/oauth/load.ts`: `loadAnthropicOAuth` and the `anthropic` key of the bundled loaders are removed.

### Why

- senpi#4436, owner ruling R7: Claude sign-in runs only through the bundled Claude Code CLI (`claude auth login`), which keeps and renews its own login. The PKCE direct-login route and all its code, token refresh included, are removed.

### Why an extension could not handle it

- These are pi-ai's own built-in OAuth flow modules and loader registry.

### Expected merge conflict zones

- MEDIUM: an upstream change to `auth/oauth/anthropic.ts` or its listener lands on deleted files; keep them deleted. LOW: the loader type and the removed `loadAnthropicOAuth` in `load.ts`.

## 2026-10-09 - Restore oauth-tracker coverage for upstream-modified paths (senpi#3006)

### What changed

- `packages/ai/src/auth/oauth/load.ts`: the bundled OAuth flow loader registry — the `cursor` flow joined the lazy loader registry and the standalone-Bun static bundle, and the subscription-provider symbol/module renames (senpi#1989) and the Devin CLI login flow were carried through the v0.99.1 sync.
- `packages/ai/src/auth/oauth/openai-codex.ts`: DELETED in the fork — renamed to `packages/ai/src/auth/oauth/chatgpt-subscription.ts` (senpi#1989, fork rename `3c816ead49`) and kept deleted through the v0.99.1 sync. Upstream edits to this path must stay unadopted; port applicable deltas into the `chatgpt-subscription` counterpart instead of resurrecting the file.

These files were covered by the parent tracker until senpi#2895 added this nearer tracker without listing them, hiding them from the audit's exact-nearest-tracker rule.

### Why

The repository audit requires every upstream-modified production path to be named by an entry in its exact nearest changes.md tracker. senpi#2895 introduced this tracker and named only the per-provider token-error modules it touched, so these 2 pre-existing upstream-modified files lost the coverage the parent tracker had provided and were reported uncovered.

### Why an extension could not handle it

changes.md coverage is fork-owned documentation metadata; no extension or runtime hook can supply it.

### Expected merge conflict zones

- LOW: the loader map in `packages/ai/src/auth/oauth/load.ts`, against any other bundled OAuth provider addition.
- HIGH: `packages/ai/src/auth/oauth/openai-codex.ts` is deleted in the fork but still edited upstream — a sync must not resurrect it; port applicable deltas into `packages/ai/src/auth/oauth/chatgpt-subscription.ts` and keep this path deleted.

## 2026-10-07 - Token endpoint errors retain HTTP status (senpi#2893)

### What changed

- `packages/ai/src/auth/oauth/anthropic.ts`: typed HTTP failures and original transport cause on refresh wrappers.
- `packages/ai/src/auth/oauth/chatgpt-subscription.ts`: typed token response errors and preserved fetch cause.
- `packages/ai/src/auth/oauth/cursor.ts`: typed refresh HTTP errors.
- `packages/ai/src/auth/oauth/github-copilot.ts`: typed token endpoint HTTP errors.
- `packages/ai/src/auth/oauth/kimi-coding.ts`: typed refresh HTTP errors, including the existing retry loop's last error.
- `packages/ai/src/auth/oauth/openai-chatgpt.ts`: typed direct token response errors.
- `packages/ai/src/auth/oauth/xai.ts`: typed OAuth request errors.
- `packages/ai/src/auth/oauth/openrouter.ts`: typed key exchange errors; permanent-key refresh remains a no-op.
- `packages/ai/src/auth/oauth/radius.ts`: its existing status-bearing response error extends the shared endpoint error.
- `packages/ai/src/auth/oauth/devin-token.ts`: typed token exchange errors; Devin's no-op refresh remains unchanged.

- `cursor.ts`, `xai.ts`, `radius.ts`, `kimi-coding.ts`: the cancelled/aborted errors they throw when the refresh signal aborts keep `signal.reason` as `cause`. When the shared refresh's 15 s cap fires, that reason is the `TimeoutError`, so the failure classifies transient as it does for the other providers; the message text is unchanged.

- `xai.ts`: an error page that is not JSON (an HTML 503 from a proxy, say) is thrown as `OAuthTokenEndpointError` with its status, so it classifies transient; a 2xx with an unreadable body stays a plain error.
### Why

HTTP status and transport causes must survive provider wrappers so token refresh can distinguish outages from expired grants without matching prose.

### Why an extension could not handle it

The provider's private token exchange constructs these errors before an extension sees them.

### Expected merge conflict zones

- HTTP failure constructors and catch wrappers in the listed provider modules. Existing message text is preserved.

## 2026-10-18 - ChatGPT browser login takes the callback port over instead of dead-ending on "State mismatch." (senpi#3623)

### What changed

- `packages/ai/src/auth/oauth/chatgpt-subscription.ts`: `loginChatGptSubscription` binds the callback through `startChatGptCallback` before building the authorize URL, so `redirect_uri` (and the token exchange) name the port actually bound. PKCE is generated first because `createState()` needs the lazily imported `node:crypto`. The listener is closed on every exit path, including a throw before the wait starts. When no registered port can be bound, the `auth_url` instructions say so and ask for the pasted address instead of promising the browser will finish. `createAuthorizationFlow` became the synchronous `buildAuthorizationUrl(state, challenge, redirectUri, originator)`.
- `packages/ai/src/auth/oauth/callback-server.ts`: an optional `cancelPath` lets a newer login on the machine take the port over (the listener stops waiting for the browser and closes; its login keeps the paste prompt). The takeover is accepted only as a `POST` carrying `x-oauth-callback-cancel: 1` and no `Origin` header; a plain GET (an `<img>` tag), a form POST, or any request from a page gets 403, so a web page cannot stop a waiting login (review LOW 1). A per-login token was rejected because a login in another process cannot know it. The foreign-state page explains that the page belongs to another sign-in and how to finish it.
- `packages/ai/src/auth/oauth/chatgpt-subscription-callback.ts` (fork-only): on EADDRINUSE at 1455 it sends `POST /cancel` with that header once, retries for about 2 s, then tries 1457, matching Codex CLI's `bind_server`. `PI_CHATGPT_OAUTH_CALLBACK_PORTS` overrides the port list (tests).

### Why

Only 1455 and 1457 are registered redirect ports for this client. A second session, an abandoned RPC/desktop login, or an earlier failed attempt kept 1455; the new login's bind failed silently, its URL still pointed at 1455, and the old listener answered "State mismatch." to every retry. Reproduced on main 8ca35d726 with two processes.

### Why an extension could not handle it

The callback listener, its port and the authorize URL are built inside the bundled OAuth flow before any extension hook runs.

### Expected merge conflict zones

- MEDIUM: `loginChatGptSubscription` and the former `createAuthorizationFlow` in `chatgpt-subscription.ts`.
- LOW: the request handler head and the state check in `callback-server.ts`.
