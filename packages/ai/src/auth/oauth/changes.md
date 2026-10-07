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
