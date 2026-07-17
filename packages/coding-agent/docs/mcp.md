# MCP (Model Context Protocol)

senpi ships a built-in MCP client. Servers you configure expose their tools,
resources, and prompts to the agent with context-efficient defaults: a large
catalog costs almost nothing until the model actually needs it.

## Quickstart

1. Add a server to `<agentDir>/mcp.json` (global), `.senpi/mcp.json`
   (project), or import from `.mcp.json` (Claude format, via
   `settings.importConfigs`):

```json
{
  "mcpServers": {
    "docs": {
      "command": "npx",
      "args": ["-y", "@example/docs-mcp"],
      "env": { "DOCS_TOKEN": "${DOCS_TOKEN}" }
    }
  }
}
```

2. Start senpi. Run `/mcp` for the status panel, `/mcp status` for a one-line
   summary, `/mcp add <name> <command...>` to add servers interactively.
3. Servers needing OAuth: `/mcp login <name>` (see [Auth](#auth)).
4. Use it: small catalogs register directly; big ones surface through
   `tool_search` (see [Exposure tiers](#exposure-tiers)).

## Configuration reference

Top-level shape: `{ "settings": { ... }, "mcpServers": { "<name>": { ... } } }`.

### Server fields (`mcpServers.<name>`)

### `type`
`"stdio" | "http"`. Default: inferred — `http` when `url` is set, else `stdio`.

### `url`
HTTP(S) endpoint for `type:"http"` servers (Streamable HTTP with SSE fallback).

### `command`
Executable for `type:"stdio"` servers. Never passed through a shell.

### `args`
Argument array for `command`. Default `[]`.

### `env`
Extra environment variables for the child process. Values support `${VAR}`
expansion from the trusted parent environment.

### `cwd`
Working directory for the child process. Default: the session cwd.

### `headers`
Extra HTTP headers for `type:"http"` servers.

### `auth`
`"bearer" | "oauth" | false`. Default: autodetected — `bearerTokenEnv` or an
`Authorization` header implies `bearer`; a 401 from an HTTP server triggers the
OAuth flow. `false` disables auth entirely.

### `bearerTokenEnv`
Name of the environment variable holding a bearer token (the value itself
never lives in config; literal-looking tokens in config produce a warning).

### `oauth`
OAuth tuning: `clientId`, `callbackPort` (default: ephemeral),
`scopes`, `clientMetadataUrl`, `flow` (`"code"` default, or
`"client_credentials"` for headless machine-to-machine).

### `enabled`
Default `true`. Disabled servers stay in config but never spawn.

### `lifecycle`
`"lazy"` (default: connect on first use), `"eager"` (connect at session start),
`"keep-alive"` (eager + 30s pings + automatic reconnect; never idles out).

### `idleTimeoutMin`
Minutes of zero in-flight calls before a connected server is shut down (its
tools stay registered; the next call reconnects transparently). Default `10`.

### `requestTimeoutMs`
Per-request timeout. Default `30000`.

### `connectTimeoutMs`
Connect + initialize handshake timeout. Default `15000`.

### `includeTools`
Glob allowlist (`*` wildcards) over server-side tool names. Default: all.

### `excludeTools`
Glob denylist applied after `includeTools`.

### `directTools`
`true` = every filtered tool active immediately; or an array of names/globs
that stay active while the rest goes behind `tool_search`. Default: none.

### `exposure`
`"auto"` (default), `"direct"`, `"search"`, or `"proxy"`. See
[Exposure tiers](#exposure-tiers). `auto` never selects `proxy`.

### `logLevel`
Minimum RFC-5424 level (`debug`…`emergency`) for the server's
`notifications/message` log stream. Default: record everything (rate-capped).

### Settings fields (`settings`)

### `toolPrefix`
Prefix for registered tool names (`<prefix>_<server>_<tool>`). Default `"mcp"`.

### `searchThreshold`
Filtered-tool count above which `auto` switches a server to search mode.
Default `10`.

### `outputGuard`
Caps on tool/resource output: `maxBytes` (default 51200), `maxLines`
(default 2000), `maxTokens`. Oversized output is truncated with a notice and
the full artifact is written to disk.

### `importConfigs`
`["claude"]` imports `.mcp.json` (Claude Code format) from the project root.
Imported servers require project trust.

### `oauthCallbackUrl`
Override the OAuth loopback callback URL (e.g. behind port forwarding).

### `stubSwap`
Opt-in prompt-cache mitigation for search mode: every inactive tool registers
as a 30-70-token stub so the tools array stays length-stable; activation swaps
the stub for the full schema in place. Default `false`.

### `nativeToolSearch`
`"auto"` (default) | `true` | `false`. On Anthropic models, defers inactive
MCP tools to the provider's native tool-search; any 400 falls back to the
local `tool_search` for the session.

## Exposure tiers

| Tier | When | Cost profile |
|---|---|---|
| direct | `exposure:"direct"`, `directTools:true`, or `auto` at/below `searchThreshold` | Every tool schema on every request |
| search (Tier-B) | `exposure:"search"` or `auto` above the threshold | Full catalog registered, ~135 tokens resident (`tool_search` only); matches promote next turn; promotions survive resume/compaction |
| proxy (Tier-C) | `exposure:"proxy"` only — never `auto` | One `mcp_<server>` gateway tool (`search`/`describe`/`call` with JSON-string args); cheapest, but no provider-side argument validation |

Skills can carry MCP servers too (an `mcp.json` sidecar next to SKILL.md, or a
`mcp:` frontmatter block): those servers register with zero active tools and
reveal their `includeTools` matches when the skill loads. A name collision
with a configured server resolves in favor of your config.

## Resources and prompts

- `mcp_list_resources` / `mcp_read_resource` register automatically when a
  connected server lists resources.
- Mention `@mcp:<server>/<uri>` in your prompt to inline a resource's content
  into the message; unknown or failing mentions are left untouched with a
  notice.
- Every server prompt registers as `/mcp:<server>:<prompt>`; invoking it
  collects the prompt's arguments and drops the rendered text into the editor.
- Servers may ask questions mid-call (elicitation, form mode): senpi walks the
  requested fields through input dialogs; in non-interactive runs the request
  is declined cleanly.

## Auth

- **Bearer**: set `bearerTokenEnv` (recommended) or an `Authorization` header.
- **OAuth (interactive)**: `/mcp login <name>` runs the authorization-code +
  PKCE flow with a loopback callback; tokens persist under `<agentDir>` with
  `0600` permissions and refresh automatically (single-flight across
  processes).
- **OAuth (headless)**: `flow:"client_credentials"` for machine-to-machine, or
  `/mcp login <name> --paste` to complete the code flow by pasting the
  redirect URL from another browser/machine.
- `/mcp logout <name>` clears stored tokens.

## Troubleshooting

| Symptom (`/mcp status`) | Meaning | Fix |
|---|---|---|
| `needs_auth` | 401 and no usable token | `/mcp login <name>` |
| `suspended` | reconnect circuit breaker opened (5 failures/30s) | fix the server, then `/mcp reconnect <name>` |
| `degraded` | transient failure; auto-reconnect with backoff is running | wait, or `/mcp reconnect <name>` |
| tools missing | server filtered/disabled, or hidden behind search | check `includeTools`/`excludeTools`, ask the model to `tool_search` |
| child exits at spawn (EOF) | bad `command`/`args`/`env` | `/mcp logs <name>` shows the captured stderr |
| slow first call | lazy server cold boot | use `lifecycle:"eager"` or `"keep-alive"` |

## Security notes

- Config values never pass through a shell; `${VAR}` expansion only reads the
  trusted parent environment.
- Project-level and imported configs require project trust before servers
  spawn; untrusted entries are listed but inert.
- Tokens are stored `0600` and never logged; server log streams and tool
  output are redacted by the same secret scrubber as the rest of senpi and
  capped by `outputGuard`.

## Disabling MCP entirely

Add the builtin to your settings' disabled list — no other configuration is
needed:

```json
{ "disabledBuiltinExtensions": ["mcp"] }
```
