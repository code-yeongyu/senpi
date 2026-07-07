# mcp Extension Changes

## Overview
Built-in MCP (Model Context Protocol) client support as an in-tree builtin
extension. Fork-native: upstream pi-mono deliberately ships no MCP support, so
every file under `builtin/mcp/` is fork-owned. Uses the exact-pinned official
`@modelcontextprotocol/sdk` and the public `pi.*` extension API only.

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
