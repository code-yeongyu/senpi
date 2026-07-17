# mcp Extension Changes

## Overview
Built-in MCP (Model Context Protocol) client support as an in-tree builtin
extension. Fork-native: upstream pi-mono deliberately ships no MCP support, so
every file under `builtin/mcp/` is fork-owned. Uses the exact-pinned official
`@modelcontextprotocol/sdk` and the public `pi.*` extension API only.

## W5 — skills-carry-MCP, proxy, resources, prompts, elicitation, logging (2026-07-08)

### What changed
- New `skills.ts` (todo 37): skills declare MCP servers via an `mcp.json`
  sidecar (wins) or SKILL.md frontmatter `mcp:` block; declared servers resolve
  through `config.ts#resolveSkillMcpServer` (source `"skill"`, forced
  search-mode/no-directTools = 0 pre-load tokens) and register via
  `service.attachSkillMcpServers`; loading a skill (`/skill:` input or the
  model reading its SKILL.md) reveals includeTools glob matches through the new
  `McpTierBRegistration.activate`.
- New `expose/proxy.ts` (todo 38): `exposure:"proxy"` collapses a server to one
  `mcp_<server>` gateway (search/describe/call, JSON-string args) reusing BM25
  and the factored `register.ts#executeMcpCatalogEntry`; policy gains mode
  `"proxy"`; auto never selects it.
- New `resources.ts` (todo 39): `mcp_list_resources`/`mcp_read_resource`
  utility tools (only when resources exist), `@mcp:<server>/<uri>` input-event
  mention expansion, per-resource subscriptions + updated notifications riding
  the tools-changed refresh.
- New `prompts.ts` (todo 40): listed prompts register as `/mcp:<server>:<prompt>`
  commands (ctx.ui argument collection -> prompts/get -> editor injection).
- New `elicitation.ts` (todo 41): EMPTY `{}` capability declared at client
  construction (`transport.ts#buildMcpClient`), flat-primitive form flow over
  ctx.ui, decline without UI / on URL-mode, bounded cancel timeout.
- New `logging.ts` (todo 42): notifications/message -> per-server logger with
  RFC-5424 mapping, `logLevel` filtering, 10/s burst cap.

### Why
- W5 of the MCP plan: capability surface (skills/resources/prompts/elicitation/
  logging) on top of W4's exposure machinery, reusing the activation path,
  guarded call path, and notification refresh loop instead of new plumbing.

### Expected merge conflict zones
- MEDIUM: `expose/session.ts` / `expose/tier-b.ts` (registration input/return
  shapes grew: proxyGateways, utilityTools, McpSessionRegistration).
- LOW: `connection.ts` connect-time subscriptions; `index.ts` event wiring;
  `service.ts` skill/prompt/resource accessors.

## Rehydration wiring + single-flight attach (2026-07-08)

### What changed
- `expose/tier-b.ts`: `registerMcpTierBTools` now returns a
  `McpTierBRegistration` handle (`searchable` + `rehydrateFromHistory`) instead
  of a bare searchable array; the rehydrate closure replays history activation
  markers through the SAME activation path `tool_search` uses (stub swap +
  stable ordering), skipping already-active names.
- `service.ts`: stores the tier-B handle per registration and exposes
  `rehydrateActiveToolsFromHistory(messages)` plus a once-per-registration
  `maybeRehydrateFromHistory` for per-turn context events. Attach now replays
  session history (via the new optional `sessionManager.getEntries` on
  `McpSessionContext`) right after direct-tool registration, so a resumed
  (`--continue`) session's FIRST wire payload already carries previously
  promoted tools — the per-turn context event replay alone landed one turn
  late because the request tool snapshot precedes it.
- `index.ts`: attach is single-flight. `session_start` handlers are dispatched
  fire-and-forget, so a cold server's attach (awaited catalog collection) could
  still be in flight when `before_agent_start` fired; the old `attached`
  boolean then started a SECOND concurrent attach that registered an empty
  catalog for turn 1. `before_agent_start` now awaits the memoized in-flight
  attach promise. Also subscribes `context` as the rehydration safety net.

### Why
- `rehydrateActiveToolsFromHistory` was exported and unit-tested but never
  invoked from the session lifecycle — resumed sessions lost all promotions
  (W4 real-surface QA driver, CLAIM 5). The double-attach race intermittently
  left ALL MCP tools off the wire for the first turns of any cold session
  (CLAIMs 1/3 flaking). Both were invisible to in-process tests and caught
  only by asserting on captured `body.tools` wire payloads.

### Expected merge conflict zones
- MEDIUM: `service.ts` around `attachSession`/`#registerDirectTools` (W5 will
  touch registration for skills-carry-MCP).
- LOW: `expose/tier-b.ts` return-shape consumers; `index.ts` event wiring.

## W4 implementation — Tier-B adaptive tool exposure + local tool-search (2026-07-08)

### What changed
- New `expose/bm25.ts`: zero-dep BM25 (k1=0.9, b=0.4) over tokenised
  name+description with a server-name field boost; normalised exact-name match
  (hyphen/underscore/case-insensitive) short-circuits before BM25; snake/camel/
  kebab tokenizer; deterministic ranking (tie-break by ascending name).
- New `expose/tool-search.ts`: always-active `tool_search` tool that ranks the
  full catalog and promotes matches via `setActiveTools` (union, stable-sorted,
  effective next turn). Results embed a stable `[tool_search:activated]` marker;
  `rehydrateActiveToolsFromHistory` replays activations after compaction/restart,
  restoring only names still in the catalog.
- New `expose/tier-b.ts`: completes `exposure:"auto"`. A server above
  `searchThreshold` enters SEARCH mode — full catalog registered, only
  directTools active, `tool_search` active. Prompt-cache mitigations: stable
  name sort; activation turns accept a cache miss (default mode); opt-in
  `settings.stubSwap` registers 30-70-token stubs so the tools array is
  length-stable and only the promoted entry's bytes change (stub -> full).
- `expose/policy.ts`: `mode` is now `"direct" | "search"`; the W1 `pending-W4`
  register-all-active fallback + warning is removed. `exposure:"search"|"proxy"`
  and threshold-exceeded resolve to search mode.
- `expose/register.ts`: extracted `mapMcpCatalogNames` so the full-tool builder
  and the Tier-B search catalog share one collision-resolved naming source.
- `expose/session.ts`: registration routes through `registerMcpTierBTools`.
- `expose/status.ts`: `/mcp status` reports total exposed tools + a search-mode
  hint (`N active now, M searchable via tool_search`).
- New `expose/native-search.ts` (todo 33, Anthropic half — spike verdict
  GO-pure-extension): `addAnthropicNativeToolSearch` injects the native
  `tool_search_tool_bm25_20251119` tool + per-tool `defer_loading:true` under
  the HARD RULES (never defer the search tool, never defer+cache_control on one
  tool, >=1 non-deferred, <=10k tools), idempotently per rebuilt request;
  `AnthropicNativeToolSearchAdapter` disables native + falls back to local
  tool_search on an injected 400. `index.ts` registers a `before_provider_request`
  (inject) + `after_provider_response` (400 detector) handler pair — a no-op
  unless `settings.nativeToolSearch` is auto|true and the model is
  anthropic-messages. The OpenAI half is deferred (spike = GO-with-ai-seam;
  needs a feat(ai) seam + sign-off — see native-search-spike.md).
- New `notifications.ts` (todo 35): closes the codex list_changed gap.
  `subscribeMcpListChanged` registers tools/resources/prompts list_changed
  handlers on the SDK client regardless of declared capability (gemini
  robustness); `connection.ts` calls it on every successful connect so
  notifications reach `markToolsChanged`. `createMcpListChangeCoalescer`
  collapses a 300ms burst into one refresh under a max-1/s/server burst guard
  (uses `safeTimer`). `service.ts` wires a per-server coalescer to
  `onToolsChanged` and, on refresh, re-lists + re-registers via
  `registerToolsPreservingActiveSet` so ADDED tools enter INACTIVE (rug-pull
  defense) and REMOVED tools are tombstoned (`buildMcpTombstoneDefinition` — a
  stale execute throws "tool no longer available on <server>"); the delta is
  recorded per server for `/mcp status` (`formatMcpListChangedDelta`).

### Why
Large MCP servers (30+ tools) blow the context budget if every tool is resident.
Tier-B keeps inactive tools at ZERO payload contribution (proven by
before_provider_request/context.tools capture: a 30-tool search-mode server
resides in <1k tokens) while `tool_search` gives the model on-demand access. This
is the provider-agnostic P3 path that ships regardless of the native-search
spike outcome (todo 29).

### Why extension system couldn't handle this alone
Nothing in core needed changing: promotion uses the public
`setActiveTools`/`getActiveTools`/`registerTool` surface and the documented
next-turn activation semantics. `registerToolsPreservingActiveSet` counters the
loader's auto-activation of newly registered tools.

### Expected merge conflict zones
- `expose/policy.ts` (MEDIUM): W1 exposure tests updated to the new search-mode
  behaviour; a concurrent policy edit would collide.
- `expose/session.ts` / `expose/register.ts` (LOW): additive routing + one
  extracted helper.
- `expose/status.ts` (LOW): status line format.

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
