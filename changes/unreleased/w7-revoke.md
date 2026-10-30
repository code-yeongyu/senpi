<!-- changes-log: packages/ai/src/auth/changes.md -->
## 2026-10-30 - Revoke SIWC sessions before clearing local tokens (part of #5003)

### What changed

- `packages/ai/src/auth/types.ts`: adds the optional OAuth revocation hook, injectable logout backoff, and typed confirmation result.
- `packages/ai/src/auth/credential-store.ts`: invokes revocation outside the storage lock, then clears session tokens while retaining registration metadata and protecting concurrent login writes.
- `packages/ai/src/auth/resolve.ts`: does not refresh a signed-out registration.
- `packages/ai/src/auth/oauth-refresh.ts`: re-checks signed-out state after a stale reader enters shared refresh.

### Why

- `packages/ai/src/auth/types.ts`, `packages/ai/src/auth/credential-store.ts`, `packages/ai/src/auth/resolve.ts`, and `packages/ai/src/auth/oauth-refresh.ts`: SIWC sign-out must end the renewable session, clear local secrets even without remote confirmation, and retain the account/client mapping for a later sign-in.

### Why an extension could not handle it

- `packages/ai/src/auth/types.ts`, `packages/ai/src/auth/credential-store.ts`, `packages/ai/src/auth/resolve.ts`, and `packages/ai/src/auth/oauth-refresh.ts`: the provider hook, serialized credential mutation, and shared request-auth resolution are core auth contracts.

### Expected merge conflict zones

- `packages/ai/src/auth/types.ts`: OAuth hooks and logout options.
- `packages/ai/src/auth/credential-store.ts`: logout orchestration.
- `packages/ai/src/auth/resolve.ts`: stored OAuth resolution before refresh.
- `packages/ai/src/auth/oauth-refresh.ts`: stored-slot view before exchange and compare-and-swap.

<!-- changes-log: packages/ai/src/auth/oauth/changes.md -->
## 2026-10-30 - Implement SIWC renewable-session revocation (part of #5003)

### What changed

- `packages/ai/src/auth/oauth/openai-chatgpt.ts`: discovers the revocation endpoint, posts the refresh token and issued client ID, accepts empty HTTP 200, and bounds network/5xx retries with injectable backoff.

### Why

- `packages/ai/src/auth/oauth/openai-chatgpt.ts`: local token deletion alone does not end the renewable SIWC session.

### Why an extension could not handle it

- `packages/ai/src/auth/oauth/openai-chatgpt.ts`: the bundled provider owns the session's OAuth protocol.

### Expected merge conflict zones

- `packages/ai/src/auth/oauth/openai-chatgpt.ts`: OAuth hook object and token-operation helpers.

<!-- changes-log: packages/ai/src/changes.md -->
## 2026-10-30 - Invoke optional OAuth revocation during logout (part of #5003)

### What changed

- `packages/ai/src/models.ts`: invokes the provider's revocation hook, returns its typed result, blocks new auth during logout, and aborts active provider requests before revocation.

### Why

- `packages/ai/src/models.ts`: every Models logout caller must use the same revocation and local-clear path.

### Why an extension could not handle it

- `packages/ai/src/models.ts`: Models owns provider dispatch and the injected credential store.

### Expected merge conflict zones

- `packages/ai/src/models.ts`: logout orchestration and request auth setup.

<!-- changes-log: packages/ai/CHANGELOG.md -->
### Fixed
- SIWC sign-out revokes renewable sessions with bounded retries and retains registration metadata after clearing local tokens. Unconfirmed remote revocation is returned as a typed result.
