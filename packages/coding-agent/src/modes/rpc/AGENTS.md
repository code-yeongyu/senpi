# packages/coding-agent/src/modes/rpc

JSONL-over-stdio RPC mode for driving Senpi sessions programmatically (TUI-less). One UTF-8 JSON object per LF-delimited line; requests in, events out. The public protocol reference is `packages/coding-agent/docs/rpc.md`.

## STRUCTURE

```text
rpc-mode.ts               Mode entry: session binding, main loop
connection-handler.ts     Connection lifecycle; owns the command-digest baseline,
                          get_commands responses, commands_changed emission
jsonl.ts                  Strict LF framing; MAX_RPC_LINE_CHARACTERS (16 MiB)
                          ceiling with oversized-record resynchronization
rpc-input-validation.ts   Inbound bounds: MAX_RPC_MESSAGE_CHARACTERS (1,000,000)
rpc-command-surface.ts    RpcSlashCommand snapshot, digest, baseline comparison
rpc-command-invocation.ts command_invocation / skill_invocation event types
multi-session-host.ts     Multi-session RPC host
session-binding.ts, session-registry.ts, session-command-router.ts,
session-event-writer.ts, session-extension-ui-requests.ts   Session wiring
rpc-client.ts, rpc-types.ts, custom-capability.ts, event-output-buffer.ts
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

## WHERE TO LOOK

| Task | File |
|---|---|
| Add/change a command-surface event | `rpc-command-surface.ts`, `connection-handler.ts` |
| Change framing or input bounds | `jsonl.ts`, `rpc-input-validation.ts` |
| Invocation metadata on prompts | `rpc-command-invocation.ts` |
| Session wiring / multi-session | `session-*.ts`, `multi-session-host.ts` |
| Protocol documentation | `packages/coding-agent/docs/rpc.md` |

## VALIDATION

- Focused tests live in `packages/coding-agent/test/rpc-*.test.ts` (rpc-jsonl, rpc-input-validation, rpc-command-invocation, rpc-commands-changed, rpc-multi-session-input, rpc-loaded-surfaces, rpc-classic-compat, rpc-prompt-response-semantics).
- End-to-end scenarios: `.agents/skills/senpi-qa/scripts/scenarios/dollar-skill-invocation-qa.mjs` and `rpc-input-hardening-qa.mjs`.
- Behavior changes update `changes.md` here and `docs/rpc.md` in the same increment.
- Runtime changes require root `bun run check` and real CLI QA evidence.

---
Generated: 2026-08-17 | Commit `abae968e8`
