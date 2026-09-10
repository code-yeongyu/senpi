# packages/coding-agent/src/modes/rpc

JSONL RPC domain (score 9): classic stdio plus a shared, worker-backed session host over stdio or sockets. One UTF-8 JSON object per LF-delimited line; requests in, events out. The public protocol reference is `packages/coding-agent/docs/rpc.md`.

## STRUCTURE

```text
rpc-mode.ts               Mode entry: session binding, main loop
connection-handler.ts     Connection lifecycle; owns the command-digest baseline,
                          get_commands responses, commands_changed emission
jsonl.ts                  Strict LF framing; MAX_RPC_LINE_CHARACTERS (16 * 1024 * 1024 chars)
                          ceiling with oversized-record resynchronization
rpc-input-validation.ts   Inbound bounds: MAX_RPC_MESSAGE_CHARACTERS (1,000,000)
rpc-command-surface.ts    RpcSlashCommand snapshot, digest, baseline comparison
rpc-command-invocation.ts command_invocation / skill_invocation event types
multi-session-host.ts     Shared RPC host; unlimited logical session admission
session-binding.ts, session-registry.ts, session-command-router.ts,
session-event-writer.ts, session-extension-ui-requests.ts   Session wiring
rpc-client.ts, rpc-types.ts, custom-capability.ts, event-output-buffer.ts
host-ensure.ts, host-lifecycle.ts, host-watchdog.ts          Host supervision
ownership-safe-lock.ts, socket-ownership.ts, socket-transport.ts  Ownership/auth
session-worker*.ts, worker-session-registry.ts              Worker IPC/lifecycle
session-event-fanout.ts, socket-event-fanout.ts              Attachment-scoped delivery
changes.md                Fork-specific RPC behavior record
```

## COMMAND-SURFACE LIFECYCLE

- On bind/rebind, `connection-handler.ts` builds the ordered `RpcSlashCommand` snapshot and digests it (`rpc-command-surface.ts`).
- The baseline digest starts `undefined`: the first snapshot is recorded WITHOUT emitting `commands_changed`. That baseline suppression is intentional (it removed the initial client-refresh feedback loop) — do not "fix" it into an emission.
- `commands_changed` fires only when a later snapshot differs (extension reload, rebind, config change); clients refetch via `get_commands`.
- `command_invocation` / `skill_invocation` are additive typed metadata on prompt events; they do not replace `loaded_surfaces_changed` / `get_loaded_surfaces`.
- Skill expansion (`$name`, `$skill:name`) happens in prompt preprocessing and must not reset or reorder MCP loaded surfaces.

## INVARIANTS

- Framing is strict LF. Records over `MAX_RPC_LINE_CHARACTERS` are dropped with resynchronization rather than killing the stream; preserve that recovery behavior.
- Inbound messages over `MAX_RPC_MESSAGE_CHARACTERS` are rejected with a typed error; non-object JSON is rejected.
- Pending work is rejected on disconnect or child exit; preserve request/response correlation.
- Child stderr is emitted and embedded raw; treat diagnostics as secret-bearing.
- Session admission has no fixed eight-session cap; idle eviction and empty-host exit reclaim resources. Quarantined workers retain ownership until exit.
- A socket peer's overflow/stall must not consume shared worker credit or terminate other attachments; keep backpressure and fanout peer-scoped.
- Socket teardown checks ownership tokens and process identity, not just the pathname. Explicitly empty client capabilities override launch defaults.

## WHERE TO LOOK

| Task | File |
|---|---|
| Add/change a command-surface event | `rpc-command-surface.ts`, `connection-handler.ts` |
| Change framing or input bounds | `jsonl.ts`, `rpc-input-validation.ts` |
| Invocation metadata on prompts | `rpc-command-invocation.ts` |
| Session wiring / multi-session | `session-*.ts`, `multi-session-host.ts` |
| Shared-host startup / ownership | `host-ensure.ts`, `host-lifecycle.ts`, `socket-ownership.ts` |
| Worker quarantine / socket stalls | `session-command-router.ts`, `session-event-writer.ts`, fanout modules |
| Protocol documentation | `packages/coding-agent/docs/rpc.md` |

## VALIDATION

- Focused tests span `packages/coding-agent/test/rpc-*.test.ts` and `test/suite/rpc-*.test.ts` (worker capacity/isolation, socket stalls/ownership, auth, UI, and classic protocol contracts). Use the package's Vitest script: `bun run --cwd packages/coding-agent test -- <test-path>`, not bare `bun test`.
- End-to-end scenarios: `.agents/skills/senpi-qa/scripts/scenarios/dollar-skill-invocation-qa.mjs` and `rpc-input-hardening-qa.mjs`.
- Behavior changes update `changes.md` here and `docs/rpc.md` in the same increment.
- Runtime changes require root `bun run check` and real CLI QA evidence.

---
Generated: 2026-08-17 | Commit `abae968e8`
