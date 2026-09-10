# test/cursor-cli-oauth

Provider-lane coverage for the Cursor CLI OAuth extension: accounts, settings, executable resolution, spawn args, stream parsing, session routing, failover, guardrails, shutdown. 27 test files / ~6,400 TypeScript LOC + committed CLI captures. Score 7 — existing provider/replay-fixture guide retained in UPDATE mode.

## STRUCTURE

```text
*.test.ts                       one file per production module in
                                src/core/extensions/builtin/cursor-cli-oauth/
fixtures/captures/*.jsonl       recorded cursor-agent wire output, replayed across
                                adversarial chunk boundaries
fixtures/cursor-agent-models.txt   model-listing capture
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Account slots, pinning, failover | `account-command.test.ts`, `accounts.test.ts`, `affinity.test.ts` |
| Stream event mapping | `stream.test.ts` — usage isolation, tool rendering, failover, guardrails |
| Resume / fresh-chat / recap | `session-router.test.ts` |
| Token/context ownership | `context-ownership.test.ts` |
| Executable probe + bootstrap | `executable.test.ts`, `native-bootstrap.test.ts` |
| Login and ambient opt-in | `oauth-login.test.ts`, `ambient-opt-in.test.ts`, `check-nonthrowing.test.ts` |
| Process lifecycle | `transport.test.ts`, `shutdown.test.ts`, `fixture.test.ts` |
| Model/reasoning resolution | `models.test.ts`, `reasoning-catalog.test.ts`, `reasoning-model-string.test.ts` |
| Spawn serialization / settings cache | `spawn-args.test.ts`, `settings-cache.test.ts` |

Production seams live in `src/core/extensions/builtin/cursor-cli-oauth/`; account/settings modules feed multiple lifecycle and routing tests.

## CONVENTIONS

- Dependency injection with small local harnesses plus `vi.fn()` — no broad module mocks. Local helper names recur: `makeStore`, `fixtureExecutable`, `accountAwareFixture`, `runTurn`, `createHarness`, `scriptedRunner`, `makeRouter`, `textDeltas`.
- Transport/stream/shutdown tests spawn **real child processes** from generated temporary executable scripts standing in for `cursor-agent`.
- JSONL captures are committed and treated as the Cursor CLI wire format; parser tests replay them split at adversarial chunk boundaries.
- Contract tests pin exact values: defaults, sentinel/provider IDs, argument shapes, warning counts, recap size ceilings, and machine-distinguishable error kinds.
- Security assertions are explicit and load-bearing: token material must not appear in output or logs, credential files use restrictive permissions, native credential sources stay isolated unless explicitly requested.

## ANTI-PATTERNS

- Never leak token material into output, logs, or errors.
- Never read or write the native Cursor credential entry on managed-account paths.
- Never spawn when the lane is disabled, no account is bound, or force acknowledgement is missing.
- Malformed/unknown stream frames and zero-output "success" are failures, not empty successes.
- Fresh-chat retry is bounded; transcript text must not persist beyond the recap window; CLI-reported usage must never land in assistant usage fields.
- `shutdown.test.ts` / `transport.test.ts` contain legacy PID polling; do not copy it. New lifecycle tests subscribe to child exit/close or explicit fixture acknowledgements before triggering shutdown.
- `buildCursorCliArgs` serializes the supplied `force` even in plan mode; force policy belongs to the caller, not this argv builder.

## COMMANDS

```bash
bun run --cwd packages/coding-agent test test/cursor-cli-oauth/<file>.test.ts
CI=1 bun run --cwd packages/coding-agent test test/cursor-cli-oauth
```
