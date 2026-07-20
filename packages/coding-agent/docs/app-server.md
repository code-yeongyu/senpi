# App Server Mode

App Server mode exposes senpi as a Codex-compatible JSON-RPC server for app and editor integrations.

## Starting App Server Mode

Primary websocket recipe:

```bash
senpi app-server --listen ws://127.0.0.1:18990
```

The websocket listener binds only to IP literal hosts. When `--ws-auth` is omitted, senpi creates or reuses a bearer token file at `${SENPI_CODING_AGENT_DIR:-~/.senpi/agent}/app-server/ws-token`, prints that path to stderr, and requires `Authorization: Bearer <token>` on websocket upgrades.

```bash
token="$(cat ~/.senpi/agent/app-server/ws-token)"
websocat -H "Authorization: Bearer $token" ws://127.0.0.1:18990/
```

Authentication options:

- `--ws-auth <path>` reads the bearer token from an explicit file.
- `--ws-auth off` disables bearer auth only for loopback websocket hosts.

For an embedded subprocess, use stdio:

```bash
senpi app-server --listen stdio://
```

`stdio://` is also the default when `--listen` is omitted. The command accepts `unix://` and `unix:///abs/path` in the `--listen` grammar for local-control socket addresses, but this document does not cover daemon lifecycle or control-socket management.

## Protocol Overview

App Server mode speaks JSON-RPC-shaped messages without a `jsonrpc` field. A request has `id`, `method`, and optional `params`; a success response has `id` and `result`; an error response has `id` and `error`.

Clients must send `initialize` before any other request. Requests before initialization return `-32000 Not initialized`; a second `initialize` returns `-32000 Already initialized`. Methods that are not implemented return `-32601 Method not found`, including unsupported Codex methods such as `thread/search`.

The protocol types are generated from `codex-cli 0.142.5` and adapted through the app-facing facade in `src/modes/app-server/protocol/`. Regenerate the raw pinned types with:

```bash
packages/coding-agent/scripts/generate-app-server-protocol.sh
```

Wire compatibility is the JSON-RPC message shape documented here, not the raw generated TypeScript tree.

## Framing

For `stdio://`, each message is one UTF-8 JSON object followed by LF (`\n`). stdout is reserved for protocol frames; status and logs go to stderr.

For `ws://`, each websocket text frame is one JSON object. Binary frames are ignored. HTTP `Origin` headers are rejected, `/readyz` and `/healthz` return `ok\n` while the listener is accepting connections, and websocket clients that exceed outbound backpressure limits are closed with code `1013`.

## Methods

### initialize

Initialize the connection and declare client capabilities. The response shape below is backed by the fresh stdio run captured by `test/qa/app-server/task20-doc-example-check.ts`.

Request:

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"task20-docs","title":"Task 20 Docs","version":"0.0.1"},"capabilities":{"experimentalApi":true,"requestAttestation":false}}}
```

Response:

```json
{"id":1,"result":{"userAgent":"task20-docs/2026.7.2 (Darwin 25.4.0; arm64) senpi_app_server","codexHome":"/tmp/senpi-task20-docs/agent","platformFamily":"unix","platformOs":"macos"}}
```

`capabilities.experimentalApi` gates experimental methods and notifications. `capabilities.optOutNotificationMethods` may list notification method names the client does not want to receive.

### model/list

List configured models. The live response contains the full model catalog; this reduced response keeps the same object field shape as the live wire output.

Request:

```json
{"id":2,"method":"model/list","params":{"includeHidden":false}}
```

Response:

```json
{"id":2,"result":{"data":[{"id":"anthropic/claude-opus-4-8","model":"claude-opus-4-8","upgrade":null,"upgradeInfo":null,"availabilityNux":null,"displayName":"Claude Opus 4.8","description":"","hidden":false,"supportedReasoningEfforts":[{"reasoningEffort":"minimal","description":""},{"reasoningEffort":"low","description":""},{"reasoningEffort":"medium","description":""},{"reasoningEffort":"high","description":""},{"reasoningEffort":"xhigh","description":""},{"reasoningEffort":"max","description":""}],"defaultReasoningEffort":"medium","inputModalities":["text"],"supportsPersonality":false,"additionalSpeedTiers":[],"serviceTiers":[],"defaultServiceTier":null,"isDefault":true}],"nextCursor":null}}
```

### config/read and configRequirements/read

`config/read` intentionally exposes only the settings that have a direct Senpi mapping. The effective config uses the
requested `cwd` to resolve project settings; when `includeLayers` is true, the response includes the `user` settings
file followed by the project `.senpi/settings.json` layer. Settings without a wire mapping are omitted from both the
effective config and layer payloads.

| Wire key | Senpi source | Unset behavior |
|---|---|---|
| `model` | `SettingsManager` default model id | `null` |
| `model_provider` | `SettingsManager` default provider | `null` |
| `approval_policy` | Senpi permission posture | always `"never"` |
| `sandbox_mode` | Senpi permission posture | always `"danger-full-access"` |
| `model_reasoning_effort` | `SettingsManager` default thinking level | `null` |

The response uses `user` and `project` layer origins only when the corresponding setting is present in that layer;
fixed Senpi posture values have no fabricated settings origin. `configRequirements/read` returns
`{"requirements":null}` because Senpi has no requirements source.

### remoteControl/status/read

Read the current remote-control status stub. This method requires `capabilities.experimentalApi: true`.

Request:

```json
{"id":3,"method":"remoteControl/status/read"}
```

Response:

```json
{"id":3,"result":{"status":"inactive"}}
```

Without the experimental capability, the same request returns:

```json
{"id":3,"error":{"code":-32600,"message":"remoteControl/status/read requires experimentalApi capability"}}
```

### thread/start

Start a new app-server thread and subscribe the initializing connection to that thread.

Request:

```json
{"id":4,"method":"thread/start","params":{"cwd":"/tmp/senpi-task20-docs/cwd"}}
```

Response:

```json
{"id":4,"result":{"thread":{"id":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","sessionId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","forkedFromId":null,"parentThreadId":null,"preview":"","ephemeral":false,"modelProvider":"anthropic","createdAt":1783017975.555,"updatedAt":1783017975.555,"recencyAt":1783017975.555,"status":{"type":"idle"},"path":"/tmp/senpi-task20-docs/sessions/2026-07-02T18-46-15-501Z_019f2427-2ecd-743b-bfec-f7381ee0ccd2.jsonl","cwd":"/tmp/senpi-task20-docs/cwd","cliVersion":"2026.7.2","source":"appServer","threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"turns":[]},"model":"claude-opus-4-8","modelProvider":"anthropic","serviceTier":null,"cwd":"/tmp/senpi-task20-docs/cwd","runtimeWorkspaceRoots":["/tmp/senpi-task20-docs/cwd"],"instructionSources":[],"approvalPolicy":"never","approvalsReviewer":"user","sandbox":{"type":"dangerFullAccess"},"activePermissionProfile":null,"reasoningEffort":"medium","multiAgentMode":"explicitRequestOnly"}}
```

The server may emit a `thread/started` notification before the correlated response.

### thread/resume

Load an existing saved thread and subscribe the connection to it.

Request:

```json
{"id":5,"method":"thread/resume","params":{"threadId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2"}}
```

Response:

```json
{"id":5,"result":{"thread":{"id":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","sessionId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","forkedFromId":null,"parentThreadId":null,"preview":"","ephemeral":false,"modelProvider":"anthropic","createdAt":1783017975.555,"updatedAt":1783017975.555,"recencyAt":1783017975.555,"status":{"type":"idle"},"path":"/tmp/senpi-task20-docs/sessions/2026-07-02T18-46-15-501Z_019f2427-2ecd-743b-bfec-f7381ee0ccd2.jsonl","cwd":"/tmp/senpi-task20-docs/cwd","cliVersion":"2026.7.2","source":"appServer","threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"turns":[]},"model":"claude-opus-4-8","modelProvider":"anthropic","serviceTier":null,"cwd":"/tmp/senpi-task20-docs/cwd","runtimeWorkspaceRoots":["/tmp/senpi-task20-docs/cwd"],"instructionSources":[],"approvalPolicy":"never","approvalsReviewer":"user","sandbox":{"type":"dangerFullAccess"},"activePermissionProfile":null,"reasoningEffort":"medium","multiAgentMode":"explicitRequestOnly","initialTurnsPage":null}}
```

### thread/list

List saved and loaded threads. The response includes `backwardsCursor` for Codex compatibility.

Request:

```json
{"id":6,"method":"thread/list","params":{"limit":1}}
```

Response:

```json
{"id":6,"result":{"data":[{"id":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","sessionId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","forkedFromId":null,"parentThreadId":null,"preview":"","ephemeral":false,"modelProvider":"unknown","createdAt":1783017975.555,"updatedAt":1783017975.555,"recencyAt":1783017975.555,"status":{"type":"idle"},"path":"/tmp/senpi-task20-docs/sessions/2026-07-02T18-46-15-501Z_019f2427-2ecd-743b-bfec-f7381ee0ccd2.jsonl","cwd":"/tmp/senpi-task20-docs/cwd","cliVersion":"2026.7.2","source":"appServer","threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"turns":[]}],"nextCursor":null,"backwardsCursor":null}}
```

### thread/loaded/list

List loaded thread IDs in the current app-server process. The `data` array contains only `string` thread IDs.

Request:

```json
{"id":7,"method":"thread/loaded/list","params":{"limit":1}}
```

Response:

```json
{"id":7,"result":{"data":["019f2427-2ecd-743b-bfec-f7381ee0ccd2"],"nextCursor":null}}
```

### thread/read

Read one thread. Pass `includeTurns: true` to include turn records.

Request:

```json
{"id":8,"method":"thread/read","params":{"threadId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","includeTurns":false}}
```

Response:

```json
{"id":8,"result":{"thread":{"id":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","sessionId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","forkedFromId":null,"parentThreadId":null,"preview":"","ephemeral":false,"modelProvider":"anthropic","createdAt":1783017975.555,"updatedAt":1783017975.555,"recencyAt":1783017975.555,"status":{"type":"idle"},"path":"/tmp/senpi-task20-docs/sessions/2026-07-02T18-46-15-501Z_019f2427-2ecd-743b-bfec-f7381ee0ccd2.jsonl","cwd":"/tmp/senpi-task20-docs/cwd","cliVersion":"2026.7.2","source":"appServer","threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"turns":[]}}}
```

### thread/name/set

Set the display name for a thread.

Request:

```json
{"id":9,"method":"thread/name/set","params":{"threadId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","name":"Docs example"}}
```

Response:

```json
{"id":9,"result":{}}
```

### thread/fork

Fork a thread into a new session-backed thread.

Request:

```json
{"id":13,"method":"thread/fork","params":{"threadId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","cwd":"/tmp/senpi-task20-docs/fork"}}
```

Response:

```json
{"id":13,"result":{"thread":{"id":"019f2427-2f05-7415-818f-5946d46873fe","sessionId":"019f2427-2f05-7415-818f-5946d46873fe","forkedFromId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","parentThreadId":null,"preview":"","ephemeral":false,"modelProvider":"anthropic","createdAt":1783017975.583,"updatedAt":1783017975.583,"recencyAt":1783017975.583,"status":{"type":"idle"},"path":"/tmp/senpi-task20-docs/sessions/2026-07-02T18-46-15-557Z_019f2427-2f05-7415-818f-5946d46873fe.jsonl","cwd":"/tmp/senpi-task20-docs/fork","cliVersion":"2026.7.2","source":"appServer","threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"turns":[]},"model":"claude-opus-4-8","modelProvider":"anthropic","serviceTier":null,"cwd":"/tmp/senpi-task20-docs/fork","runtimeWorkspaceRoots":["/tmp/senpi-task20-docs/fork"],"instructionSources":[],"approvalPolicy":"never","approvalsReviewer":"user","sandbox":{"type":"dangerFullAccess"},"activePermissionProfile":null,"reasoningEffort":"medium","multiAgentMode":"explicitRequestOnly"}}
```

### thread/archive

Archive and unload a thread.

Request:

```json
{"id":14,"method":"thread/archive","params":{"threadId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2"}}
```

Response:

```json
{"id":14,"result":{}}
```

### thread/delete

Delete a thread.

Request:

```json
{"id":15,"method":"thread/delete","params":{"threadId":"019f2427-2f05-7415-818f-5946d46873fe"}}
```

Response:

```json
{"id":15,"result":{}}
```

### thread/unsubscribe

Unsubscribe the current connection from a loaded thread. The live example below runs after `thread/archive`, so the thread has already unloaded and the response status is `notLoaded`.

Request:

```json
{"id":16,"method":"thread/unsubscribe","params":{"threadId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2"}}
```

Response:

```json
{"id":16,"result":{"status":"notLoaded"}}
```

### turn/start

Start an agent turn on a loaded thread. A successful turn requires a loaded thread and model execution; this live no-token example documents the current error response for a missing thread.

Request:

```json
{"id":12,"method":"turn/start","params":{"threadId":"missing-thread","input":[{"type":"text","text":"Say ok."}]}}
```

Response:

```json
{"id":12,"error":{"code":-32603,"message":"Thread not found: missing-thread"}}
```

### turn/steer

Queue steering text for an active turn. The live no-token example documents the current error response when the thread has no active turn.

Request:

```json
{"id":11,"method":"turn/steer","params":{"threadId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","expectedTurnId":"not-active","input":[{"type":"text","text":"Prefer brevity."}]}}
```

Response:

```json
{"id":11,"error":{"code":-32603,"message":"No active turn for thread 019f2427-2ecd-743b-bfec-f7381ee0ccd2"}}
```

### turn/interrupt

Interrupt an active turn. Interrupting a non-active or already-finished turn is a successful no-op.

Request:

```json
{"id":10,"method":"turn/interrupt","params":{"threadId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","turnId":"not-active"}}
```

Response:

```json
{"id":10,"result":{}}
```

### thread/search

`thread/search` is part of the Codex request catalog, but senpi app-server does not implement it yet. It returns `-32601`.

Request:

```json
{"id":17,"method":"thread/search","params":{"query":"docs"}}
```

Response:

```json
{"id":17,"error":{"code":-32601,"message":"Method not found: thread/search"}}
```

## Implemented Method Inventory

Implemented stable methods:

- `initialize`
- `model/list`
- `thread/start`, `thread/resume`, `thread/fork`, `thread/read`, `thread/list`, `thread/loaded/list`, `thread/name/set`, `thread/archive`, `thread/delete`, `thread/unsubscribe`
- `turn/start`, `turn/steer`, `turn/interrupt`

Implemented experimental methods:

- `remoteControl/status/read`, returning the inactive status stub

Every other stable or experimental Codex request method currently returns `-32601 Method not found`, except experimental methods that first fail the capability gate with `-32600`.

## Notifications And Routing

Clients must route two independent streams:

- Responses correlate to requests by `id`.
- Notifications have `method` and optional `params`, no `id`, and may arrive before, between, or after correlated responses.

Broadcast notifications currently include thread lifecycle and status changes such as `thread/started`, `thread/status/changed`, `thread/closed`, `thread/deleted`, `thread/archived`, `thread/name/updated`, and `thread/tokenUsage/updated`. Thread-scoped notifications are delivered only to connections subscribed to that thread. Terminal notifications such as `turn/completed` and `error` are queued briefly when no subscriber is attached, then replayed to the next subscriber until the per-thread terminal queue limit is reached.

Experimental notifications such as `remoteControl/status/changed` are delivered only when the connection initialized with `capabilities.experimentalApi: true`. Clients may opt out of specific notification method names during `initialize`.

## Approvals Flow

When a running turn needs user approval, the server sends a request-like outbound message to subscribers of the affected thread. Approval request methods include `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`.

Command approval decisions are `accept`, `acceptForSession`, `decline`, and `cancel`. `acceptForSession` is remembered for matching command approvals in the same thread. If no subscriber is attached, the approval is declined with a no-subscriber reason. When a turn ends, pending approvals for that thread are cancelled and `serverRequest/resolved` is emitted.

## Multi-Session Semantics

Each app-server process can keep multiple loaded threads. `thread/start`, `thread/resume`, and `thread/fork` load a thread and subscribe the current connection. `thread/unsubscribe` detaches only that connection; the thread may unload after the idle timeout when it has no subscribers and no active turn. A websocket listener can serve multiple initialized clients concurrently. Stdio mode serves one process-owned connection.

The app-server `TurnLog` is retained for the lifetime of the process. Idle unload disposes the session but does not release its turn log, so unloading and then resuming a thread in the same process preserves full `thread/turns/list` and `thread/items/list` history. A process restart loses that in-memory log and falls back to the documented user-message-only reconstruction.
