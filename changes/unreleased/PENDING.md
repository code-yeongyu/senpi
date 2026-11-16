<!-- changes-log: packages/ai/src/providers/changes.md -->
## 2026-11-16 - Shared helper for listing the gated Anthropic releases an account's /v1/models returns

### What changed

- `packages/ai/src/providers/anthropic-listed-models.ts` (new): `fetchAnthropicModelIds` pages through `GET https://api.anthropic.com/v1/models` (`limit=1000`, `after_id`) for the credential in its headers; a 401/403 lists nothing, any other failure throws. `listedAnthropicModels` maps listed ids to rows: a catalogued id as shipped, an uncatalogued `claude-mythos-5[-N]` id derived from the `claude-fable-5[-N]` row of the same version (own id, name `Claude Mythos 5.N`, sibling context, max tokens, thinking map, input, prompt cache and compat, without the sibling's `allowedFallbackModels`, cost marked `unknown`), anything else dropped.
- The `anthropic` (API key) provider is unchanged: giving it `refreshModels` would take it out of the pi.dev remote-catalog overlay, so this change lists gated releases only on the subscription lane.

### Why

- Claude Mythos 5.2 / 5.1 is the model behind Claude Fable 5.2 / 5.1, offered only to organizations approved through Anthropic's verification programs. The generated catalog (models.dev) has no Mythos rows, so a verified account could never select it. Accounts without access get no Mythos ids from `/v1/models` and see no change.
- Anthropic rejects Mythos as a server-side fallback target for Fable, so the fallback pairs Anthropic verified for Fable are not assumed for Mythos.

### Why an extension could not handle it

- The helper derives rows from the generated Anthropic catalog, which lives in this package; the subscription extension consumes it through the `./providers/*` subpath.

### Expected merge conflict zones

- NONE: new fork-only file.

<!-- changes-log: packages/coding-agent/src/core/extensions/builtin/anthropic-subscription/changes.md -->
## 2026-11-16 - The subscription lane lists the gated releases its accounts' /v1/models returns

### What changed

- `packages/coding-agent/src/core/extensions/builtin/anthropic-subscription/listed-models.ts` (new): `listAccountModelIds` asks `GET /v1/models` with every lane account's current token (the `CLAUDE_CODE_OAUTH_TOKEN[_N]` token or the claude CLI account's stored access token, beta `oauth-2025-04-20`) and returns the union. No account with a token: undefined. Every request failed: throws.
- `packages/coding-agent/src/core/extensions/builtin/anthropic-subscription/index.ts`: `anthropicSubscriptionModels(longContext, listedIds)` merges `listedAnthropicModels` into the catalog. The provider config gains `refreshModels`: with network it lists the accounts' models and persists the gated rows it added; without network it restores the ids from the stored entry.
- `packages/coding-agent/src/core/subscription-limits/usage-accounts.ts`: `claudeAccounts` is exported and takes the sources without the credential store, so the listing reads tokens exactly as the usage poll does.

### Why

- A Claude subscription on a verified organization lists `claude-mythos-5-2` / `claude-mythos-5-1` from `/v1/models`; the lane's models are the shipped `anthropic` catalog, which has no Mythos rows.

### Why an extension could not handle it

- This is the builtin extension's own provider registration.

### Expected merge conflict zones

- LOW: `anthropicSubscriptionModels` and the `models` / `refreshModels` entries of `providerConfig` in `index.ts`; the `claudeAccounts` signature in `usage-accounts.ts`.

<!-- changes-log: packages/ai/CHANGELOG.md -->
### Added
- `providers/anthropic-listed-models`: `fetchAnthropicModelIds` pages an account's `/v1/models`, and `listedAnthropicModels` derives a row for a listed gated release (Claude Mythos 5.N) from the Fable row of the same version

<!-- changes-log: packages/coding-agent/CHANGELOG.md -->
### Added
- `anthropic-subscription` lists the Claude Mythos releases its accounts' `/v1/models` returns (verified organizations), so they can be selected; other accounts see no change
