# packages/server

`@code-yeongyu/senpi-orchestrator` is an experimental private server package for daemon configuration, IPC, supervised Senpi RPC processes, storage, and Radius connectivity.

## STRUCTURE

```text
src/serve.ts          Daemon/service entry
src/ipc/protocol.ts   IPC request and response contracts
src/ipc/server.ts     Serialized JSONL server
src/ipc/client.ts     IPC client
src/rpc-process.ts    Child Senpi RPC process wrapper
src/supervisor.ts     Process ownership and cleanup
src/radius.ts         Radius connection lifecycle
src/config.ts         Config parsing
src/storage.ts        Persistent state
src/cli.ts            CLI source
```

## INVARIANTS

- Preserve newline-delimited JSON framing and serialize writes per connection; interleaved response bytes corrupt the protocol.
- Correlate requests and responses explicitly and close pending operations on disconnect.
- The supervisor owns spawned children and must clean them up on stop, error, and partial startup.
- Radius disconnect/reconnect paths settle listeners and pending work without leaking sockets.
- Radius presence owns machine/Pi heartbeat retry backoff and re-registration after repeated 404s; credential lookup uses coding-agent stored credentials (`readStoredCredential("radius")`) with `SENPI_RADIUS_API_KEY` as fallback.
- Never log credentials, tokens, raw auth headers, or secret-bearing environments.
- Treat the package as unstable and private.

## WHERE TO LOOK

| Task | Path |
|---|---|
| IPC schema/framing | `src/ipc/` |
| Child RPC lifecycle | `src/rpc-process.ts` and `src/supervisor.ts` |
| Daemon request handling | `src/handler.ts` and `src/serve.ts` |
| Radius credentials + heartbeat/re-registration | `src/radius.ts` |
| Config/storage | `src/config.ts`, `src/storage.ts` |

## VALIDATION

- Run focused Node tests with `npm test` from this package.
- Run root `npm run check` after code changes.
- Add lifecycle tests for startup failure, disconnect, duplicate stop, and child exit races.
- Inspect logs and fixtures for secret safety before committing.
