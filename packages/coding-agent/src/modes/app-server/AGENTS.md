# packages/coding-agent/src/modes/app-server

Codex-compatible app-server mode. It exposes Senpi threads and turns over JSON-RPC-shaped stdio, Unix-socket, and authenticated WebSocket transports. Unqualified paths below are relative to this directory; `packages/...` paths are repository-relative.

## STRUCTURE

```text
index.ts              Mode entry and listener selection
cli-args.ts           app-server argument parsing
daemon/               Background process probing and lifecycle
rpc/                  Envelopes, errors, NDJSON framing, method registry
server/               Connection state, approvals, notifications, dispatch
threads/              Session-backed thread registry, projection, turns
transports/           stdio, Unix socket, WebSocket auth/backpressure
protocol/             App-facing facade plus pinned generated Codex evidence
turn-adapter.ts       Agent/session events to app-server turn events
```

## INVARIANTS

- Clients initialize exactly once before other methods. Preserve correlated request/response IDs and JSON-RPC error codes; only registered supported methods may avoid `-32601`.
- Stdio uses one UTF-8 JSON object per LF-delimited line; stdout is protocol-only and diagnostics go to stderr.
- WebSocket listeners bind IP literals. Bearer auth is required unless explicitly disabled for loopback, and `Origin` requests remain rejected.
- Keep connection subscriptions, thread ownership, archive/unload, and turn cancellation consistent across disconnect and daemon shutdown. Unarchive restores storage only; it must not resume or attach the thread.
- Preserve the TurnLog for the process lifetime, including idle unload/resume. After a process restart, history reconstruction is intentionally user-message-only; do not present it as complete persisted turn history.
- Every outbound notification must carry `emittedAtMs`. Preserve response-before-notification ordering for unarchive, goal, and settings mutations; do not emit `thread/compacted` because Codex HEAD does not emit it.
- Keep `turn/diff/updated` thread-scoped and cumulative over projected file-change diffs. Keep `thread/settings/update` limited to session-scoped model and effort, and keep account reads honest rather than emulating Codex account state.
- Approval payloads and diagnostics can contain sensitive material. Keep token-file permissions restricted, do not assume diagnostics are redacted, and add explicit redaction before exposing them beyond the local process.
- Generated files under `protocol/generated/` are protocol evidence and compile-time type inputs, not runtime implementations. Never edit them directly. Prefer the non-generated facade; keep direct type-only imports isolated until the facade covers them.

## WHERE TO LOOK

| Task | Path |
|---|---|
| Add a method | `rpc/registry.ts` and the matching handler |
| Change connection lifecycle | `server/connection.ts`, `server/server-core.ts` |
| Change thread/session projection | `threads/` |
| Change transport behavior | `transports/` |
| Change approvals | `server/approval-*.ts`, `server/approvals.ts` |
| Change wire types | `protocol/` and `packages/coding-agent/docs/app-server.md` |

## GENERATED PROTOCOL

- The pinned raw protocol comes from Codex git `9fc715c0861c956c894a91890b78dc05b304ba29` (2026-07-22) and is regenerated with `packages/coding-agent/scripts/generate-app-server-protocol.sh --from-checkout <codex-checkout>`.
- Keep `protocol/generated/**/*.ts` byte-identical to generator output. The local `protocol/generated/package.json` is only a compilation shim.
- Wire compatibility is defined by runtime message shape and the app-facing facade. Existing type-only imports from the generated tree are compatibility gaps, not permission to add runtime dependencies on it.

## VALIDATION

- Run focused app-server Vitest suites from `packages/coding-agent`.
- Run `npm run qa:app-server` for the handshake, multiclient, approval, and real-client probes. For source-oracle parity, run `node scripts/qa-app-server/differential/build-oracle.mjs` and then `node scripts/qa-app-server/differential/run.mjs --scenario handshake`; the allowlist may never hide audience, frame-order, or array-order differences.
- Run the matching `packages/coding-agent/test/qa/app-server/` driver for focused Unix-socket, malformed-input, and lifecycle scenarios.
- Protocol or documentation changes must keep `packages/coding-agent/docs/app-server.md` examples and `packages/coding-agent/test/qa/app-server/` checks aligned.
- Runtime changes also require root `npm run check` and the applicable real CLI QA evidence gate.
