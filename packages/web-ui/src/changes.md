# changes

## ClinePass browser key validation (2026-07-31)

### What changed

- `utils/proxy-utils.ts`: `shouldUseProxyForProvider()` returns `true` for `cline-pass`.
  `api.cline.bot` only allows Cline's own browser origin, so a direct request from the web UI is
  rejected by CORS.
- `components/ProviderKeyInput.ts`: added the `cline-pass` entry to `TEST_MODELS`
  (`cline-pass/kimi-k3`). Without it `testApiKey()` hits its `if (!modelId) return true` branch and
  reports any string as a valid key instead of validating it.

### Why

- These are the two places the browser UI needs to know a provider exists: how to reach it, and which
  model to probe when the user pastes a key. Both are single-entry additions to existing per-provider
  maps.

### Why an extension couldn't handle this

- This package is browser-only Lit components with no extension host; the maps are module-level
  constants consumed directly by the components.

### Known limitation (pre-existing, not introduced here)

- `applyProxyIfNeeded()` returns the unproxied model when no proxy URL is configured, before
  consulting `shouldUseProxyForProvider()`. With the proxy setting off, a valid ClinePass key is
  therefore reported as invalid rather than surfacing "this provider requires the CORS proxy".
  `zai` has behaved this way since b6b64dff8; ClinePass joins that existing class. Fixing it means
  changing the shared no-proxy path for every proxy-required provider, which does not belong in a
  provider addition.

### Expected merge conflict zones

- LOW: one `case` arm in `shouldUseProxyForProvider()` and one entry in `TEST_MODELS`.
