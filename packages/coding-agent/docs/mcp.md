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

2. Start senpi. Run `/mcp` for the interactive server manager, `/mcp status` for a one-line
   summary, `/mcp add <name> <command...>` to add servers interactively.
3. Servers needing OAuth: `/mcp auth <name>` (see [Auth](#auth)).
4. Use it: small catalogs register directly; big ones surface through
   `tool_search` (see [Exposure tiers](#exposure-tiers)).

## Interactive manager

`/mcp` lists servers with their connection state, tool and available resource
counts, exposure mode, and configuration source. Select a server to inspect its
tools, details, or logs; test or reconnect it; or sign in/out when OAuth applies.
The list updates when connections and catalogs change and preserves selection.
Navigation, confirmation, and cancellation use your configured keybindings.

Enable/disable and exposure changes are saved to the selected server's global
or trusted project `mcp.json`. Imported, skill-owned, extension-owned, and
untrusted definitions are read-only in this manager. OAuth actions close the
manager before running the existing authorization flow, keeping its notices
visible. Outside the TUI, `/mcp` reports status through the existing notification
channel; existing subcommands remain available.

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
Argument array for `command`. Default `[]`. An entry may be a
[reference object](#reference-objects).

### `env`
Extra environment variables for the child process. Values support `${VAR}`
expansion from the trusted parent environment. The child does not inherit your
whole environment: it sees only `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`
and `USER` (on Windows, the system path and profile variables) plus `env`,
so pass every variable the server reads through `env`. A value may also be a
[reference object](#reference-objects).

### `cwd`
Working directory for the child process. Default: the session cwd.

### `headers`
Extra HTTP headers for `type:"http"` servers. A value may be a
[reference object](#reference-objects).

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

### `startupTimeoutMs`
Bounded startup window (ms) that a server's first connect + catalog fetch is
raced against during session attach. A server that does not settle inside the
window keeps connecting in the background and surfaces its tools when ready, so
a slow or wedged server never blocks the first turn. Default `250`. Set higher
to wait for tools before the first turn, `0` to never wait. The
`SENPI_MCP_STARTUP_TIMEOUT_MS` environment variable overrides this for every
server.

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

### Reference objects

A `headers`, `env` or `args` value can point at a secret instead of holding
it. A reference object takes the place of the whole string:

```jsonc
{ "$file": "~/.creds/token" }                              // absolute, ~/ (home), or relative to this mcp.json
{ "$env": "TOKEN" }                                        // a valid variable name
{ "$concat": ["Bearer ", { "$file": "~/.creds/token" }] }  // strings plus $file/$env, one level only
```

- **Where.** Only `headers.*`, `env.*` and `args[]`. `url`, `command`, `cwd`
  and `oauth` refuse them, and text such as `"Bearer {file:~/k}"` inside a
  string stays literal. Put secrets in `env.*` or `headers`, not `args[]`:
  resolved arguments are visible in the server's process list.
- **Redaction.** Every resolved value is treated as sensitive for the process
  lifetime, including rotated values and non-secret values such as paths.
  These values are redacted from outbound text, including tool results,
  logs and status. Values shorter than four characters are not redacted.
  In structured data, only string values are redacted; keys, numbers,
  booleans, null and array/object shape stay intact. A protocol field keeps
  its value only when the value exactly matches a fixed list: a content-block
  or schema `type`, a common media type in `mimeType` (for example
  `image/png`), a schema `format`, `jsonrpc: "2.0"`, a `role` of `user` or
  `assistant`, or a published JSON Schema draft URL in `$schema`. Anything
  else in those fields, including an unlisted media type, is redacted like
  any other string.
- **Who.** A reference is read exactly where `${VAR}` would expand: your own
  `mcp.json`, a trusted project's `mcp.json` and imported `.mcp.json`, and
  stdio servers of skills you own. A remote skill server, a skill of an
  untrusted project and a server an extension declares refuse it before
  anything is read: the server is skipped with a message naming the field.
  An untrusted project's own `mcp.json` stays inert until you trust the
  project, as it does today.
- **When.** Each connection, reconnects included, reads the current value, so
  a rotated file is picked up without restarting senpi. Contents are never
  cached.
- **Files.** A regular file owned by you or root, at most 64 KiB of UTF-8 text
  (surrounding whitespace is trimmed), not writable by group or others, with
  no directory above it writable by another user (a sticky directory passes
  only for an entry you or root own). A file other users can read still works,
  with a one-time warning. On Windows the owner, mode and ancestor checks are
  skipped (ACLs are not inspected); the type, size and UTF-8 checks still run.
- **Variables.** `$env` reads the session environment. The value is used as
  plain text and never re-scanned: a variable whose value looks like
  `{file:...}` is not followed, and senpi warns once, naming the variable but
  never its value.
- **Failures.** A missing, empty, unreadable, non-regular, oversized or
  non-UTF-8 file, or an unset or empty variable, is a named error such as
  `mcpServers.docs.headers.Authorization: configuration reference missing`.
  Only that server stops; the others keep working, and no partial value is
  ever sent.

Differences from OpenCode: references are JSON objects rather than
`{file:...}`/`{env:...}` text, an environment variable's value is never
re-scanned for another reference, and URL fields take no references.

Tools that write these objects for you, such as `omo setup`, should first
check that the installed engine reads them: its `package.json` declares
`"senpiCapabilities": { "configReferenceObjects": 1 }` (or a higher number).
An older engine lacks the field and may pass an object through without
validating it.

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

> **Note:** `tool_search` is a shared catalog tool that covers both MCP servers and native extension tools. When filtering searches, the legacy MCP `server` parameter is mapped to the shared `group` parameter.

| Tier | When | Cost profile |
|---|---|---|
| direct | `exposure:"direct"`, `directTools:true`, or `auto` at/below `searchThreshold` | Every tool schema on every request |
| search (Tier-B) | `exposure:"search"` or `auto` above the threshold | Full catalog registered, ~135 tokens resident (`tool_search` only); matches promote next turn; promotions survive resume/compaction |
| proxy (Tier-C) | `exposure:"proxy"` only — never `auto` | One `mcp_<server>` gateway tool (`search`/`describe`/`call` with JSON-string args); cheapest, but no provider-side argument validation |

Skills can carry MCP servers too — see
[Skill-carried MCP servers](#skill-carried-mcp-servers).

### Server sources

Servers are merged from these sources, in precedence order:

- `global` — `<agentDir>/mcp.json`
- `claude` — imported `.mcp.json` (requires project trust)
- `project` — `.senpi/mcp.json` (requires project trust)
- `extension` — declared by an extension via `pi.registerMcpServer()` during
  factory load (see [extensions.md](extensions.md#piregistermcpservername-config))
- `skill` — declared in a skill's `mcp.json` sidecar or SKILL.md frontmatter

A name collision resolves as follows: trusted user config (including an
`enabled: false` entry) wins over extension declarations; an extension
declaration replaces an untrusted placeholder and records a diagnostic.
Extension-declared servers use bare names (no prefix).

## Skill-carried MCP servers

A skill can bundle the MCP servers it needs, so the workflow and its tools
travel as one package. Skill-declared servers register lazily with **zero
active tools** — they cost no prompt tokens until the skill loads. Loading the
skill (a `/skill:<name>` command, or the model reading its SKILL.md) reveals
the tools matching its `includeTools` globs for the rest of the session.

Two declaration forms exist; the sidecar wins when both are present.

**`mcp.json` sidecar** (Amp-compatible) next to SKILL.md. Servers accept the
same fields as [`mcpServers.<name>`](#server-fields-mcpserversname), plus
`includeTools`:

```json
{
  "mcpServers": {
    "exa": {
      "command": "npx",
      "args": ["-y", "exa-mcp-server"],
      "env": { "EXA_API_KEY": "${EXA_API_KEY}" },
      "includeTools": ["web_search*"]
    }
  }
}
```

The `mcpServers` wrapper is optional — a bare server-name map works too.
When you installed the skill, `${EXA_API_KEY}` expands from your environment
exactly as it would in your own `mcp.json`; see
[Environment variables in skill servers](#environment-variables-in-skill-servers).

**Frontmatter `mcp:` block** in SKILL.md:

````markdown
---
name: exa-search
description: Web search via Exa. Use for finding current documentation.
mcp:
  exa:
    command: npx
    args: ["-y", "exa-mcp-server"]
    env:
      EXA_API_KEY: ${EXA_API_KEY}
    includeTools: ["web_search*"]
---
````

Semantics:

- `includeTools` is a glob allowlist (`*` wildcards) over server-side tool
  names; default `["*"]` (every tool). Skill servers are forced into search
  mode with no `directTools`, so nothing is active before the skill loads
  regardless of any declared `exposure`.
- Several skills declaring the same server name: the first configuration
  wins; `includeTools` union-merges across the declaring skills, and loading
  any one of them reveals the merged matches.
- A name collision with a configured server resolves in favor of your config,
  so a skill never overrides a server you already trust.
- An unreadable sidecar or frontmatter `mcp:` block is skipped with a
  warning; the skill itself still loads.
- There is no unload signal: tools revealed by a skill stay active until the
  session ends.

### Environment variables in skill servers

`${VAR}` expansion follows the trust of the skill that declares the server,
the same line senpi draws for `mcp.json` files:

- **Skills you own** (your user skills directory, packages you installed, and
  the skills of a project you trusted): stdio `command`, `args`, `env` and
  `cwd` expand exactly like your own `mcp.json`, including `${VAR:-default}`
  and the refusal of command substitution (a server asking for `$(...)` or a
  leading `!` is skipped with a warning).
- **Skills of an untrusted project, without a grant**: nothing expands. The placeholder stays
  literal and senpi warns once, naming the skill and the variable; trust the
  project or declare the server in your own `mcp.json` to expand it. A cloned
  repository must not be able to hand `AWS_SECRET_ACCESS_KEY` to a command it
  chose.
- **Remote servers from any skill, without a project declaration grant**: `url` and `headers` never expand, and
  `bearerTokenEnv` is ignored, so no `Authorization` header is sent. Expanding
  them would send your secrets to a server the skill picked. senpi warns once
  per server; declare the server in your own `mcp.json`, where variables and
  `bearerTokenEnv` keep working.

Project-provenance skills also have a declaration-scoped environment policy.
Their child environment is assembled in this order, with later values winning:
the finite safe ambient base (paths, home, temp, listed locale and platform
variables, and CA paths), ambient names granted to this declaration,
explicit `McpSessionOptions.env`, then declared `env` values. Proxies and
unlisted locale names require grants. Ambient npm/yarn/pnpm metadata stays
excluded; explicit and declared values are not removed.
User-provenance skills keep the existing SDK defaults and merge behavior.

When a project declaration references a withheld name, the TUI or an RPC client
advertising `grant_select` offers **Grant and save permanently** and **Start
without them**. A grant re-resolves only those `${VAR}` references and restores
that declaration's `bearerTokenEnv`, including remote declarations. Other
references retain the trust rules above. Cancel, disconnect, the second choice
and the 120-second deadline save nothing. Headless and question-only clients
start with the filtered environment and a names-only warning.

Grants are stored in `<configured-agent-dir>/mcp-env-grants.json`. The exported
`@code-yeongyu/senpi/mcp-env-grants` module accepts the resolved config directory;
without an explicit directory its resolver defaults to
`$XDG_CONFIG_HOME/omo/mcp-env-grants.json` or `~/.config/omo/mcp-env-grants.json`.
The shared schema is `{version:1,generation,grants}`, where each SHA-256
declaration key maps to `{label:{project,skill,server},names}`. It stores names,
never values. Identity covers canonical source path, source kind, project root,
server name, the complete raw declaration and canonical session cwd.
Changing a declaration requires a new grant; rotating an ambient value does not.

Writes lock, merge, fsync and atomically rename the file. Live native hosts watch
the directory and reconcile at least every five seconds. Changed grant sets
invalidate existing transports, including shared children. Invalid reads,
counter rollback, uncertain replacement and skipped generations conservatively
invalidate live project connections; subsequent materialization reads current
grants again. The store keeps no change history.

[Reference objects](#reference-objects) follow the same line: the stdio
servers of skills you own may use them. A project skill's server (trusted or
not) and every remote skill server are skipped when they declare one, because
the project environment policy below expands only plain `${VAR}` strings. The refusal follows the
skill's recorded provenance; a skill loaded without one keeps the trust rules
above.

## Resources and prompts

MCP 2026-07-28 tool schemas use JSON Schema 2020-12 by default. Explicit
2020-12 declarations are supported; other dialect declarations produce
`MCP_SCHEMA_UNSUPPORTED_DIALECT`. Tool discovery, the disk cache, and MCP
exposure retain the full schema, including `$defs`, `$ref` siblings, and
`additionalProperties`. Boolean roots use an equivalent `allOf` container
at the object-shaped model-tool API boundary.

Modern structured results may be any JSON value, including `null`, `false`,
and `0`. Successful results with an `outputSchema` must contain conforming
`structuredContent`; execution-error results are exempt. Validation never
coerces values, inserts defaults, removes properties, or fetches references
from the network. Unresolved references are rejected. Schemas are bounded
to 64 nesting levels and 16,384 JSON nodes; `format` is an annotation.

Object-only model providers may require a lossy schema adaptation in the AI
provider layer. That wire adaptation does not change MCP's source schema
or the arguments sent to the server: modern calls validate the model's
arguments without coercion. Legacy connections retain the SDK's existing
schema validation and compatibility conversion.

- `mcp_list_resources` / `mcp_read_resource` register automatically when a
  connected server lists resources.
- Mention `@mcp:<server>/<uri>` in your prompt to inline a resource's content
  into the message; unknown or failing mentions are left untouched with a
  notice.
- Every server prompt registers as `/mcp:<server>:<prompt>`; invoking it
  collects the prompt's arguments and drops the rendered text into the editor.
- Legacy servers may ask form questions mid-call through the existing terminal
  or RPC dialog channel.
- On MCP 2026-07-28 connections, `tools/call`, `resources/read`, and `prompts/get`
  can return `input_required`. Senpi collects form input privately in the
  originating terminal session, lets you review and edit it, and continues the
  operation with a new request ID. Only the final result reaches the model or editor.
  Continue does not submit a form: even empty forms require Submit. Decline is
  an explicit human refusal; dismissal of a presented form is Cancel.
- RPC, print, and other runs without an originating terminal presenter do not
  advertise modern elicitation. An unsolicited input request terminates the
  operation locally without fabricating an answer or retrying incomplete input.
  State-only continuations need no human and remain supported.
- Each operation allows eight input rounds and five minutes of total consent
  time, including queueing. The overall deadline also includes network time
  and cannot be extended by progress. Caller cancellation, session closure,
  or observed authorization invalidation dismisses pending input without a retry.
  Authorization uses the same observed-revocation boundary as ordinary MCP
  requests. Unsupported client features terminate locally.
- Continuation state and drafts are not persisted or resumed after restart.
  MRTR does not enable the Tasks extension.

## Auth

- **Bearer**: set `bearerTokenEnv` (recommended) or an `Authorization` header.
- **OAuth (interactive)**: `/mcp auth <name>` opens the browser for the
  authorization-code + PKCE flow after the loopback callback is ready. The
  complete authorization URL stays in the transcript if the browser cannot
  open, so you can open it manually. Tokens persist under `<agentDir>` with
  `0600` permissions and refresh automatically (single-flight across
  processes).
- **OAuth (headless)**: `flow:"client_credentials"` for machine-to-machine, or
  `/mcp auth-start <name>` to obtain an authorization URL, followed by
  `/mcp auth-complete <name> <redirect-url>` to paste the final redirect URL
  from another browser/machine in the same session.
- `/mcp logout <name>` clears stored tokens.

## Troubleshooting

| Symptom (`/mcp status`) | Meaning | Fix |
|---|---|---|
| `needs_auth` | 401 and no usable token | `/mcp auth <name>` |
| `suspended` | reconnect circuit breaker opened (5 failures/30s) | fix the server, then `/mcp reconnect <name>` |
| `degraded` | transient failure; auto-reconnect with backoff is running | wait, or `/mcp reconnect <name>` |
| tools missing | server filtered/disabled, or hidden behind search | check `includeTools`/`excludeTools`, ask the model to `tool_search` |
| child exits at spawn (EOF) | bad `command`/`args`/`env` | `/mcp logs <name>` shows the captured stderr |
| slow first call | lazy server cold boot (tools attach in the background) | raise `startupTimeoutMs`, or use `lifecycle:"eager"` / `"keep-alive"` |

## Security notes

- Config values never pass through a shell; `${VAR}` expansion only reads the
  trusted parent environment, and only for trusted sources: your own and a
  trusted project's config, and stdio servers of skills you own. Skill remote
  servers only expand variables or send `bearerTokenEnv` after a project declaration grant (see
  [Environment variables in skill servers](#environment-variables-in-skill-servers)).
- Project-level and imported configs require project trust before servers
  spawn; untrusted entries are listed but inert.
- Tokens are stored `0600` and never logged; server log streams and tool
  output are redacted by the same secret scrubber as the rest of senpi and
  capped by `outputGuard`.
- Every value a [reference object](#reference-objects) resolves to, rotated
  ones included, is removed (raw and URL-encoded) from MCP logs, the catalog
  cache, server status, RPC snapshots, diagnostics and `/mcp` errors, as well
  as tool and resource results, progress and spill files. Model-facing results
  are sanitized too: provider requests leave the process. Values
  sent back to a server, such as a resource URI it listed, keep their exact
  bytes.
- Config and catalog identities are HMAC-SHA-256 under a private
  per-installation key, `config-identity.key` in the agent directory, created
  once with mode `0600` and never replaced. Without a valid key, nothing keyed
  is persisted.

## Disabling MCP entirely

Add the builtin to your settings' disabled list — no other configuration is
needed:

```json
{ "disabledBuiltinExtensions": ["mcp"] }
```
