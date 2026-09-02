# RPC Mode

Shared-host clients may advertise the `rendered_components` capability to receive factory-rendered widget, header, and footer records. In a shared session, component rendering uses the minimum width reported by currently attached connections, defaulting to 80 when none report a width; disconnected connections no longer contribute.

The shared Unix socket host uses `<agentDir>/rpc-host-daemon/host.pid` and `settings.json` as its ownership state. Clients attach to a compatible existing host regardless of which client surface started it; only incompatible unmanaged owners are refused.

RPC mode enables headless operation of the coding agent via a JSON protocol over stdin/stdout. This is useful for embedding the agent in other applications, IDEs, or custom UIs.

**Note for Node.js/TypeScript users**: If you're building a Node.js application, consider using `AgentSession` directly from `@code-yeongyu/senpi` instead of spawning a subprocess. See [`src/core/agent-session.ts`](../src/core/agent-session.ts) for the API. For a subprocess-based TypeScript client, see [`src/modes/rpc/rpc-client.ts`](../src/modes/rpc/rpc-client.ts).

## Starting RPC Mode

### RPC client lifecycle

`RpcClient` accepts an `onDisconnect` callback for an established socket and rejects subsequent transport operations with the typed `RpcTransportGoneError` (also detectable with `isTransportGoneError`). Callers should use the callback to begin recovery and keep the error text out of user-facing output.

```bash
senpi --mode rpc [options]
```

Common options:
- `--provider <name>`: Set the LLM provider (anthropic, openai, google, etc.)
- `--model <pattern>`: Model pattern or ID (supports `provider/id` and optional `:<thinking>`)
- `--name <name>` / `-n <name>`: Set the session display name at startup
- `--no-session`: Disable session persistence
- `--session-dir <path>`: Custom session storage directory

### Client capabilities

Optional additive records are enabled through the comma-separated
`SENPI_RPC_CLIENT_CAPABILITIES` environment variable:

```bash
SENPI_RPC_CLIENT_CAPABILITIES=extension_events senpi --mode rpc
```

Rebranded distributions read the equivalent variable under their configured environment prefix
(for example `OMO_RPC_CLIENT_CAPABILITIES`). Unknown capability names are ignored. Advertising
`extension_events` opts the client into generic extension-owned event records; clients that omit it
retain the previous wire stream unchanged.

## Multi-session mode (D1 wire protocol)

Multi-session mode lets one `senpi --mode rpc` process serve several independent conversations concurrently over the same stdio JSONL stream. Classic single-session mode is byte-identical to today; the only additive classic-mode behavior is that `get_protocol_info` is answered.

### Starting multi-session mode

```bash
# Shared JSONL over stdio (legacy multi-session host)
senpi --mode rpc --multi-session [options]

# One shared host over a local socket; each accepted connection has its own JSONL feed
senpi --mode rpc --listen unix:///tmp/senpi-rpc.sock [options]
senpi --mode rpc --listen /tmp/senpi-rpc.sock [options]
```

`--listen unix://` selects the default per-agent socket path. Unix abstract socket names may be supplied as
`unix://@name` where supported by the host platform. Socket mode accepts concurrent connections while retaining one
process-global session registry.

On Windows, listeners and clients deterministically map the logical socket path to
`\\.\pipe\senpi-rpc-<sha256[:32]>`. Callers keep using the same `unix://` CLI value; the logical path remains the
ownership and settings identity, and callers never construct the pipe name themselves.

Socket event visibility is attachment-scoped for session content: each connection receives agent output only from sessions
attached to that connection, with every record tagged by its routing `sessionId`. Content-free lifecycle records
(`agent_start`, `agent_settled`, `agent_idle`, `session_opened`, and `session_closed`) are broadcast to all registered
connections, including the supervisor's unattached observer, so host lifecycle accounting remains accurate without exposing
session content. Correlated responses and dialog extension UI
requests (select, confirm, input, and editor) are requester-only; other extension UI state records go to the session's
attached connections. To observe a foreign session, open it by its existing
`sessionPath`; the host attaches that connection during `open_session`.

### Client information and rendered components

Clients may send `set_client_info` with `{ sessionId, width, capabilities? }`. Advertising `rendered_components` registers
that connection to receive factory-rendered `setWidget`, `setHeader`, and `setFooter` records. Those records are filtered
per connection; array/undefined widget records and dialog requests retain their existing delivery semantics. Width is
shared per session using the minimum of attached clients, and a closed or dropped connection no longer contributes its
width or capability registration. Snapshot replay preserves rendered-component provenance and applies the same capability
filter to late joiners; a client that registers `rendered_components` while a snapshot is active receives its retained
factory-rendered records. On a shared socket host, `rendered_components` is registration-only: it is never inherited from the host environment and must be sent in `set_client_info` for each client connection. Registration applies to the sessions attached by that connection; closing one session removes only that session's width and capability association, while socket disposal removes all associations. Clients must re-register `width` and `capabilities` after every reconnect. When the last
capable connection leaves a still-attached binding, live component renderers and footer data providers are disposed but
their factories are retained; a later capable connection recreates and re-renders them.

### Session auto-titling

Auto-generated session titles are on by default only for interactive launches. RPC hosts opt in with
`--auto-title-sessions`:

```bash
senpi --mode rpc --multi-session --auto-title-sessions
```

With the flag, every session the host opens (classic or multi-session) generates a title from its first user prompt and
publishes it to clients through the existing `session_info_changed` event; no new command or event is involved. Sessions
resumed with existing context messages are never retitled, with or without the flag.

Startup: `senpi --mode rpc --multi-session` → NO default session is constructed (no default `AgentSessionRuntime`, no default extension/watcher load). Classic `senpi --mode rpc` is byte-identical to today. Mode is fixed at process start; there is no runtime transition.

### Interactive sessions and shared-host opt-out

Interactive launches use the shared RPC host by default when a persisted session is available. A cold start takes approximately 1.3 seconds on the first launch; warm attachment to an existing compatible host is fast. To use the local runtime directly for a launch, set `SENPI_DISABLE_SHARED_HOST=1`. This uses the same local fallback runtime and does not change RPC socket behavior for other clients.

### Session replacement

A replacement (`new_session`, `switch_session`, `fork`) responds as soon as the swap is committed; the derived-surface refresh that rebinds extensions continues afterwards. That refresh does not disturb work the client starts against the committed session: tool activation performed while extensions are still binding no longer cancels an in-flight compaction or invalidates its context. `loaded_surfaces_changed` is emitted only when the surface digest actually changes, so it is NOT a settle barrier clients can wait on.

#### Replacement identity event

When `new_session`, `switch_session`, or `fork` swaps the live session - including replacements an extension drives, which a client never issued - every attached connection receives:

```json
{ "type": "session_replaced", "durableSessionId": "…", "sessionFile": "…", "cwd": "…", "sessionName": "…" }
```

The command response reports only `{ cancelled }`, so this event is the only push channel carrying the new identity. The identity is `durableSessionId`, never `sessionId`: top-level `sessionId` is reserved for the per-connection routing handle that multi-session hosts tag every record with, and that tag is applied last, so reusing the key would overwrite the identity the event exists to deliver. Classic mode emits the event untagged.

### Shared host lifecycle (cold start + idle exit)

The lifecycle supervisor is also available to bundled/rebranded runtimes through the hidden internal launch route `--internal-rpc-host-supervisor`. This route is wire-invisible and intended only for desktop launchers: it receives the public socket, ownership directory, and the runtime command/arguments to wrap, then runs the same `host-lifecycle.ts` implementation used by `ensureHost()`. Normal CLI modes do not use or advertise this route. Compiled standalone binaries also re-enter themselves through this route automatically: a bun executable always boots its embedded entrypoint, so the script-path re-entry used under a JS runtime would be parsed as CLI arguments (`Unknown option: --socket`) and the host could never start.

Hosts started through `ensureHost()` are wrapped by a lifecycle supervisor that owns the public socket and spawns the
real RPC host on a private internal hop. The policy lives in `<agentDir>/rpc-host-daemon/settings.json`:

```json
{ "socket": "…/rpc.sock", "capabilities": ["extension_events", "custom_unsupported"], "coldStart": "transient", "idleExitMs": 900000 }
```

- `coldStart` — `transient` (default): the host exists for the current login session and idle-exits. `persistent`:
  no idle exit; the host stays until it is stopped or dies.
- `idleExitMs` — idle-exit window in milliseconds, default `900000` (15 minutes).

Environment overrides beat the file, and invalid values fall through to the next source: `SENPI_RPC_HOST_COLD_START`
(`transient`|`persistent`) and `SENPI_RPC_HOST_IDLE_EXIT_MS` (positive integer milliseconds).

The host exits only after the window elapses with NO attached client connections and NO active turns — continuously.
Any connection or agent turn resets the window, so a busy host never exits, and the exit itself is clean: the RPC host
receives SIGTERM first, flushes pending output, removes its socket, and the supervisor then removes `host.pid` and
`settings.json` (the stderr log stays for diagnostics). After an idle exit, the next `ensureHost()` transparently
starts a fresh host. `get_protocol_info` over the public socket behaves exactly as before; the supervisor is
wire-transparent.

The RPC host can never outlive its supervisor. It is spawned with an extra inherited pipe on fd 3 whose write end the
supervisor holds and never writes to; the kernel closes that end whenever the supervisor dies — including `SIGKILL`, an
OOM kill, or a crash, where no signal handler runs — so the host reads EOF, shuts down cleanly and removes its private
internal directory. The supervisor also exports `SENPI_RPC_HOST_WATCH_PPID` as a polling fallback. Both bindings are
set only by the supervisor: a host started any other way (plain `senpi --mode rpc --listen …`, embedders, hand-started
hosts) sees neither variable and is unaffected. A host whose supervisor is alive is never touched by this binding.

### Shared host occupancy (idle eviction, session cap, empty-host exit)

Every open session owns a complete runtime (a lone idle session measures 340-510 MB RSS), so the host enforces three
occupancy bounds itself, independent of the supervisor and of client cooperation:

- **Idle eviction**: a session with no routed command and no session-owned work for
  `SENPI_RPC_SESSION_IDLE_EVICTION_MS` (default 30 minutes) is closed through the exact `close_session` sequence
  (abort → waitForIdle → dispose, all attachments drained, path reservation released) and every attached connection
  receives that handle's `session_closed` broadcast plus a final `close_session` response record. "Session-owned
  work" is the complete activity contract, not just a streaming turn: an agent run, a running bash command,
  background terminal jobs and any other published wake source (terminal monitors, loop-guard holds), compaction,
  and barrier-held session work all defer eviction, and the idle clock restarts when that work settles. An evicted
  session resumes like any other: the next `open_session` with the same `sessionPath` reopens it.
- **Session cap**: `open_session` beyond `SENPI_RPC_MAX_SESSIONS` concurrently opening/open sessions (default 8)
  fails with `too_many_sessions`. Attaching to an already-hosted session (`attached: true`) adds no runtime and never
  counts against the cap, so resume and second-surface flows keep working while at it.
- **Empty-host exit**: when the registry holds zero sessions AND no client is connected, continuously for
  `SENPI_RPC_HOST_EMPTY_EXIT_MS` (default 15 minutes), the host exits through its clean shutdown path (flush, socket
  removal), for stdio and `--listen` hosts alike. A connected client counts as occupancy even with no session open,
  so the host never drops a live socket under itself. Supervised hosts stay clean either way: a supervisor reads a
  child exit of 0 without a signal as an intentional idle stop and exits 0 with the same cleanup, not as a crash.

Values are positive integers; invalid values fall through to the defaults. These bounds run inside the host process,
so they hold even for embedders and hand-started hosts that have no supervisor.

### D1 normative table (multi-session mode)

| Command | Params | Success data | Notes |
| --- | --- | --- | --- |
| `get_protocol_info` | - | `{ protocolVersion: 1, serverVersion: string, capabilities: string[], mode: "classic"\|"multi" }` | Answered in BOTH modes; side-effect-free; the capability probe. Multi-session hosts include `multi_session` plus the negotiated launch capabilities. |
| `open_session` | `sessionPath?`, `cwd?`, `provider?`, `modelId?`, `thinkingLevel?`, `permissionPreset?` (all optional; paths MUST be absolute) | `{ sessionId, state: RpcSessionState, attached?: true }` | `sessionPath` = today's `--session` semantics (open-if-exists else create persisting there, `session-manager.ts:926-940`); `provider`/`modelId` applied only on create (resume restores the session's model — mirrors `SenpiSessionRuntime.ts:198-200`); params form the immutable launch profile (D8). When the path is already held by a fully-open session, the open ATTACHES to it: same routing handle, `attached: true`, one more attachment counted; the runtime is torn down only when the last attachment closes. Fails with `too_many_sessions` at the occupancy cap (see [Shared host occupancy](#shared-host-occupancy-idle-eviction-session-cap-empty-host-exit)); idle sessions past the eviction window are closed by the host itself. |
| `close_session` | `sessionId` | `{}` | Aborts active work, awaits agent idle + settled persistence for up to the host grace window (default 10s), then force-releases the session; its response is the LAST record tagged with that handle for the first closer — no events after (test-pinned). A concurrent close joins the same teardown and receives its own successful response. |
| `list_sessions` | - | `{ sessions: [{ sessionId, durableSessionId, sessionPath, cwd, name, status }] }` | Includes `opening`/`closing` entries with their status. |
| every existing command | + `sessionId` (REQUIRED in multi mode) | unchanged | Routed to that session. |

### Identities (D6)

Response-level `sessionId` = opaque **routing handle**, unique per process epoch, ephemeral (dies with the child). `state.sessionId` = **durable** JSONL session identity (what a resume cursor stores today). `list_sessions` exposes both. Clients store both, discard routing handles on child exit, and verify only durable ids against cursors.

### Stable error codes

In the response `error` field, machine-matchable:

- `unknown_session`
- `session_closing`
- `session_path_in_use` (path held by a session still `opening` or already `closing`; a fully-open session is attached instead)
- `missing_session_id` (session-scoped command without `sessionId` in multi mode)
- `multi_session_disabled` (`open_session` in classic mode)
- `invalid_path` (relative `sessionPath`/`cwd`)
- `too_many_sessions` (`open_session` while `SENPI_RPC_MAX_SESSIONS` sessions are already opening/open; attaching to a live session never fails this way)
- `open_failed: <detail>`

### Tagging

Every response/event/`extension_ui_request` belonging to a session carries a top-level `sessionId` (routing handle). `get_protocol_info`/`list_sessions` responses are untagged. Classic mode: nothing tagged (byte-identical).

### Ordering guarantee (D9)

Strict FIFO per session; one total stdout order; cross-session order unspecified; fair round-robin between sessions' queued complete records; NO cross-session batch coalescing (per-session event buffers; the process-wide single-array coalescer in `event-output-buffer.ts` must not merge records of different sessions into one write). Starvation freedom is NOT promised (single pipe); a giant tool record delays others — bounded only by record completion.

### Duplicate/idempotency

Duplicate `open_session` while a path reservation is held by a fully-open session → ATTACH (`attached: true`, same handle); while held by an `opening`/`closing` entry → `session_path_in_use`. `close_session` releases one attachment; the runtime is disposed only when the last attachment closes. A close for an entry already `closing` joins its in-flight teardown. `close_session` on unknown/already-closed → `unknown_session` error. The grace window is configurable by the host through `SENPI_RPC_CLOSE_GRACE_MS`. Request `id`s are client-owned; the server echoes them without dedup.

## Protocol Overview

- **Commands**: JSON objects sent to stdin, one per line
- **Responses**: JSON objects with `type: "response"` indicating command success/failure
- **Events**: Agent events streamed to stdout as JSON lines

All commands support an optional `id` field for request/response correlation. If provided, the corresponding response will include the same `id`. `bash_execution_update` events also include the `id` of their originating `bash` command.

### Framing

RPC mode uses strict JSONL semantics with LF (`\n`) as the only record delimiter.

This matters for clients:
- Split records on `\n` only
- Accept optional `\r\n` input by stripping a trailing `\r`
- Do not use generic line readers that treat Unicode separators as newlines
- Send JSON objects only; valid JSON primitives and arrays receive a parse-style error response
- Keep each encoded input record at or below 16,777,216 characters. Oversized records receive one parse-style error,
  are discarded through the next LF, and do not desynchronize following records

In particular, Node `readline` is not protocol-compliant for RPC mode because it also splits on `U+2028` and `U+2029`, which are valid inside JSON strings.

## Commands

### Prompting

#### prompt

Send a user prompt to the agent. The command response is emitted after the prompt is accepted, queued, or handled. Events continue streaming asynchronously after acceptance.

```json
{"id": "req-1", "type": "prompt", "message": "Hello, world!"}
```

With a session-only thinking level:
```json
{"id": "req-1", "type": "prompt", "message": "Solve this carefully", "thinkingLevel": "high"}
```

With images:
```json
{"type": "prompt", "message": "What's in this image?", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

**During streaming**: If the agent is already streaming, you must specify `streamingBehavior` to queue the message:

```json
{"type": "prompt", "message": "New instruction", "streamingBehavior": "steer"}
```

- `"steer"`: Queue the message while the agent is running. It is delivered after the current assistant turn finishes executing its tool calls, before the next LLM call.
- `"followUp"`: Wait until the agent finishes. Message is delivered only when agent stops.

If the agent is streaming and no `streamingBehavior` is specified, the command returns an error.
Queued prompts cannot include `thinkingLevel`; wait for the current turn to complete before changing it.

**Extension commands**: If the message is an extension command (e.g., `/mycommand`), it executes immediately even during streaming. Extension commands manage their own LLM interaction via `pi.sendMessage()`.

**Input expansion**: Leading skill tokens (`/skill:name`, `$name`, or `$skill:name`), inline explicit
desktop skill tokens (`$skill:name`), and prompt templates (`/template`) are expanded before
sending/queueing. Bare inline dollar text remains literal.

Response:
```json
{"id": "req-1", "type": "response", "command": "prompt", "success": true, "data": { "disposition": "started" }}
```

The prompt success response carries `data.disposition` (`"started"` | `"queued"` | `"handled"`), captured from the host session's own disposition callback so proxied clients can resolve optimistic-echo contracts exactly like the local path. Older hosts omit `data`; clients must then degrade to canonical-only rendering (treat the echo as rejected). The response is emitted before the user `message_start` event on the same connection, and disposition callbacks registered through the client run synchronously inside response-frame dispatch — never through the resolved promise's microtask.

`success: true` means the prompt was accepted, queued, or handled immediately. `success: false` means the prompt was rejected before acceptance. Failures after acceptance are reported through the normal event and message stream, not as a second `response` for the same request id.

The `images` field is optional. Each image uses `ImageContent` format: `{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}`.
The `message` field for `prompt`, `steer`, and `follow_up` is limited to 1,000,000 characters;
image payloads are not counted toward this text limit.

#### steer

Queue a steering message while the agent is running. It is delivered after the current assistant turn finishes executing its tool calls, before the next LLM call. Skill commands and prompt templates are expanded. Extension commands are not allowed (use `prompt` instead).

```json
{"type": "steer", "message": "Stop and do this instead"}
```

With images:
```json
{"type": "steer", "message": "Look at this instead", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

The `images` field is optional. Each image uses `ImageContent` format (same as `prompt`).

Response:
```json
{"type": "response", "command": "steer", "success": true}
```

See [set_steering_mode](#set_steering_mode) for controlling how steering messages are processed.

#### follow_up

Queue a follow-up message to be processed after the agent finishes. Delivered only when agent has no more tool calls or steering messages. Skill commands and prompt templates are expanded. Extension commands are not allowed (use `prompt` instead).

```json
{"type": "follow_up", "message": "After you're done, also do this"}
```

With images:
```json
{"type": "follow_up", "message": "Also check this image", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

The `images` field is optional. Each image uses `ImageContent` format (same as `prompt`).

Response:
```json
{"type": "response", "command": "follow_up", "success": true}
```

See [set_follow_up_mode](#set_follow_up_mode) for controlling how follow-up messages are processed.

#### abort

Abort the current agent operation.

```json
{"type": "abort"}
```

Response:
```json
{"type": "response", "command": "abort", "success": true}
```

#### clear_queue

Remove queued steering and follow-up messages and return their text.

```json
{"type": "clear_queue"}
```

Response:
```json
{
  "type": "response",
  "command": "clear_queue",
  "success": true,
  "data": {
    "steering": ["Change direction"],
    "followUp": ["Summarize when finished"]
  }
}
```

To implement interactive Esc behavior, send `clear_queue` before `abort`, then restore the returned text in the client editor. `abort` continues queued messages when they remain in the session.

#### new_session

Start a fresh session. Can be cancelled by a `session_before_switch` extension event handler.

```json
{"type": "new_session"}
```

With optional parent session tracking:
```json
{"type": "new_session", "parentSession": "/path/to/parent-session.jsonl"}
```

Response:
```json
{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": false}}
```

If an extension cancelled:
```json
{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": true}}
```

### State

#### get_state

Get current session state.

```json
{"type": "get_state"}
```

Response:
```json
{
  "type": "response",
  "command": "get_state",
  "success": true,
  "data": {
    "model": {...},
    "thinkingLevel": "medium",
    "serviceTier": "priority",
    "fastMode": true,
    "isStreaming": false,
    "isCompacting": false,
    "steeringMode": "all",
    "followUpMode": "one-at-a-time",
    "sessionFile": "/path/to/session.jsonl",
    "sessionId": "abc123",
    "sessionName": "my-feature-work",
    "autoCompactionEnabled": true,
    "messageCount": 5,
    "pendingMessageCount": 0
  }
}
```

The `model` field is a full [Model](#model) object or `null`. The `sessionName` field is the display name set via `set_session_name`, or omitted if not set.

`serviceTier` is the tier a request would carry right now (`"auto"`, `"flex"`, or `"priority"`), omitted when no tier applies. `fastMode` is `true` when the active model is served at the priority ("fast") tier — either because fast mode is on for this session or because the model selection itself pins `priority`. The two never disagree: whenever `fastMode` is `true`, `serviceTier` is `"priority"`.

#### get_messages

Get all messages in the conversation.

```json
{"type": "get_messages"}
```

Response:
```json
{
  "type": "response",
  "command": "get_messages",
  "success": true,
  "data": {"messages": [...]}
}
```

Messages are `AgentMessage` objects (see [Message Types](#message-types)).

### Model

#### set_model

Switch to a specific model.

```json
{"type": "set_model", "provider": "anthropic", "modelId": "claude-sonnet-4-20250514"}
```

Response contains the full [Model](#model) object:
```json
{
  "type": "response",
  "command": "set_model",
  "success": true,
  "data": {...}
}
```

#### cycle_model

Cycle to the next available model. Returns `null` data if only one model available.

```json
{"type": "cycle_model"}
```

Response:
```json
{
  "type": "response",
  "command": "cycle_model",
  "success": true,
  "data": {
    "model": {...},
    "thinkingLevel": "medium",
    "isScoped": false
  }
}
```

The `model` field is a full [Model](#model) object.

#### get_available_models

List all configured models.

```json
{"type": "get_available_models"}
```

Response contains an array of full [Model](#model) objects with supported thinking levels:
```json
{
  "type": "response",
  "command": "get_available_models",
  "success": true,
  "data": {
    "models": [...]
  }
}
```

### Thinking

#### set_thinking_level

Set the reasoning/thinking level for models that support it.

```json
{"type": "set_thinking_level", "level": "high"}
```

Levels: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`

`"xhigh"` and `"max"` are exposed only when supported by the selected model. Some models, including GPT-5.6, expose both.

Response:
```json
{"type": "response", "command": "set_thinking_level", "success": true}
```

Pass `"scope": "turn"` to change only the current session level without rewriting the model's remembered level. The
command returns an error when the active model cannot apply the requested level, and a rejected request leaves the
session level unchanged — a failed `set_thinking_level` never mutates state.

```json
{
  "type": "response",
  "command": "set_thinking_level",
  "success": false,
  "error": "Thinking level low is not supported by the active model."
}
```

#### cycle_thinking_level

Cycle through available thinking levels. Returns `null` data if model doesn't support thinking.

```json
{"type": "cycle_thinking_level"}
```

Response:
```json
{
  "type": "response",
  "command": "cycle_thinking_level",
  "success": true,
  "data": {"level": "high"}
}
```

#### get_available_thinking_levels

List the thinking levels supported by the current model. Returns `["off"]` for a model without reasoning support.

```json
{"type": "get_available_thinking_levels"}
```

Response:
```json
{
  "type": "response",
  "command": "get_available_thinking_levels",
  "success": true,
  "data": {
    "levels": ["off", "minimal", "low", "medium", "high"]
  }
}
```

### Fast mode

#### set_fast_mode

Turn fast mode (the OpenAI Codex `priority` service tier) on or off for the active model. The choice is remembered
per model, so a later session on the same model starts the same way; `enabled: false` records an explicit `"auto"`
so it also overrides a tier inherited from the model catalog.

```json
{"type": "set_fast_mode", "enabled": true}
```

Response:
```json
{
  "type": "response",
  "command": "set_fast_mode",
  "success": true,
  "data": {
    "enabled": true,
    "serviceTier": "priority",
    "provider": "openai-codex",
    "modelId": "gpt-5.6-sol"
  }
}
```

`serviceTier` is the tier just recorded for the model (`"priority"` on, `"auto"` off). `provider`/`modelId` identify
the model the preference was stored under: a `-fast` catalog variant and its base model share one entry, so the
reported id can be the base model rather than the model that was active.

The command returns an error instead of a silent no-op when the request cannot be applied:

| Situation | `error` |
|-----------|---------|
| Active model is not an OpenAI Codex model | `Fast mode is only available for OpenAI Codex models.` |
| `enabled: false` while the model selection pins `:priority` | `Fast mode is fixed by the active model selection's priority tier.` |
| `enabled` is not a boolean | `set_fast_mode requires a boolean 'enabled' field.` |

A successful call emits a [`service_tier_changed`](#service_tier_changed) event.

#### get_fast_mode

Read the current fast-mode state.

```json
{"type": "get_fast_mode"}
```

Response:
```json
{
  "type": "response",
  "command": "get_fast_mode",
  "success": true,
  "data": {"enabled": true, "serviceTier": "priority"}
}
```

`serviceTier` is `null` when no tier applies. It matches `get_state.serviceTier`.

### Queue Modes

#### set_steering_mode

Control how steering messages (from `steer`) are delivered.

```json
{"type": "set_steering_mode", "mode": "one-at-a-time"}
```

Modes:
- `"all"`: Deliver all steering messages after the current assistant turn finishes executing its tool calls
- `"one-at-a-time"`: Deliver one steering message per completed assistant turn (default)

Response:
```json
{"type": "response", "command": "set_steering_mode", "success": true}
```

#### set_follow_up_mode

Control how follow-up messages (from `follow_up`) are delivered.

```json
{"type": "set_follow_up_mode", "mode": "one-at-a-time"}
```

Modes:
- `"all"`: Deliver all follow-up messages when agent finishes
- `"one-at-a-time"`: Deliver one follow-up message per agent completion (default)

Response:
```json
{"type": "response", "command": "set_follow_up_mode", "success": true}
```

### Compaction

#### compact

Manually compact conversation context to reduce token usage.

```json
{"type": "compact"}
```

With custom instructions:
```json
{"type": "compact", "customInstructions": "Focus on code changes"}
```

Response:
```json
{
  "type": "response",
  "command": "compact",
  "success": true,
  "data": {
    "summary": "Summary of conversation...",
    "firstKeptEntryId": "abc123",
    "tokensBefore": 150000,
    "estimatedTokensAfter": 32000,
    "usage": {
      "input": 32000,
      "output": 1200,
      "cacheRead": 0,
      "cacheWrite": 0,
      "totalTokens": 33200,
      "cost": {"input": 0.01, "output": 0.02, "cacheRead": 0, "cacheWrite": 0, "total": 0.03}
    },
    "details": {}
  }
}
```

`estimatedTokensAfter` is a heuristic estimate over the rebuilt message context immediately after compaction, not a provider-exact token count. `usage` reports the LLM call or calls that generated the summary and may be omitted by custom compaction handlers.

#### set_auto_compaction

Enable or disable automatic compaction when context is nearly full.

```json
{"type": "set_auto_compaction", "enabled": true}
```

Response:
```json
{"type": "response", "command": "set_auto_compaction", "success": true}
```

### Retry

#### set_auto_retry

Enable or disable automatic retry on transient errors (overloaded, rate limit, 5xx).

```json
{"type": "set_auto_retry", "enabled": true}
```

Response:
```json
{"type": "response", "command": "set_auto_retry", "success": true}
```

#### abort_retry

Abort an in-progress retry (cancel the delay and stop retrying).

```json
{"type": "abort_retry"}
```

Response:
```json
{"type": "response", "command": "abort_retry", "success": true}
```

### Bash

#### bash

Execute a shell command and add output to conversation context. Output streams as `bash_execution_update` events while the command runs; the response contains the final result.

```json
{"id": "req-1", "type": "bash", "command": "ls -la"}
```

Include an `id` to associate streamed `bash_execution_update` events with this command.

Response:
```json
{
  "id": "req-1",
  "type": "response",
  "command": "bash",
  "success": true,
  "data": {
    "output": "total 48\ndrwxr-xr-x ...",
    "exitCode": 0,
    "cancelled": false,
    "truncated": false
  }
}
```

If output was truncated, includes `fullOutputPath`:
```json
{
  "type": "response",
  "command": "bash",
  "success": true,
  "data": {
    "output": "truncated output...",
    "exitCode": 0,
    "cancelled": false,
    "truncated": true,
    "fullOutputPath": "/tmp/pi-bash-abc123.log"
  }
}
```

**How bash results reach the LLM:**

The `bash` command executes immediately and returns a `BashResult`. Internally, a `BashExecutionMessage` is created and stored in the agent's message state.

When the next `prompt` command is sent, all messages (including `BashExecutionMessage`) are transformed before being sent to the LLM. The `BashExecutionMessage` is converted to a `UserMessage` with this format:

````
Ran `ls -la`
```
total 48
drwxr-xr-x ...
```
````

This means:
1. Bash output is included in the LLM context on the **next prompt**, not immediately
2. Multiple bash commands can be executed before a prompt; all outputs will be included

#### abort_bash

Abort a running bash command.

```json
{"type": "abort_bash"}
```

Response:
```json
{"type": "response", "command": "abort_bash", "success": true}
```

### Session

#### get_session_stats

Get token usage, cost statistics, and current context window usage.

```json
{"type": "get_session_stats"}
```

Response:
```json
{
  "type": "response",
  "command": "get_session_stats",
  "success": true,
  "data": {
    "sessionFile": "/path/to/session.jsonl",
    "sessionId": "abc123",
    "userMessages": 5,
    "assistantMessages": 5,
    "toolCalls": 12,
    "toolResults": 12,
    "totalMessages": 22,
    "tokens": {
      "input": 50000,
      "output": 10000,
      "cacheRead": 40000,
      "cacheWrite": 5000,
      "total": 105000
    },
    "cost": 0.45,
    "contextUsage": {
      "tokens": 60000,
      "contextWindow": 200000,
      "percent": 30
    }
  }
}
```

`tokens` and `cost` include assistant messages, usage reported by tools, and compaction/branch-summary generation across the full session. `contextUsage` contains the actual current context-window estimate used for compaction and footer display.

`contextUsage` is omitted when no model or context window is available. `contextUsage.tokens` and `contextUsage.percent` are `null` immediately after compaction until a fresh post-compaction assistant response provides valid usage data.

#### export_html

Export session to an HTML file.

```json
{"type": "export_html"}
```

With custom path:
```json
{"type": "export_html", "outputPath": "/tmp/session.html"}
```

Response:
```json
{
  "type": "response",
  "command": "export_html",
  "success": true,
  "data": {"path": "/tmp/session.html"}
}
```

#### switch_session

Load a different session file. Can be cancelled by a `session_before_switch` extension event handler.

```json
{"type": "switch_session", "sessionPath": "/path/to/session.jsonl", "cwdOverride": "/path/to/project"}
```

`cwdOverride` is optional. When supplied, the replacement session and its cwd-bound settings and runtime state are rebuilt for that directory instead of using the session file's stored cwd. The host also resolves `projectTrusted` from its saved project trust store for the replacement cwd; an absent or false decision keeps project-scoped settings and resources disabled.

Response:
```json
{"type": "response", "command": "switch_session", "success": true, "data": {"cancelled": false}}
```

If an extension cancelled the switch:
```json
{"type": "response", "command": "switch_session", "success": true, "data": {"cancelled": true}}
```

#### fork

Create a new fork from a previous user message on the active branch. Can be cancelled by a `session_before_fork` extension event handler. Returns the text of the message being forked from.

```json
{"type": "fork", "entryId": "abc123"}
```

Response:
```json
{
  "type": "response",
  "command": "fork",
  "success": true,
  "data": {"text": "The original prompt text...", "cancelled": false}
}
```

If an extension cancelled the fork:
```json
{
  "type": "response",
  "command": "fork",
  "success": true,
  "data": {"text": "The original prompt text...", "cancelled": true}
}
```

#### clone

Duplicate the current active branch into a new session at the current position. Can be cancelled by a `session_before_fork` extension event handler.

```json
{"type": "clone"}
```

Response:
```json
{
  "type": "response",
  "command": "clone",
  "success": true,
  "data": {"cancelled": false}
}
```

If an extension cancelled the clone:
```json
{
  "type": "response",
  "command": "clone",
  "success": true,
  "data": {"cancelled": true}
}
```

#### get_fork_messages

Get user messages available for forking.

```json
{"type": "get_fork_messages"}
```

Response:
```json
{
  "type": "response",
  "command": "get_fork_messages",
  "success": true,
  "data": {
    "messages": [
      {"entryId": "abc123", "text": "First prompt..."},
      {"entryId": "def456", "text": "Second prompt..."}
    ]
  }
}
```

#### get_entries

Get all session entries in append order (excluding the session header). The session is an append-only tree of entries with stable ids, so an entry id works as a durable cursor: pass the last entry id you have seen as `since` to get only entries strictly after it, even across client restarts. Unlike `get_messages`, this includes pre-compaction history and abandoned branches.

```json
{"type": "get_entries"}
```

With a cursor:
```json
{"type": "get_entries", "since": "abc123"}
```

Response:
```json
{
  "type": "response",
  "command": "get_entries",
  "success": true,
  "data": {
    "entries": [
      {"type": "message", "id": "def456", "parentId": "abc123", "timestamp": "...", "message": {"role": "user", "...": "..."}}
    ],
    "leafId": "def456"
  }
}
```

`leafId` is the id of the current leaf entry (`null` for an empty session), so a client can tell in one round trip whether the active branch moved. If `since` does not match any entry id, the response is `success: false`.

#### get_tree

Get the session as a tree of entries. Each node is `{entry, children, label?, labelTimestamp?}`. A well-formed session has a single root; orphaned entries (broken parent chain) also appear as roots.

```json
{"type": "get_tree"}
```

Response:
```json
{
  "type": "response",
  "command": "get_tree",
  "success": true,
  "data": {
    "tree": [
      {
        "entry": {"type": "message", "id": "abc123", "parentId": null, "...": "..."},
        "children": [
          {"entry": {"type": "message", "id": "def456", "parentId": "abc123", "...": "..."}, "children": []}
        ]
      }
    ],
    "leafId": "def456"
  }
}
```

#### get_last_assistant_text

Get the text content of the last assistant message.

```json
{"type": "get_last_assistant_text"}
```

Response:
```json
{
  "type": "response",
  "command": "get_last_assistant_text",
  "success": true,
  "data": {"text": "The assistant's response..."}
}
```

Returns `{"text": null}` if no assistant messages exist.

#### set_session_name

Set a display name for the current session. The name appears in session listings and helps identify sessions.

```json
{"type": "set_session_name", "name": "my-feature-work"}
```

Response:
```json
{
  "type": "response",
  "command": "set_session_name",
  "success": true
}
```

The current session name is available via `get_state` in the `sessionName` field. To set the initial name when starting RPC mode, pass `--name <name>` or `-n <name>` to the `senpi --mode rpc` process.

### Commands

#### get_commands

Get the ordered command surface (extension commands, prompt templates, and skills). Extension and prompt rows are
invoked through `prompt` with `/name`; skill rows use `$name` or the compatibility form `/skill:name`.

```json
{"type": "get_commands"}
```

Response:
```json
{
  "type": "response",
  "command": "get_commands",
  "success": true,
  "data": {
    "commands": [
      {"name": "session-name", "description": "Set or clear session name", "source": "extension", "syntax": "slash", "sourceInfo": {"path": "/home/user/.senpi/agent/extensions/session.ts", "source": "auto", "scope": "user", "origin": "top-level"}},
      {"name": "fix-tests", "description": "Fix failing tests", "source": "prompt", "syntax": "slash", "sourceInfo": {"path": "/home/user/myproject/.senpi/prompts/fix-tests.md", "source": "auto", "scope": "project", "origin": "top-level"}},
      {"name": "skill:brave-search", "description": "Web search via Brave API", "source": "skill", "syntax": "dollar", "sourceInfo": {"path": "/home/user/.senpi/agent/skills/brave-search/SKILL.md", "source": "auto", "scope": "user", "origin": "top-level"}}
    ]
  }
}
```

Each command has:
- `name`: Command identity without its leading invocation marker
- `description`: Human-readable description (optional for extension commands)
- `syntax`: Canonical marker clients should insert (`"slash"` for extension/prompt rows, `"dollar"` for skills)
- `source`: What kind of command:
  - `"extension"`: Registered via `pi.registerCommand()` in an extension
  - `"prompt"`: Loaded from a prompt template `.md` file
  - `"skill"`: Loaded from a skill directory (name is prefixed with `skill:`)
- `sourceInfo`: Provenance metadata for the owning resource (present for all sources, including extensions):
  - `path`: Absolute file path to the command source
  - `source`: Source identifier string (for example `"auto"` for auto-discovered locations, `"local"` for settings entries, `"cli"` for CLI paths, `"builtin"`, `"sdk"`, or a package source)
  - `scope`: `"user"`, `"project"`, or `"temporary"`
  - `origin`: `"package"` or `"top-level"`
  - `baseDir`: Base directory of the owning resource (optional)

**Note**: Built-in TUI commands (`/settings`, `/hotkeys`, etc.) are not included. They are handled only in interactive mode and would not execute if sent via `prompt`.

#### get_loaded_surfaces

Get the extensions and MCP servers loaded by the active runtime. Skills remain available through `get_commands`, where each loaded skill is represented by one `source: "skill"` row.

```json
{"type": "get_loaded_surfaces"}
```

Response:

```json
{
  "type": "response",
  "command": "get_loaded_surfaces",
  "success": true,
  "data": {
    "extensions": [
      {
        "name": "my-extension",
        "path": "/home/user/.senpi/agent/extensions/my-extension.ts",
        "sourceInfo": {
          "path": "/home/user/.senpi/agent/extensions/my-extension.ts",
          "source": "auto",
          "scope": "user",
          "origin": "top-level"
        },
        "enabled": true
      }
    ],
    "mcpServers": [
      {
        "name": "filesystem",
        "toolCount": 12,
        "status": "connected",
        "authStatus": "unsupported"
      }
    ]
  }
}
```

Extension rows come directly from the session's loaded resource inventory, not from registered slash commands. A commandless extension therefore appears once, and an extension registering several commands is not duplicated. MCP rows come from the live session-owned MCP service and expose its current server state, listed tool count, and non-secret auth status.

In multi-session mode this is a session-scoped command and requires the routing `sessionId`.

### extension_request

Invoke a request handler registered by an extension through `pi.rpc.handle(name, handler)`:

```json
{
  "id": "req-42",
  "type": "extension_request",
  "name": "acme.job.cancel",
  "data": {
    "jobId": "job-42"
  }
}
```

Success returns the extension-owned structured value:

```json
{
  "id": "req-42",
  "type": "response",
  "command": "extension_request",
  "success": true,
  "data": {
    "cancelled": true
  }
}
```

The request `name` must resolve to exactly one handler in the active extension generation.
Unknown names, duplicate names, stale generations, handler failures, and empty names return the
normal `{ type: "response", success: false, error }` envelope. Senpi treats request and response
data as opaque; the owning extension and client must validate their payloads.

In multi-session mode this command requires the owning routing `sessionId`. The response receives
the same `sessionId`, and another session's extension handlers are never consulted.

## Events

Events are streamed to stdout as JSON lines during agent operation. Events do not generally include an `id` field; `bash_execution_update` includes the `id` of its originating `bash` command when one was provided.

### Event Types

| Event | Description |
|-------|-------------|
| `agent_start` | Agent begins processing |
| `agent_end` | One low-level agent run completes (may still be followed by retry, compaction, or queued continuations) |
| `agent_settled` | Agent run is fully settled; no automatic retry, compaction retry, or queued continuation remains |
| `turn_start` | New turn begins |
| `turn_end` | Turn completes (includes assistant message and tool results) |
| `message_start` | Message begins |
| `message_update` | Streaming update (text/thinking/toolcall deltas) |
| `message_end` | Message completes |
| `bash_execution_update` | Direct RPC bash command output chunk |
| `tool_execution_start` | Tool begins execution |
| `tool_execution_update` | Tool execution progress (streaming output) |
| `tool_execution_end` | Tool completes |
| `queue_update` | Pending steering/follow-up queue changed |
| `compaction_start` | Compaction begins |
| `compaction_end` | Compaction completes |
| `auto_retry_start` | Auto-retry begins (after transient error) |
| `auto_retry_end` | Auto-retry completes (success or final failure) |
| `summarization_retry_scheduled` | Retry scheduled for a transient compaction or branch-summary summarization error |
| `summarization_retry_attempt_start` | Retried summarization request starts |
| `summarization_retry_finished` | Summarization retry loop completes |
| `extension_error` | Extension threw an error |
| `extension_event` | Capability-gated extension-owned event (`extension_events` clients only) |
| `commands_changed` | Ordered command/skill candidate snapshot changed |
| `command_invocation` | Accepted extension-command or prompt-template invocation metadata |
| `skill_invocation` | Ordered explicit skill metadata after prompt expansion |
| `loaded_surfaces_changed` | Loaded skills, extensions, or MCP inventory changed; re-read `get_commands` and `get_loaded_surfaces` |
| `model_changed` | Active model changed (any source), with the thinking level in force afterwards |
| `service_tier_changed` | Effective service tier or fast-mode state changed |

Event types are additive: a client that does not recognise a type must ignore that record rather than fail. `model_changed`
and `service_tier_changed` were added after the initial protocol and are safe to ignore.

### model_changed

Emitted after the session's active model changed, whatever caused it: a `set_model` or `cycle_model` command, a slash
command, a retry fallback, or a session restore.

```json
{
  "type": "model_changed",
  "model": {"provider": "openai-codex", "id": "gpt-5.6-sol", "...": "..."},
  "thinkingLevel": "xhigh",
  "source": "cycle"
}
```

`model` is a full [Model](#model) object. `thinkingLevel` is the level in force **after** the switch — each model
remembers its own level, so this is that model's restored level (clamped to what it supports), not the level the
previous model was using. `source` is one of `"set"`, `"cycle"`, `"restore"`, `"fallback"`, or `"fallback-revert"`.

Clients that previously inferred the active model from `entry_appended` records can consume this instead.

### service_tier_changed

Emitted when the tier requests would carry, or the fast-mode indicator, changes — a `set_fast_mode` command, the
`/fast` slash command, or a model switch that resolves a different tier.

```json
{"type": "service_tier_changed", "tier": "priority", "fastMode": true}
```

`tier` is omitted when no tier applies. The pair matches `get_state.serviceTier` / `get_state.fastMode`.

### extension_event

Emitted when an extension calls `pi.rpc.emit(name, data)` and the client advertised
`extension_events`:

```json
{
  "type": "extension_event",
  "name": "acme.job.updated",
  "data": {
    "jobId": "job-42",
    "status": "running"
  }
}
```

`name` is extension-owned and `data` is opaque to Senpi. Consumers should validate the payload for
the specific event name before applying it. In multi-session mode the record also includes the
routing `sessionId`; delivery preserves the owning session and per-session event order.

The terminal builtin emits `terminal_monitor_state` on this path whenever the active monitor set
changes. `data` is `{ activeCount, monitors }`, where each monitor entry has `id`, `description`,
`paused`, and `startedAtMs`. The matching in-process `pi.events` channel is unchanged and is not
forwarded. Clients receive the wire record only when they advertise the `extension_events`
capability:

```json
{
  "type": "extension_event",
  "name": "terminal_monitor_state",
  "data": {
    "activeCount": 1,
    "monitors": [
      {
        "id": "bash_1",
        "description": "watch checks",
        "paused": false,
        "startedAtMs": 1710000000000
      }
    ]
  }
}
```

### agent_start

Emitted when the agent begins processing a prompt.

```json
{"type": "agent_start"}
```

### agent_end

Emitted when one low-level agent run completes. Contains all messages generated during this run. If `willRetry` is true, an automatic retry will follow.

```json
{
  "type": "agent_end",
  "messages": [...],
  "willRetry": false
}
```

### agent_settled

Emitted after the full session-level run settles. At this point senpi will not continue automatically through retry, compaction retry, or queued follow-up messages.

```json
{"type": "agent_settled"}
```

### turn_start / turn_end

A turn consists of one assistant response plus any resulting tool calls and results.

```json
{"type": "turn_start"}
```

```json
{
  "type": "turn_end",
  "message": {...},
  "toolResults": [...]
}
```

### message_start / message_end

Emitted when a message begins and completes. The `message` field contains an `AgentMessage`.

```json
{"type": "message_start", "message": {...}}
{"type": "message_end", "message": {...}}
```

### message_update (Streaming)

Emitted during streaming of assistant messages. Contains a delta event without a cumulative message snapshot.

```json
{
  "type": "message_update",
  "usage": {
    "input": 100,
    "output": 1,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 101,
    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}
  },
  "assistantMessageEvent": {
    "type": "text_delta",
    "contentIndex": 0,
    "delta": "Hello "
  }
}
```

The `assistantMessageEvent` field contains one of these delta types:

| Type | Description |
|------|-------------|
| `text_start` | Text content block started |
| `text_delta` | Text content chunk |
| `text_end` | Text content block ended |
| `thinking_start` | Thinking block started |
| `thinking_delta` | Thinking content chunk |
| `thinking_end` | Thinking block ended |
| `toolcall_start` | Tool call started (includes `id` and `toolName`) |
| `toolcall_delta` | Tool call arguments chunk |
| `toolcall_end` | Tool call ended (includes full `toolCall` object) |

Example streaming a text response:
```json
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_start","contentIndex":0}}
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":" world"}}
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"Hello world"}}
```

The top-level `usage` field contains the latest cumulative provider-reported usage. It may remain
zero until completion when a provider does not report usage during streaming.

Example starting a tool call:
```json
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"toolcall_start","contentIndex":1,"id":"call_abc123","toolName":"write"}}
```

`message_update` intentionally omits the former cumulative `message` field and
`assistantMessageEvent.partial`. Clients that need a live partial message must assemble it
from `message_start` and subsequent events using `contentIndex`. Treat `message_end.message`
as authoritative. For tool calls, `toolcall_start` provides the call `id` and `toolName`;
buffer `toolcall_delta.delta` for arguments. `toolcall_end.toolCall` contains the completed
call.

### bash_execution_update

Emitted once for each output chunk from a direct `bash` command. `id` matches the command's `id`, allowing clients to associate output with the correct command.

Events stream all output while the command runs, even if the final `bash` response's `output` is truncated.

```json
{
  "type": "bash_execution_update",
  "id": "req-1",
  "delta": "total 48\n"
}
```

### tool_execution_start / tool_execution_update / tool_execution_end

Emitted when a tool begins, streams progress, and completes execution.

```json
{
  "type": "tool_execution_start",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "args": {"command": "ls -la"}
}
```

During execution, `tool_execution_update` events stream partial results (e.g., bash output as it arrives):

```json
{
  "type": "tool_execution_update",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "args": {"command": "ls -la"},
  "partialResult": {
    "content": [{"type": "text", "text": "partial output so far..."}],
    "details": {"truncation": null, "fullOutputPath": null}
  }
}
```

When complete:

```json
{
  "type": "tool_execution_end",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "result": {
    "content": [{"type": "text", "text": "total 48\n..."}],
    "details": {...}
  },
  "isError": false
}
```

Use `toolCallId` to correlate events. The `partialResult` in `tool_execution_update` contains the accumulated output so far (not just the delta), allowing clients to simply replace their display on each update.

### queue_update

Emitted whenever the pending steering or follow-up queue changes.

```json
{
  "type": "queue_update",
  "steering": ["Focus on error handling"],
  "followUp": ["After that, summarize the result"]
}
```

### compaction_start / compaction_end

Emitted when compaction runs, whether manual or automatic.

```json
{"type": "compaction_start", "reason": "threshold"}
```

The `reason` field is `"manual"`, `"threshold"`, or `"overflow"`.

```json
{
  "type": "compaction_end",
  "reason": "threshold",
  "result": {
    "summary": "Summary of conversation...",
    "firstKeptEntryId": "abc123",
    "tokensBefore": 150000,
    "estimatedTokensAfter": 32000,
    "usage": {
      "input": 32000,
      "output": 1200,
      "cacheRead": 0,
      "cacheWrite": 0,
      "totalTokens": 33200,
      "cost": {"input": 0.01, "output": 0.02, "cacheRead": 0, "cacheWrite": 0, "total": 0.03}
    },
    "details": {}
  },
  "aborted": false,
  "willRetry": false
}
```

If `reason` was `"overflow"` and compaction succeeds, `willRetry` is `true` and the agent will automatically retry the prompt.

If compaction was aborted, `result` is `null` and `aborted` is `true`.

If compaction failed (e.g., API quota exceeded), `result` is `null`, `aborted` is `false`, and `errorMessage` contains the error description.

### auto_retry_start / auto_retry_end

Emitted when automatic retry is triggered after a transient error (overloaded, rate limit, 5xx).

```json
{
  "type": "auto_retry_start",
  "attempt": 1,
  "maxAttempts": 3,
  "delayMs": 2000,
  "errorMessage": "529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}"
}
```

```json
{
  "type": "auto_retry_end",
  "success": true,
  "attempt": 2
}
```

On final failure (max retries exceeded):
```json
{
  "type": "auto_retry_end",
  "success": false,
  "attempt": 3,
  "finalError": "529 overloaded_error: Overloaded"
}
```

### summarization_retry_scheduled / summarization_retry_attempt_start / summarization_retry_finished

Emitted when compaction or branch-summary summarization retries after a transient provider error. These events use the same retry settings as automatic assistant-turn retries.

```json
{
  "type": "summarization_retry_scheduled",
  "attempt": 1,
  "maxAttempts": 3,
  "delayMs": 2000,
  "errorMessage": "terminated"
}
```

```json
{
  "type": "summarization_retry_attempt_start",
  "source": "compaction",
  "reason": "threshold"
}
```

For branch summaries, `source` is `"branchSummary"` and no `reason` is present.

```json
{
  "type": "summarization_retry_finished"
}
```

### skill_invocation

Emitted once after one or more explicit skill tokens are expanded. `skills` preserves invocation order.
`syntax` reports the token form that selected the skill; `path` is the resolved `SKILL.md` path.

```json
{
  "type": "skill_invocation",
  "skills": [
    {
      "name": "debugging",
      "path": "/project/.agents/skills/debugging/SKILL.md",
      "syntax": "dollar"
    },
    {
      "name": "review",
      "path": "/project/.agents/skills/review/SKILL.md",
      "syntax": "slash"
    }
  ]
}
```

In multi-session mode the normal routing `sessionId` is added. This event does not mutate loaded
surfaces; clients continue to use `loaded_surfaces_changed` plus `get_loaded_surfaces` for MCP reveal.

### commands_changed

Emitted whenever a post-bind runtime reload changes the ordered command surface. The initial surface is available
through `get_commands` and does not emit this invalidation event. The `commands` payload has the same shape and
ordering as `get_commands`; identical snapshots are not re-emitted.

```json
{
  "type": "commands_changed",
  "commands": [
    {"name": "session-name", "source": "extension", "syntax": "slash", "sourceInfo": {"path": "/project/extensions/session.ts", "source": "auto", "scope": "project", "origin": "top-level"}},
    {"name": "skill:debugging", "source": "skill", "syntax": "dollar", "sourceInfo": {"path": "/project/.agents/skills/debugging/SKILL.md", "source": "auto", "scope": "project", "origin": "top-level"}}
  ]
}
```

### command_invocation

Emitted exactly once after the session resolves an extension command, or after a prompt template survives extension
input interception and prompt acceptance. Unknown, transformed, or rejected commands do not produce this event;
skills continue to use `skill_invocation`.

```json
{
  "type": "command_invocation",
  "command": {
    "name": "session-name",
    "source": "extension",
    "syntax": "slash",
    "sourceInfo": {"path": "/project/extensions/session.ts", "source": "auto", "scope": "project", "origin": "top-level"}
  }
}
```

### loaded_surfaces_changed

Emitted without a request id when the loaded skill, extension, or MCP inventory changes. The event carries no inventory payload; clients re-read `get_commands` for skills and `get_loaded_surfaces` for extensions/MCP, mirroring the app-server `skills/changed` invalidation model.

```json
{"type": "loaded_surfaces_changed"}
```

### extension_error

Emitted when an extension throws an error.

```json
{
  "type": "extension_error",
  "extensionPath": "/path/to/extension.ts",
  "event": "tool_call",
  "error": "Error message..."
}
```

## Extension UI Protocol

Extensions can request user interaction via `ctx.ui.select()`, `ctx.ui.confirm()`, etc. In RPC mode, these are translated into a request/response sub-protocol on top of the base command/event flow.

There are two categories of extension UI methods:

- **Dialog methods** (`select`, `confirm`, `input`, `editor`): emit an `extension_ui_request` on stdout and block until the client sends back an `extension_ui_response` on stdin with the matching `id`.
- **Fire-and-forget methods** (`notify`, `setStatus`, `setWidget`, `setHeader`, `setFooter`, `setTitle`, `set_editor_text`): emit an `extension_ui_request` on stdout but do not expect a response. The client can display the information or ignore it.

If a dialog method includes a `timeout` field, the agent-side will auto-resolve with a default value when the timeout expires. The client does not need to track timeouts.

Some `ExtensionUIContext` methods are not supported or degraded in RPC mode because they require direct TUI access:
- `custom()` returns `undefined`
- `setWorkingMessage()`, `setWorkingIndicator()`, `setEditorComponent()`, `setToolsExpanded()` are no-ops. `setFooter()` and `setHeader()` render factory components for clients advertising `rendered_components`.
- `getEditorText()` returns `""`
- `getToolsExpanded()` returns `false`
- `pasteToEditor()` delegates to `setEditorText()` (no paste/collapse handling)
- `getAllThemes()` returns `[]`
- `getTheme()` returns `undefined`
- `setTheme()` returns `{ success: false, error: "..." }`

Note: `ctx.mode` is `"rpc"` and `ctx.hasUI` is `true` in RPC mode because the dialog and fire-and-forget methods are functional via the extension UI sub-protocol. Use `ctx.mode === "tui"` to guard TUI-specific features like `custom()` that require a real terminal.

### Extension UI Requests (stdout)

All requests have `type: "extension_ui_request"`, a unique `id`, and a `method` field.

#### select

Prompt the user to choose from a list. Dialog methods with a `timeout` field include the timeout in milliseconds; the agent auto-resolves with `undefined` if the client doesn't respond in time.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-1",
  "method": "select",
  "title": "Allow dangerous command?",
  "options": ["Allow", "Block"],
  "timeout": 10000
}
```

Expected response: `extension_ui_response` with `value` (the selected option string) or `cancelled: true`.

#### confirm

Prompt the user for yes/no confirmation.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-2",
  "method": "confirm",
  "title": "Clear session?",
  "message": "All messages will be lost.",
  "timeout": 5000
}
```

Expected response: `extension_ui_response` with `confirmed: true/false` or `cancelled: true`.

#### input

Prompt the user for free-form text.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-3",
  "method": "input",
  "title": "Enter a value",
  "placeholder": "type something..."
}
```

Expected response: `extension_ui_response` with `value` (the entered text) or `cancelled: true`.

#### editor

Open a multi-line text editor with optional prefilled content.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-4",
  "method": "editor",
  "title": "Edit some text",
  "prefill": "Line 1\nLine 2\nLine 3"
}
```

Expected response: `extension_ui_response` with `value` (the edited text) or `cancelled: true`.

#### notify

Display a notification. Fire-and-forget, no response expected.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-5",
  "method": "notify",
  "message": "Command blocked by user",
  "notifyType": "warning"
}
```

The `notifyType` field is `"info"`, `"warning"`, or `"error"`. Defaults to `"info"` if omitted.

#### setStatus

Set or clear a status entry in the footer/status bar. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-6",
  "method": "setStatus",
  "statusKey": "my-ext",
  "statusText": "Turn 3 running..."
}
```

Send `statusText: undefined` (or omit it) to clear the status entry for that key.

#### setWidget

Set or clear a widget (block of text lines) displayed above or below the editor. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-7",
  "method": "setWidget",
  "widgetKey": "my-ext",
  "widgetLines": ["--- My Widget ---", "Line 1", "Line 2"],
  "widgetPlacement": "aboveEditor"
}
```

Send `widgetLines: undefined` (or omit it) to clear the widget. The `widgetPlacement` field is `"aboveEditor"` (default) or `"belowEditor"`. Component factories are rendered by the host using the attached client's terminal width.

#### setHeader / setFooter

Set or clear the extension header or footer using rendered text lines. Clients that do not understand these additive methods ignore them.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-10",
  "method": "setHeader",
  "widgetLines": ["Header line"]
}
```

Omit `widgetLines` to restore the built-in surface. Attached clients send `set_client_info` with their terminal width after attach and on resize; hosts default to width 80 when no width is supplied.

#### setTitle

Set the terminal window/tab title. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-8",
  "method": "setTitle",
  "title": "senpi - my project"
}
```

#### set_editor_text

Set the text in the input editor. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-9",
  "method": "set_editor_text",
  "text": "prefilled text for the user"
}
```

### Extension UI Responses (stdin)

Responses are sent for dialog methods only (`select`, `confirm`, `input`, `editor`). The `id` must match the request.

#### Value response (select, input, editor)

```json
{"type": "extension_ui_response", "id": "uuid-1", "value": "Allow"}
```

#### Confirmation response (confirm)

```json
{"type": "extension_ui_response", "id": "uuid-2", "confirmed": true}
```

#### Cancellation response (any dialog)

Dismiss any dialog method. The extension receives `undefined` (for select/input/editor) or `false` (for confirm).

```json
{"type": "extension_ui_response", "id": "uuid-3", "cancelled": true}
```

## Error Handling

Failed commands return a response with `success: false`:

```json
{
  "type": "response",
  "command": "set_model",
  "success": false,
  "error": "Model not found: invalid/model"
}
```

Parse errors:

```json
{
  "type": "response",
  "command": "parse",
  "success": false,
  "error": "Failed to parse command: Unexpected token..."
}
```

## Types

Source files:
- [`packages/ai/src/types.ts`](../../ai/src/types.ts) - `Model`, `UserMessage`, `AssistantMessage`, `ToolResultMessage`
- [`packages/agent/src/types.ts`](../../agent/src/types.ts) - `AgentMessage`, `AgentEvent`
- [`src/core/messages.ts`](../src/core/messages.ts) - `BashExecutionMessage`
- [`src/modes/json-event.ts`](../src/modes/json-event.ts) - `JsonAgentSessionEvent`
- [`src/modes/rpc/rpc-types.ts`](../src/modes/rpc/rpc-types.ts) - RPC command/response types, extension UI request/response types

### Model

```json
{
  "id": "claude-sonnet-4-20250514",
  "name": "Claude Sonnet 4",
  "api": "anthropic-messages",
  "provider": "anthropic",
  "baseUrl": "https://api.anthropic.com",
  "reasoning": true,
	  "supportedThinkingLevels": ["off", "minimal", "low", "medium", "high"],
  "input": ["text", "image"],
  "contextWindow": 200000,
  "maxTokens": 16384,
  "cost": {
    "input": 3.0,
    "output": 15.0,
    "cacheRead": 0.3,
    "cacheWrite": 3.75
  }
}
```

| Field | Description |
| --- | --- |
| `supportedThinkingLevels` | Thinking levels accepted by this model. Non-reasoning models expose only `"off"`. |

### UserMessage

```json
{
  "role": "user",
  "content": "Hello!",
  "timestamp": 1733234567890,
  "attachments": []
}
```

The `content` field can be a string or an array of `TextContent`/`ImageContent` blocks.

### AssistantMessage

```json
{
  "role": "assistant",
  "content": [
    {"type": "text", "text": "Hello! How can I help?"},
    {"type": "thinking", "thinking": "User is greeting me..."},
    {"type": "toolCall", "id": "call_123", "name": "bash", "arguments": {"command": "ls"}}
  ],
  "api": "anthropic-messages",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "usage": {
    "input": 100,
    "output": 50,
    "cacheRead": 0,
    "cacheWrite": 0,
    "cost": {"input": 0.0003, "output": 0.00075, "cacheRead": 0, "cacheWrite": 0, "total": 0.00105}
  },
  "stopReason": "stop",
  "timestamp": 1733234567890
}
```

Stop reasons: `"stop"`, `"length"`, `"toolUse"`, `"error"`, `"aborted"`

### ToolResultMessage

```json
{
  "role": "toolResult",
  "toolCallId": "call_123",
  "toolName": "bash",
  "content": [{"type": "text", "text": "total 48\ndrwxr-xr-x ..."}],
  "usage": {
    "input": 100,
    "output": 50,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 150,
    "cost": {"input": 0.0003, "output": 0.00075, "cacheRead": 0, "cacheWrite": 0, "total": 0.00105}
  },
  "isError": false,
  "timestamp": 1733234567890
}
```

`usage` is optional and reports nested LLM work performed by the tool. When present, it contributes to session token and cost totals.

### BashExecutionMessage

Created by the `bash` RPC command (not by LLM tool calls):

```json
{
  "role": "bashExecution",
  "command": "ls -la",
  "output": "total 48\ndrwxr-xr-x ...",
  "exitCode": 0,
  "cancelled": false,
  "truncated": false,
  "fullOutputPath": null,
  "timestamp": 1733234567890
}
```

### Attachment

```json
{
  "id": "img1",
  "type": "image",
  "fileName": "photo.jpg",
  "mimeType": "image/jpeg",
  "size": 102400,
  "content": "base64-encoded-data...",
  "extractedText": null,
  "preview": null
}
```

## Example: Basic Client (Python)

```python
import subprocess
import json

proc = subprocess.Popen(
    ["senpi", "--mode", "rpc", "--no-session"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True
)

def send(cmd):
    proc.stdin.write(json.dumps(cmd) + "\n")
    proc.stdin.flush()

def read_events():
    for line in proc.stdout:
        yield json.loads(line)

# Send prompt
send({"type": "prompt", "message": "Hello!"})

# Process events
for event in read_events():
    if event.get("type") == "message_update":
        delta = event.get("assistantMessageEvent", {})
        if delta.get("type") == "text_delta":
            print(delta["delta"], end="", flush=True)
    
    if event.get("type") == "agent_end":
        print()
        break
```

## Example: Interactive Client (Node.js)

See [`test/rpc-example.ts`](../test/rpc-example.ts) for a complete interactive example, or [`src/modes/rpc/rpc-client.ts`](../src/modes/rpc/rpc-client.ts) for a typed client implementation.

For a complete example of handling the extension UI protocol, see [`examples/rpc-extension-ui.ts`](../examples/rpc-extension-ui.ts) which pairs with the [`examples/extensions/rpc-demo.ts`](../examples/extensions/rpc-demo.ts) extension.

```javascript
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");

const agent = spawn("senpi", ["--mode", "rpc", "--no-session"]);

function attachJsonlReader(stream, onLine) {
    const decoder = new StringDecoder("utf8");
    let buffer = "";

    stream.on("data", (chunk) => {
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

        while (true) {
            const newlineIndex = buffer.indexOf("\n");
            if (newlineIndex === -1) break;

            let line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            onLine(line);
        }
    });

    stream.on("end", () => {
        buffer += decoder.end();
        if (buffer.length > 0) {
            onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
        }
    });
}

attachJsonlReader(agent.stdout, (line) => {
    const event = JSON.parse(line);

    if (event.type === "message_update") {
        const { assistantMessageEvent } = event;
        if (assistantMessageEvent.type === "text_delta") {
            process.stdout.write(assistantMessageEvent.delta);
        }
    }
});

// Send prompt
agent.stdin.write(JSON.stringify({ type: "prompt", message: "Hello" }) + "\n");

// Abort on Ctrl+C
process.on("SIGINT", () => {
    agent.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
});
```
