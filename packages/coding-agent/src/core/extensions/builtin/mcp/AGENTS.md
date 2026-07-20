# packages/coding-agent/src/core/extensions/builtin/mcp

Fork-native builtin MCP client. Registration #23 in `builtin/index.ts` — kept last so its provider-payload tap observes all co-resident builtin mutations. Entry: `index.ts` exports `default function mcpExtension(pi: ExtensionAPI): void`. `changes.md` is the active fork ledger; every divergence from upstream MCP SDK behavior goes there.

## SUBTREES

- `auth/` OAuth 2.1: discovery, PKCE S256, RFC 8707 resource binding, loopback callback or paste flow. Token store in `auth/token-store.ts`: `<agentDir>/mcp-auth/<sha256(serverUrl)>/tokens.json`, dir 0700, files 0600, cross-process lock via `proper-lockfile`.
- `expose/` Tool naming (`naming.ts`), exposure policy (`policy.ts`), pagination, BM25 search, proxy gateway, schema compat. Tool names: `mcp_<server>_<tool>`, sanitized, 64-char hard cap (`MCP_TOOL_NAME_MAX_LENGTH = 64`), hash suffix on collision.
- `guard/output-guard.ts` Output size limits + spill file creation.

## CONFIG

TypeBox schema in `config-schema.ts`. Config loader in `config.ts`: reads global `<agentDir>/mcp.json`, project `.senpi/mcp.json`, and optional Claude `.mcp.json` (only when `importConfigs` includes `"claude"`). Skill MCP sidecars are a fourth source.

`${VAR}` interpolation only. Command substitution is rejected: values starting with `!` or containing `$(` throw `McpConfigValidationError` at load time.

## COMMANDS AND TRANSPORT

`/mcp` command namespace lives in `commands.ts`. Transport in `transport.ts`: stdio + Streamable HTTP. Stdio command is never shell-evaluated; child spawned with explicit env. Shutdown sequences `reapProcessTree` to reap descendant processes.

## EXPOSURE MODES

Three modes: `direct` (tools register immediately), `search` (full catalog in tier-B, only `directTools` active, `tool_search` promotes on demand), `proxy` (single gateway tool, catalog hidden). `auto` never selects `proxy`; spec evidence: -27.3pp GSM8K structured-output regression (see `policy.ts` comment). Search tool name constant: `TOOL_SEARCH_TOOL_NAME = "tool_search"`.

## ATTACH AND SESSION LIFECYCLE

Attach is **single-flight**: `attachPromise` memoizes the in-flight `attachSession` so `before_agent_start` awaits the original promise rather than starting a second attach that would collect an empty catalog.

**Resumed sessions**: `#rehydrateFromSessionHistory` runs at attach time so the first wire payload already carries previously promoted tools. `maybeRehydrateFromHistory` on the `context` event is a safety-net replay.

**`list_changed`**: Added tools enter INACTIVE (rug-pull defense). Removed tools are force-dropped and tombstoned; stale `execute()` returns a clean `isError`. See `notifications.ts`.

## ELICITATION

`elicitation.ts` implements MCP elicitation as form-only (no free-text). Must work headless and over RPC; the UI provider is injected at `before_agent_start` time via `setMcpElicitationUiProvider`.

## TESTS AND DOCS

Tests: `packages/coding-agent/test/mcp/` (40+ test files by feature).
Docs contract: `packages/coding-agent/docs/mcp.md` + `scripts/check-mcp-docs.test.mjs` (root scripts dir). The doc-check test fails if schema fields diverge from prose.

## ANTI-PATTERNS

- No widened token or log permissions.
- No raw secrets in config values; use `${ENV_VAR}` references.
- Proxy mode is never selected automatically; opt-in only via `exposure: "proxy"`.
- New tools from `list_changed` are never active by default; only `directTools` entries become active immediately.
- Never import from `core/` directly; use `pi.*` API only.
