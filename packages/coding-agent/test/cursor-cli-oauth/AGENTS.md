# test/cursor-cli-oauth

Provider-lane coverage for the Cursor CLI OAuth extension: accounts, settings, executable resolution, spawn args, stream parsing, session routing, failover, guardrails, shutdown. 27 tests / ~7,000 LOC + committed CLI captures. Score 12 — distinct provider domain with a replay-fixture contract nothing else in `test/` uses.

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
| Account slots, pinning, failover | `account-command.test.ts` (463 LOC), `accounts.test.ts`, `affinity.test.ts` |
| Stream event mapping | `stream.test.ts` (627 LOC) — usage isolation, tool rendering, failover, guardrails |
| Resume / fresh-chat / recap | `session-router.test.ts` (423 LOC) |
| Token/context ownership | `context-ownership.test.ts` (450 LOC) |
| Executable probe + bootstrap | `executable.test.ts`, `native-bootstrap.test.ts` |
| Login and ambient opt-in | `oauth-login.test.ts`, `ambient-optin.test.ts`, `nonthrowing-checks.test.ts` |
| Process lifecycle | `transport.test.ts`, `shutdown.test.ts`, `fixture-process.test.ts` |

Highest production fan-in: `accounts.ts` (11 test files), `settings.ts` (8), `index.ts` (5), `executable.ts` (5), `oauth-login.ts` (4).

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
- `shutdown.test.ts` / `transport.test.ts` use interval-and-timeout PID death observation — that is process-lifecycle synchronization at a real OS boundary, not a pattern to copy into ordinary async tests.

## COMMANDS

```bash
bun run --cwd packages/coding-agent test --run test/cursor-cli-oauth/<file>.test.ts
CI=1 bun run --cwd packages/coding-agent test --run test/cursor-cli-oauth
```
