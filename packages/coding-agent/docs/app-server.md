# App Server Mode

App Server mode exposes Senpi as a Codex-compatible JSON-RPC server for app and editor integrations. See
[App Server Daemon](app-server-daemon.md) when the listener should be managed as a background process.

## Starting App Server Mode

Primary websocket recipe:

```bash
senpi app-server --listen ws://127.0.0.1:18990
```

The websocket listener binds only to IP literal hosts. When `--ws-auth` is omitted, Senpi creates or reuses a bearer
token file at `${SENPI_CODING_AGENT_DIR:-~/.senpi/agent}/app-server/ws-token`, prints that path to stderr, and
requires `Authorization: Bearer <token>` on websocket upgrades.

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

`stdio://` is also the default when `--listen` is omitted. The command accepts `unix://` and
`unix:///abs/path` in the `--listen` grammar for local-control socket addresses, but this document does not cover
daemon lifecycle or control-socket management.

## Protocol Overview

App Server mode speaks JSON-RPC-shaped messages without a `jsonrpc` field. A request has `id`, `method`, and optional
`params`; a success response has `id` and `result`; an error response has `id` and `error`.

Clients must send `initialize` before any other request. Requests before initialization return `-32000 Not initialized`;
a second `initialize` returns `-32000 Already initialized`. A request marked experimental requires
`capabilities.experimentalApi: true`; without it, Senpi returns `-32600`. After initialization, methods in the
[Intentional `-32601` Surface](#intentional--32601-surface) return `-32601 Method not found` rather than a partial or
invented implementation.

All server notifications use the current Codex envelope and include `emittedAtMs`. Clients must tolerate notifications
before, between, and after correlated responses, except where a method explicitly guarantees response-before-notification
ordering below.

## Protocol Provenance

The raw TypeScript fixture is pinned to Codex git
[`0fb559f0f6e231a88ac02ea002d3ecd248e2b515`](https://github.com/openai/codex) (author date 2026-07-18), not to a
published `codex-cli` package version. It is copied from:

```text
codex-rs/app-server-protocol/schema/typescript
```

Regenerate it from the source checkout with:

```bash
packages/coding-agent/scripts/generate-app-server-protocol.sh \
  --from-checkout /Users/yeongyu/local-workspaces/codex
```

`src/modes/app-server/protocol/generated/` is evidence only: it remains byte-identical to Codex except for the local
`package.json` compilation shim and is never a runtime dependency. Senpi's non-generated protocol facade is the runtime
contract. It also supplies selected experimental request types because Codex's TypeScript exporter intentionally omits
experimental request roots even though Codex serves them. See
[`src/modes/app-server/protocol/README.md`](../src/modes/app-server/protocol/README.md) for the vendoring and facade
rules.

## Framing

For `stdio://`, each message is one UTF-8 JSON object followed by LF (`\n`). stdout is reserved for protocol frames;
status and logs go to stderr.

For `ws://`, each websocket text frame is one JSON object. Binary frames are ignored. HTTP `Origin` headers are rejected,
`/readyz` and `/healthz` return `ok\n` while the listener is accepting connections, and websocket clients that exceed
outbound backpressure limits are closed with code `1013`.

## Live Examples

The examples in this section are checked against a fresh isolated stdio server by
`test/qa/app-server/task20-doc-example-check.ts`. Identifiers, timestamps, paths, and installed models naturally vary.
The isolated checker has no configured model, so its `model/list` example intentionally has an empty `data` array.

### initialize

Initialize the connection and declare client capabilities.

Request:

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"task20-docs","title":"Task 20 Docs","version":"0.0.1"},"capabilities":{"experimentalApi":true,"requestAttestation":false}}}
```

Response:

```json
{"id":1,"result":{"userAgent":"task20-docs/2026.7.2 (Darwin 25.4.0; arm64) senpi_app_server","codexHome":"/tmp/senpi-task20-docs/agent","platformFamily":"unix","platformOs":"macos"}}
```

`capabilities.experimentalApi` gates experimental requests and experimental notifications.
`capabilities.optOutNotificationMethods` may list notification method names the client does not want to receive.

### model/list

List configured models. `includeHidden`, a numeric cursor, and a minimum page size of one are supported. Model records
include Codex-compatible reasoning-effort, service-tier, and `isDefault` fields when a model is configured.

Request:

```json
{"id":2,"method":"model/list","params":{"includeHidden":false}}
```

Response:

```json
{"id":2,"result":{"data":[],"nextCursor":null}}
```

### config/read and configRequirements/read

`config/read` intentionally exposes only settings with a direct Senpi mapping. The effective config uses the requested
`cwd` to resolve project settings; when `includeLayers` is true, the response includes the user settings file followed by
the project `.senpi/settings.json` layer. Settings without a wire mapping are omitted from both the effective config and
layer payloads.

| Wire key | Senpi source | Unset behavior |
|---|---|---|
| `model` | `SettingsManager` default model id | `null` |
| `model_provider` | `SettingsManager` default provider | `null` |
| `approval_policy` | Senpi permission posture | always `"never"` |
| `sandbox_mode` | Senpi permission posture | always `"danger-full-access"` |
| `model_reasoning_effort` | `SettingsManager` default thinking level | `null` |

The response uses `user` and `project` layer origins only when the corresponding setting is present in that layer; fixed
Senpi posture values have no fabricated settings origin. `configRequirements/read` returns `{"requirements":null}`
because Senpi has no requirements source. Configuration writes are deliberately unsupported; see the `-32601` table.

### remoteControl/status/read

Read Senpi's disabled remote-control status. This method requires `capabilities.experimentalApi: true`.

Request:

```json
{"id":3,"method":"remoteControl/status/read"}
```

Response:

```json
{"id":3,"result":{"status":"disabled","serverName":"senpi app-server","installationId":"00000000-0000-4000-8000-000000000000","environmentId":null}}
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
{"id":4,"result":{"thread":{"id":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","sessionId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","forkedFromId":null,"parentThreadId":null,"preview":"","ephemeral":false,"modelProvider":"unknown","createdAt":1783017975.555,"updatedAt":1783017975.555,"recencyAt":1783017975.555,"status":{"type":"idle"},"path":"/tmp/senpi-task20-docs/sessions/2026-07-02T18-46-15-501Z_019f2427-2ecd-743b-bfec-f7381ee0ccd2.jsonl","cwd":"/tmp/senpi-task20-docs/cwd","cliVersion":"2026.7.2","source":"appServer","threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"turns":[]},"model":"unknown","modelProvider":"unknown","serviceTier":null,"cwd":"/tmp/senpi-task20-docs/cwd","runtimeWorkspaceRoots":["/tmp/senpi-task20-docs/cwd"],"instructionSources":[],"approvalPolicy":"never","approvalsReviewer":"user","sandbox":{"type":"dangerFullAccess"},"activePermissionProfile":null,"reasoningEffort":null,"multiAgentMode":"explicitRequestOnly"}}
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
{"id":5,"result":{"thread":{"id":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","sessionId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","forkedFromId":null,"parentThreadId":null,"preview":"","ephemeral":false,"modelProvider":"unknown","createdAt":1783017975.555,"updatedAt":1783017975.555,"recencyAt":1783017975.555,"status":{"type":"idle"},"path":"/tmp/senpi-task20-docs/sessions/2026-07-02T18-46-15-501Z_019f2427-2ecd-743b-bfec-f7381ee0ccd2.jsonl","cwd":"/tmp/senpi-task20-docs/cwd","cliVersion":"2026.7.2","source":"appServer","threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"turns":[]},"model":"unknown","modelProvider":"unknown","serviceTier":null,"cwd":"/tmp/senpi-task20-docs/cwd","runtimeWorkspaceRoots":["/tmp/senpi-task20-docs/cwd"],"instructionSources":[],"approvalPolicy":"never","approvalsReviewer":"user","sandbox":{"type":"dangerFullAccess"},"activePermissionProfile":null,"reasoningEffort":null,"multiAgentMode":"explicitRequestOnly","initialTurnsPage":null}}
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
{"id":8,"result":{"thread":{"id":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","sessionId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","forkedFromId":null,"parentThreadId":null,"preview":"","ephemeral":false,"modelProvider":"unknown","createdAt":1783017975.555,"updatedAt":1783017975.555,"recencyAt":1783017975.555,"status":{"type":"idle"},"path":"/tmp/senpi-task20-docs/sessions/2026-07-02T18-46-15-501Z_019f2427-2ecd-743b-bfec-f7381ee0ccd2.jsonl","cwd":"/tmp/senpi-task20-docs/cwd","cliVersion":"2026.7.2","source":"appServer","threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"turns":[]}}}
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
{"id":13,"result":{"thread":{"id":"019f2427-2f05-7415-818f-5946d46873fe","sessionId":"019f2427-2f05-7415-818f-5946d46873fe","forkedFromId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","parentThreadId":null,"preview":"","ephemeral":false,"modelProvider":"unknown","createdAt":1783017975.583,"updatedAt":1783017975.583,"recencyAt":1783017975.583,"status":{"type":"idle"},"path":"/tmp/senpi-task20-docs/sessions/2026-07-02T18-46-15-557Z_019f2427-2f05-7415-818f-5946d46873fe.jsonl","cwd":"/tmp/senpi-task20-docs/fork","cliVersion":"2026.7.2","source":"appServer","threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"turns":[]},"model":"unknown","modelProvider":"unknown","serviceTier":null,"cwd":"/tmp/senpi-task20-docs/fork","runtimeWorkspaceRoots":["/tmp/senpi-task20-docs/fork"],"instructionSources":[],"approvalPolicy":"never","approvalsReviewer":"user","sandbox":{"type":"dangerFullAccess"},"activePermissionProfile":null,"reasoningEffort":null,"multiAgentMode":"explicitRequestOnly"}}
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

Unsubscribe the current connection from a loaded thread. The live example below runs after `thread/archive`, so the
thread has already unloaded and the response status is `notLoaded`.

Request:

```json
{"id":16,"method":"thread/unsubscribe","params":{"threadId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2"}}
```

Response:

```json
{"id":16,"result":{"status":"notLoaded"}}
```

### turn/start

Start an agent turn on a loaded thread. A successful turn requires a loaded thread and model execution; this live
no-token example documents the current error response for a missing thread.

Request:

```json
{"id":12,"method":"turn/start","params":{"threadId":"missing-thread","input":[{"type":"text","text":"Say ok."}]}}
```

Response:

```json
{"id":12,"error":{"code":-32600,"message":"Thread not found: missing-thread"}}
```

### turn/steer

Queue steering text for an active turn. The live no-token example documents the current error response when the thread
has no active turn.

Request:

```json
{"id":11,"method":"turn/steer","params":{"threadId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","expectedTurnId":"not-active","input":[{"type":"text","text":"Prefer brevity."}]}}
```

Response:

```json
{"id":11,"error":{"code":-32600,"message":"No active turn for thread 019f2427-2ecd-743b-bfec-f7381ee0ccd2"}}
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

Search is experimental and requires `capabilities.experimentalApi: true`. `searchTerm` is case-insensitive; results use
a literal snippet, opaque request-scoped cursors, a default limit of 25 (clamped to 1..100), descending
`created_at` sort, and non-archived threads. Codex's default source filter is interactive (`cli` and `vscode`), so
app-server-created threads require `sourceKinds:["appServer"]` to be included. The isolated example has no matching
interactive thread.

Request:

```json
{"id":17,"method":"thread/search","params":{"searchTerm":"docs"}}
```

Response:

```json
{"id":17,"result":{"data":[],"nextCursor":null,"backwardsCursor":null}}
```

## Supported Request Methods

The following tables are the supported request surface. Entries marked **experimental** require
`capabilities.experimentalApi: true`. Other request validation errors use the method's documented invalid-request or
internal-error path; a listed method is not silently treated as unsupported.

### Stable Methods

| Method | Support and Senpi-specific behavior |
|---|---|
| `initialize` | Required once per connection before all other requests. |
| `model/list` | Configured models only; supports `includeHidden`, numeric cursors, and Codex HEAD model/service-tier fields. |
| `config/read` | Mapped settings subset only: model, provider, reasoning effort, and fixed Senpi permission posture. See [config/read and configRequirements/read](#configread-and-configrequirementsread). |
| `configRequirements/read` | Returns `{requirements:null}` because Senpi has no Codex requirements source. |
| `account/read` | Honest local credential state: `{account:{type:"apiKey"}}` only when a provider credential exists, otherwise `{account:null}`; `requiresOpenaiAuth:false`. |
| `account/rateLimits/read` | Implemented as an honest invalid-request error because rate limits require a Codex account. |
| `account/usage/read` | Implemented as an honest invalid-request error because token usage requires a Codex account. |
| `skills/list` | Resource-loader skills and diagnostics, returned per requested working directory. |
| `mcpServerStatus/list` | Per-loaded-session MCP status; `full` and `toolsAndAuthOnly` detail views with numeric pagination. |
| `permissionProfile/list` | Senpi's actual single `dangerFullAccess`-equivalent profile. |
| `experimentalFeature/list` | Numeric-cursor paginated Senpi feature catalog, currently allowed to be empty. |
| `fuzzyFileSearch` | One-shot subsequence file search over requested roots; an empty query returns no results. |
| `thread/start` | Creates, loads, and subscribes the calling connection to a session-backed thread. |
| `thread/resume` | Loads a saved thread and subscribes the calling connection. |
| `thread/read` | Reads a thread, optionally including turns. |
| `thread/list` | Lists saved and loaded threads with forward and backward cursors. |
| `thread/loaded/list` | Lists IDs loaded by this app-server process. |
| `thread/fork` | Creates and loads a session-backed fork. |
| `thread/name/set` | Changes the display name and broadcasts `thread/name/updated`. |
| `thread/archive` | Archives and unloads a thread. |
| `thread/unarchive` | Storage-only restore: returns `status:{type:"notLoaded"}` and then broadcasts `thread/unarchived`; it does not resume or attach the thread. |
| `thread/delete` | Deletes a thread and its app-server sidecars. |
| `thread/unsubscribe` | Detaches only the calling connection; a now-idle thread may unload later. |
| `thread/compact/start` | Acknowledges immediately and compacts the loaded thread. Context-compaction items carry progress; Senpi intentionally does not emit `thread/compacted`. |
| `thread/goal/set` | Persists a goal and broadcasts `thread/goal/updated` after the response. Accepts `active`, `paused`, and `complete`; `blocked`, `usageLimited`, and `budgetLimited` are rejected. `tokenBudget` follows omit/keep, `null`/clear, number/set semantics. |
| `thread/goal/get` | Reads the persisted thread goal or `null`. |
| `thread/goal/clear` | Clears a goal and broadcasts `thread/goal/cleared` only when a goal existed. |
| `thread/metadata/update` | Persists `gitInfo` in an app-server sidecar and returns the updated wire thread. |
| `turn/start` | Starts a turn on a loaded thread. |
| `turn/steer` | Queues input for an active turn. |
| `turn/interrupt` | Interrupts an active turn; an already-finished turn is a successful no-op. |

### Experimental Methods

| Method | Support and Senpi-specific behavior |
|---|---|
| `remoteControl/status/read` | Returns the truthful disabled status, server name, stable local installation ID, and `environmentId:null`. |
| `remoteControl/client/list` | Validates Codex-shaped parameters, then returns an honest internal error because this app-server has no remote-control handle. |
| `collaborationMode/list` | Returns Senpi's one fixed collaboration preset. Its `reasoning_effort` member is intentionally snake_case, matching Codex. |
| `thread/search` | Searches session text with source, archive, sort, and cursor filters. The default source filter excludes `appServer`; pass `sourceKinds:["appServer"]` for app-server threads. |
| `thread/searchOccurrences` | Finds literal, case-insensitive UTF-16 ranges in a thread's visible user/final-agent messages; default limit 50, clamped to 1..250. |
| `thread/turns/list` | Paginated turn history with `summary`, `full`, and `notLoaded` item views. Turn logs stay for the process lifetime, including idle unload/resume. After a process restart, reconstruction is intentionally lossy and contains user-message-only turns. |
| `thread/items/list` | Paginated items, optionally limited to a turn. It has the same post-restart history limitation as `thread/turns/list`. |
| `thread/settings/update` | **Partial:** supports only session-scoped `model` and `effort`. Unsupported setting fields fail with an invalid-request error; a successful change sends `thread/settings/updated` only to thread subscribers after the response. |
| `fuzzyFileSearch/sessionStart` | Starts a session over requested roots. |
| `fuzzyFileSearch/sessionUpdate` | Updates a session query and emits `fuzzyFileSearch/sessionUpdated` followed by `fuzzyFileSearch/sessionCompleted`. |
| `fuzzyFileSearch/sessionStop` | Stops an existing fuzzy-search session. |

`fuzzyFileSearch/sessionUpdated` and `fuzzyFileSearch/sessionCompleted` are intentionally not experimental-gated
notifications, matching the Codex request/notification split.

## Notifications And Routing

Responses correlate to requests by `id`. Notifications have `method`, optional `params`, and a required `emittedAtMs`;
they have no `id` and may arrive before, between, or after correlated responses unless noted below.

- Broadcast notifications include thread lifecycle updates, `thread/unarchived`, name changes, global goal updates, and
  fuzzy-search session updates.
- Thread-scoped notifications go only to subscribers of that thread. This includes turn lifecycle and item events,
  `thread/settings/updated`, and `turn/diff/updated`.
- `turn/diff/updated` is Senpi's cumulative aggregation of the projected file-change unified diffs for a turn, in item
  order. It is intentionally not a byte-for-byte substitute for Codex's git-based diff text.
- `thread/unarchive`, goal mutation, and a successful settings mutation send their response before the corresponding
  notification. `thread/compact/start` responds before compaction begins.
- `thread/compacted` is declared in the upstream protocol but is not emitted by Codex HEAD; Senpi does not emit it.
- Terminal `turn/completed` and `error` notifications are queued briefly when no subscriber is attached, then replayed
  to the next subscriber. The per-thread terminal queue is capped at 100 notifications.
- Experimental notifications, including `thread/settings/updated`, are delivered only to connections that enabled
  `experimentalApi`. Clients can opt out of specific notification method names during `initialize`.

## Approvals Flow

When a running turn needs user approval, the server sends a request-like outbound message to subscribers of the affected
thread. Approval request methods include `item/commandExecution/requestApproval` and
`item/fileChange/requestApproval`.

Command approval decisions are `accept`, `acceptForSession`, `decline`, and `cancel`. `acceptForSession` is remembered
for matching command approvals in the same thread. If no subscriber is attached, the approval is declined with a
no-subscriber reason. When a turn ends, pending approvals for that thread are cancelled and `serverRequest/resolved` is
emitted.

## Multi-Session Semantics

Each app-server process can keep multiple loaded threads. `thread/start`, `thread/resume`, and `thread/fork` load a
thread and subscribe the current connection. `thread/unsubscribe` detaches only that connection; the thread may unload
after the idle timeout when it has no subscribers and no active turn. A websocket listener can serve multiple initialized
clients concurrently. Stdio mode serves one process-owned connection.

The app-server `TurnLog` is retained for the lifetime of the process. Idle unload disposes the session but does not
release its turn log, so unloading and then resuming a thread in the same process preserves full
`thread/turns/list` and `thread/items/list` history. A process restart loses that in-memory log and falls back to the
user-message-only reconstruction documented in the supported-method table.

## Intentional `-32601` Surface

The methods below intentionally return `-32601 Method not found` after initialization. This is an explicit compatibility
boundary: Senpi does not claim to support an API without a local primitive. `thread/turns/items/list` is retired in
Codex HEAD and is also intentionally `-32601`.

| Area | Intentionally unsupported methods |
|---|---|
| Codex account and app flows | `account/login/cancel`, `account/login/start`, `account/logout`, `account/rateLimitResetCredit/consume`, `account/sendAddCreditsNudgeEmail`, `account/workspaceMessages/read`, `app/installed`, `app/list`, `app/read`, `getAuthStatus`, `getConversationSummary` |
| Configuration writes and extension management | `config/batchWrite`, `config/mcpServer/reload`, `config/value/write`, `experimentalFeature/enablement/set`, `hooks/list`, `plugin/install`, `plugin/installed`, `plugin/list`, `plugin/read`, `plugin/share/checkout`, `plugin/share/delete`, `plugin/share/list`, `plugin/share/save`, `plugin/share/updateTargets`, `plugin/skill/read`, `plugin/uninstall`, `skills/config/write`, `skills/extraRoots/set` |
| Direct filesystem and command APIs | `command/exec`, `command/exec/resize`, `command/exec/terminate`, `command/exec/write`, `fs/copy`, `fs/createDirectory`, `fs/getMetadata`, `fs/readDirectory`, `fs/readFile`, `fs/remove`, `fs/unwatch`, `fs/watch`, `fs/writeFile`, `gitDiffToRemote` |
| MCP, marketplace, and external-agent operations | `marketplace/add`, `marketplace/remove`, `marketplace/upgrade`, `mcpServer/oauth/login`, `mcpServer/resource/read`, `mcpServer/tool/call`, `modelProvider/capabilities/read`, `externalAgentConfig/detect`, `externalAgentConfig/import`, `externalAgentConfig/import/readHistories`, `feedback/upload`, `review/start` |
| Thread operations without a backing primitive | `thread/approveGuardianDeniedAction`, `thread/inject_items`, `thread/rollback`, `thread/shellCommand`, `thread/turns/items/list` |
| Windows-only operations | `windowsSandbox/readiness`, `windowsSandbox/setupStart` |
| Environments, processes, memory, and realtime | `environment/add`, `environment/info`, `environment/status`, `memory/reset`, `mock/experimentalMethod`, `process/kill`, `process/resizePty`, `process/spawn`, `process/writeStdin`, `thread/backgroundTerminals/clean`, `thread/backgroundTerminals/list`, `thread/backgroundTerminals/terminate`, `thread/decrement_elicitation`, `thread/increment_elicitation`, `thread/memoryMode/set`, `thread/realtime/appendAudio`, `thread/realtime/appendSpeech`, `thread/realtime/appendText`, `thread/realtime/listVoices`, `thread/realtime/start`, `thread/realtime/stop` |
| Remote-control enrollment | `remoteControl/client/revoke`, `remoteControl/disable`, `remoteControl/enable`, `remoteControl/pairing/start`, `remoteControl/pairing/status` |

The Codex-query skill's documented direct-call APIs are deliberately in this list: `config/value/write`, `plugin/list`,
`fs/readFile`, `fs/readDirectory`, and `command/exec`. A clean `-32601` is the supported outcome for those direct calls;
it is not a transient integration failure.

## Differential Parity Harness

The differential harness runs the Codex source app-server and Senpi side by side in an isolated, zero-credential cell
against the same local fake model. It uses raw websocket frames, normalizes only machine-specific values such as IDs,
timestamps, paths, and tokens, and preserves frame order, array order, and notification audience.

From `packages/coding-agent`, build the pinned Codex oracle once, then run the available handshake scenario:

```bash
node scripts/qa-app-server/differential/build-oracle.mjs
node scripts/qa-app-server/differential/run.mjs --scenario handshake
```

The build uses `/Users/yeongyu/local-workspaces/codex/codex-rs/Cargo.toml` and writes the binary under that checkout's
`target/debug/`. The run uses only ports 18990 (fake model), 18991 (Codex), and 18992 (Senpi), creates a temporary cell,
and checks that all three listeners are gone during cleanup. Do not run it in parallel with other app-server QA that
uses the 18990-18999 range.

`packages/coding-agent/scripts/qa-app-server/differential/allowlist.json` is a narrowly scoped gap ledger, not a way to
hide parity failures. Every rule must identify one scenario and normalized frame path, have a non-empty rationale, and
classify the difference as `known-gap` or `allowlisted-delta` (or the explicit harness/regression classifications).
Unclassified differences fail the run. Audience, frame-order, array-order, sequence, and invalid-record differences are
never allowlistable. A rule that no longer matches is a harness defect and fails the run, so resolved gaps must be
removed instead of retained indefinitely.
