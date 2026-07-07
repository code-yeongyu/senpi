# mcp Extension Changes

## Overview
Built-in MCP (Model Context Protocol) client support as an in-tree builtin
extension. Fork-native: upstream pi-mono deliberately ships no MCP support, so
every file under `builtin/mcp/` is fork-owned. Uses the exact-pinned official
`@modelcontextprotocol/sdk` and the public `pi.*` extension API only.

## W3 implementation — OAuth 2.1 + token store + bearer/header auth (2026-07-07)

### What changed
- New `builtin/mcp/auth/` subtree implementing spec §7 auth end-to-end:
  - `token-store.ts`: URL-bound credential store at
    `<agentDir>/mcp-auth/<sha256(serverUrl)>/tokens.json` (dir 0700, file 0600),
    atomic tmp+rename writes, cross-process `proper-lockfile` read-modify-write
    (`update`/`withLock`/`writeUnlocked`), `index.json` name→hash map, and
    `clear()`. No keychain (headless-first).
  - `oauth-provider.ts`: SDK `OAuthClientProvider` backed by the store — PKCE
    verifier + client info + tokens persistence, single-use CSRF `state`,
    RFC 8707 `validateResourceURL`, `invalidateCredentials`, token fingerprint
    logging.
  - `oauth-refresh.ts`: preemptive refresh at expiry−5min with in-process
    single-flight + cross-process lock; `assertS256Supported` (typed refusal);
    `invalid_grant`→drop→needs_auth vs transient→bounded-retry distinction.
  - `oauth.ts`: discovery (RFC 9728→8414→OIDC) + S256 pre-flight refusal,
    `beginAuthorization`/`completeAuthorization`/`finishAuthorization`,
    `clientCredentialsGrant`, `logout`.
  - `callback.ts`: lazy 127.0.0.1 loopback listener (OS or fixed port with
    fail-fast on conflict), single-use state, 5-min unref'd timeout,
    `openCallbackChannel` with `oauthCallbackUrl` override → zero listeners.
  - `context.ts`: `resolveAuthMode` (#158 autodetect: headers/explicit disable
    OAuth), `resolveServerAuth` provider factory, `detectLiteralBearerWarnings`.
  - `commands-auth.ts` + `commands-auth-dispatch.ts`: `/mcp auth`,
    `auth-start`, `auth-complete <redirect-url>`, `logout`, client_credentials;
    non-UI callers fail fast with a headless hint (no browser).
  - `oauth-errors.ts`: typed `OAuthFlowError` (terminal vs transient kinds).
- Wired into existing extension files: `transport.ts` (attach `authProvider`
  to the HTTP transport; inject `OAUTH_ACCESS_TOKEN` for stdio OAuth),
  `connection.ts` (map `UnauthorizedError`/terminal `OAuthFlowError` →
  `needs_auth` by unwrapping the wrapped connect cause), `service.ts` +
  `service-types.ts` (build the auth plan per server, store it on the
  connection entry, expose `getAuthTarget`/`getPendingAuth`),
  `connection-types.ts` (`authProvider` option), `commands.ts` (auth
  subcommands).

### Why
- Spec §7 requires OAuth 2.1 (PKCE S256, RFC 8707, discovery, headless flows)
  with a 0600 file token store and a cross-process refresh lock so concurrent
  senpi processes never trigger refresh-token-family invalidation.

### Why extension system couldn't handle this alone
- Not applicable — implemented entirely with the SDK + public `pi.*` API; no
  core-tree edits outside `builtin/mcp/`.

### Expected merge conflict zones
- `builtin/mcp/transport.ts` — LOW (added `authProvider` option + stdio env
  injection; additive).
- `builtin/mcp/connection.ts` / `connection-types.ts` — LOW (added optional
  `authProvider` + a needs_auth branch in the connect catch).
- `builtin/mcp/service.ts` / `service-types.ts` — LOW/MEDIUM (auth-plan
  construction in the connection-creation loop + new accessors).
- `builtin/mcp/commands.ts` — LOW (added auth subcommands to the dispatch).
- `builtin/mcp/changes.md` — LOW (union of entries).

## W1 implementation — config, transports, service, tools, commands (2026-07-07)

### What changed
- Filled the 2026-07-06 no-op skeleton (`extensions/changes.md`) with the full
  W1 implementation across `builtin/mcp/`:
  - `config-schema.ts` / `config.ts` / `config-edit.ts`: TypeBox-validated
    `mcpServers` config with discovery and merge across global, project, and
    imported Claude Desktop configs (`settings.importConfigs: ["claude"]`),
    env-var interpolation, per-server enable/disable, and project-trust gating
    (untrusted projects cannot activate project-scoped servers).
  - `transport.ts`: transport factory for `stdio` (spawned command, default
    environment, spec-conformant shutdown, child process reaping via
    `process-tree.ts`) and `http` (StreamableHTTP client transport).
  - `connection.ts`: per-server connection state machine with connect timeouts
    and async error routing through `wrap.ts` guards.
  - `service.ts`: process-owned singleton service that attaches sessions,
    owns server lifecycle (`lazy` / `eager` / `keep-alive`, idle shutdown),
    surfaces connect failures, and refreshes after extension reloads.
  - `expose/`: tool registration end-to-end with spec-correct call semantics
    (`register.ts`, `naming.ts`, `pagination.ts`, `schema-compat.ts`,
    `session.ts`, `status.ts`) plus the exposure policy (`policy.ts`):
    `auto` / `direct` / `search` / `proxy`, `includeTools` / `excludeTools`
    filtering, `directTools`, and the `searchThreshold` cutoff. Inactive tools
    are cleared after policy filtering.
  - `commands.ts` / `status.ts`: the `/mcp` command suite — `status`, `add`,
    `enable` / `disable`, `test`, `logs`, `reconnect` — with tool refresh after
    `add`.
  - `instructions.ts`: MCP server `instructions` are injected into the system
    prompt through `before_agent_start` and refreshed on session start.
  - `log.ts` / `errors.ts` / `wrap.ts`: per-server logging with secret
    redaction (authorization headers, error payloads, wrap fallbacks), an MCP
    error taxonomy, and async wrap utilities so background failures surface
    without leaking secrets.
  - `catalog.ts` / `active-set.ts`: resolved-server catalog and active tool
    set bookkeeping.
- `builtin/index.ts`: the `mcp` entry registered by the skeleton is unchanged
  (kept last so its provider-payload tap observes all co-resident builtin
  mutations).
- Auth: `bearer` (via `bearerTokenEnv`) and `oauth` (authorization-code and
  client-credentials flows, optional `clientMetadataUrl` / `scopes` /
  `oauthCallbackUrl`) per server.

### Senpi design decisions
- MCP is a builtin extension, not core: pi philosophy keeps MCP out of the
  core runtime, and the fork honors that boundary — everything reaches the
  session through `registerTool`, `registerCommand`, and event handlers.
- The service is process-owned (not session-owned) so keep-alive servers and
  their child processes survive session reloads and are reaped exactly once.
- Output guards (`settings.outputGuard`: `maxBytes` / `maxLines` /
  `maxTokens`) bound tool results before they reach the model context.
- Search-based exposure exists to keep large MCP catalogs from flooding the
  tool list; `settings.nativeToolSearch` can defer to provider-native tool
  search where available.

### Why extension system couldn't handle this differently
- Implemented entirely as a builtin extension via the public `pi.*` API
  (`registerTool`, `registerCommand`, `session_start`, `before_agent_start`,
  `session_shutdown`). No change to `extensions/types.ts` or `runner.ts`.

### Expected merge conflict zones on next upstream sync
- LOW: `builtin/index.ts` import block + `builtinExtensions` array if upstream
  reorders or adds builtins.
- LOW: `packages/coding-agent/package.json` around the exact-pinned
  `@modelcontextprotocol/sdk` dependency.
- NONE for `extensions/types.ts` (untouched); `builtin/mcp/` itself does not
  exist upstream.
