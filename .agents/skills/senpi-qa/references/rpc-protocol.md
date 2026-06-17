# RPC protocol (Channel 1)

Source: `packages/coding-agent/src/modes/rpc/{rpc-mode,rpc-types,jsonl}.ts`.

`senpi --mode rpc` is headless: JSON objects, one per line, on stdin; responses
and `AgentSessionEvent` objects, one per line, on stdout. `rpc-drive.mjs`'s
`RpcClient` wraps this (line buffering, id correlation, event collection).

## Commands (stdin)

Each command is `{ "id"?: string, "type": "...", ... }`. `id` correlates the
response. Common ones:

| type | extra fields | response data |
|---|---|---|
| `get_state` | — | `RpcSessionState` (model, sessionId, isStreaming, messageCount, …) |
| `prompt` | `message`, `images?`, `streamingBehavior?` | async — `{success:true}` immediately, then events |
| `steer` / `follow_up` | `message` | async |
| `abort` | — | `{success:true}` |
| `get_last_assistant_text` | — | `{ text: string \| null }` |
| `get_messages` | — | `{ messages: AgentMessage[] }` |
| `set_model` | `provider`, `modelId` | the resolved `Model` |
| `get_available_models` | — | `{ models: Model[] }` |
| `bash` | `command`, `excludeFromContext?` | `BashResult` |
| `new_session` | `parentSession?` | `{ cancelled }` |

Full union: `RpcCommand` in `rpc-types.ts`.

## Responses & events (stdout)

- Response: `{ id?, type:"response", command, success, data? | error }`.
- Events: any other `{ type, ... }` line is an `AgentSessionEvent` (assistant
  text deltas, tool calls/results, `agent_end`, `agent_aborted`, …).

## Detecting turn completion

After a `prompt` ack, wait for an `agent_end` (or `agent_aborted`) event, then
read the result:

```js
const client = new RpcClient({ env: box.env, cwd: box.cwd });
await client.send({ type: "get_state" });               // ensure booted
await client.send({ type: "prompt", message: "say PONG" });
await client.waitForEvent((e) => e.type === "agent_end" || e.type === "agent_aborted");
const { data } = await client.send({ type: "get_last_assistant_text" });
client.close();                                          // ends stdin -> process exits
```

Note: `agent_end` fires even for aborted turns; check the last assistant
message's `stopReason` if you need to distinguish (see
`packages/coding-agent/src/core/agent-session.ts`).

## Gotchas

- The process exits when stdin ends. Always `client.close()`.
- Non-protocol stdout noise (tsx startup) is ignored by the line parser; it only
  acts on lines that `JSON.parse` and carry a `type`.
- `get_state` needs no provider/auth — it reports local session state. Booting
  RPC does not call a model, so it is the cheapest liveness check.
