# TODO18 Code Quality / Slop Review

Date: 2026-07-07

## Scope

Changed TODO18 files reviewed:

- `packages/coding-agent/src/core/extensions/builtin/mcp/idle.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-snapshot.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts`
- `packages/coding-agent/test/mcp/idle.test.ts`

Unrelated stop-hook evidence files are intentionally excluded from TODO18 staging.

## Review Perspectives Applied

- `remove-ai-slops` perspective applied: reviewed the TODO18 branch diff for test slop, deletion-only or tautological coverage, implementation-mirroring, needless abstraction, dead/over-defensive code, unnecessary parsing/normalization, timer lifecycle risk, and secret/log leakage. No product-code cleanup was required for this blocker; the missing item was evidence explicitness.
- `programming` / TypeScript perspective applied: reviewed the changed TypeScript under the strict TS rules for no `any`, no type suppressions, no non-erasable syntax, no dynamic imports, boundary parsing discipline, safe async/timer cleanup, cohesive module size, and behavior-oriented tests.
- Supporting code paths reviewed for the default and timer contracts: `packages/coding-agent/src/core/extensions/builtin/mcp/config.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/wrap.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/idle.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/service-snapshot.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts`, and `packages/coding-agent/test/mcp/idle.test.ts`.

## LOC

Pure LOC proof captured in `.omo/evidence/task-18-senpi-mcp-plugin-ts-audit-final.log`.

| File | Pure LOC |
|---|---:|
| `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts` | 177 |
| `packages/coding-agent/src/core/extensions/builtin/mcp/service-snapshot.ts` | 26 |
| `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts` | 246 |
| `packages/coding-agent/src/core/extensions/builtin/mcp/idle.ts` | 138 |
| `packages/coding-agent/test/mcp/idle.test.ts` | 168 |

Conclusion: every changed TS file is under the project 250 pure LOC limit.

## TypeScript Hygiene

Audit command:

```bash
rg -n --no-heading --color never '\bany\b|@ts-ignore|@ts-expect-error|await import\(|import\(|\benum\b|\bnamespace\b|\bmodule\b|import\s*=|export\s*=' \
  packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts \
  packages/coding-agent/src/core/extensions/builtin/mcp/service-snapshot.ts \
  packages/coding-agent/src/core/extensions/builtin/mcp/service.ts \
  packages/coding-agent/src/core/extensions/builtin/mcp/idle.ts \
  packages/coding-agent/test/mcp/idle.test.ts
```

Result: no matches. No `any`, suppression comments, dynamic imports, `enum`, `namespace`, `module`, `import =`, or `export =` were introduced.

Final audit artifact: `.omo/evidence/task-18-senpi-mcp-plugin-ts-audit-final.log` reports `FORBIDDEN_TS_PATTERNS` as `NO_FORBIDDEN_MATCHES` and `EXIT_CODE=0`.

## Lifecycle / Timer Review

- `idle.ts` owns the lifecycle timers in a WeakMap keyed by `ServerConnection`, keeping the abstraction local to MCP service connections.
- Idle timers use `safeTimer`, and keep-alive timers use `safeInterval`; both helpers unref timers and route async failures through the MCP logger.
- `disposeMcpConnectionLifecycle` clears both timers and unsubscribes state listeners before connection disposal.
- `runMcpConnectionLifecycleCall` increments `inFlight`, clears the idle timer, and refreshes timers in `finally`, covering successful and failed calls.
- Keep-alive uses a fixed `MCP_KEEP_ALIVE_INTERVAL_MS = 30_000` and wraps ping/recover work in `runMcpConnectionLifecycleCall`.

Conclusion: no ref'ed timers, orphaned intervals, or overbroad lifecycle manager were introduced.

## Per-Criterion Slop / Overfit Review

| Criterion | Verdict | Evidence |
|---|---|---|
| Excessive/useless tests | PASS | `packages/coding-agent/test/mcp/idle.test.ts` maps each test to a TODO18 acceptance criterion: default timeout, idle process exit, eager idle behavior, in-flight protection, renewal protection, cached reconnect, and keep-alive recovery. Focused artifact `.omo/evidence/task-18-senpi-mcp-plugin-final.log` passed 7/7. Impacted artifact `.omo/evidence/task-18-senpi-mcp-plugin-impacted-final.log` passed 33/33. |
| Deletion-only tests | PASS | No TODO18 test asserts that code was removed. The tests assert observable state, process death/new PID behavior, fixture tool results, and absence of pre-TODO17 `suspended` state. Manual QA `local-ignore/qa-evidence/20260706-mcp-w2-todo18/INDEX.md` records 14/14 observable RPC checks. |
| Tautological tests | PASS | Tests drive real stdio MCP fixtures through the coding-agent test harness rather than asserting constants or internal booleans. Manual QA bundle checks source CLI RPC behavior, cache persistence, killed-process recovery, fake-model tool-result receipt, and auth isolation. |
| Implementation-mirroring/mock-only tests | PASS | The focused tests use real fixture MCP processes and observable lifecycle snapshots/tool calls; manual QA uses the source CLI RPC process and a local fake model only as the deterministic provider boundary. Artifacts: `.omo/evidence/task-18-senpi-mcp-plugin-final.log`, `.omo/evidence/task-18-senpi-mcp-plugin-impacted-final.log`, `local-ignore/qa-evidence/20260706-mcp-w2-todo18/happy-rpc-transcript.jsonl`, and `local-ignore/qa-evidence/20260706-mcp-w2-todo18/failure-rpc-transcript.jsonl`. |
| Unnecessary production extraction/abstraction | PASS | `idle.ts` is a cohesive lifecycle owner used from service setup, service disposal, and tool execution; it centralizes timer state without adding a speculative public API. Changed files reviewed: `idle.ts`, `service.ts`, `service-snapshot.ts`, and `expose/register.ts`. |
| Unnecessary parsing/normalization | PASS | TODO18 does not add a new parser or normalization layer. Existing MCP config/default handling remains in `config.ts`; tool-call params continue through the existing `isRecord(params)` boundary in `expose/register.ts`. |
| Any `any` / TS escape / non-erasable syntax | PASS | `.omo/evidence/task-18-senpi-mcp-plugin-ts-audit-final.log` shows no matches for `any`, `@ts-ignore`, `@ts-expect-error`, dynamic imports, `enum`, `namespace`, `module`, `import =`, or `export =`; it exits 0. |
| Timer safety: `safeTimer`/`safeInterval`/`unref` and cleanup | PASS | `idle.ts` uses `safeTimer` for idle shutdown and `safeInterval` for keep-alive; `wrap.ts` unrefs both helper outputs; `disposeMcpConnectionLifecycle` clears timers/listeners. Focused tests and manual QA exercise idle shutdown, transparent reconnect, in-flight protection, and keep-alive recovery. |
| Secret/log safety | PASS | Manual QA runs in isolated `SENPI_CODING_AGENT_DIR` / `SENPI_CODING_AGENT_SESSION_DIR` sandboxes. `local-ignore/qa-evidence/20260706-mcp-w2-todo18/auth-isolation.md` records the real auth hash unchanged, and the evidence bundle uses sanitized fake-model/MCP artifacts with no auth headers, env dumps, cookies, tokens, or credentials. |

## Test Quality

Focused test: `.omo/evidence/task-18-senpi-mcp-plugin-final.log`

- Default idle timeout remains 10 minutes.
- Connected zero-in-flight server idles after configured window and process exits.
- Eager server connects on session start and still idles after the configured window.
- Long-running tool call blocks idle until the call completes.
- Renewal critical section keeps idle timer paused until the renewal path returns.
- Cached tool reconnects transparently after idle shutdown.
- Keep-alive pings every 30 seconds, recovers a killed fixture, succeeds on the next tool call, and emits no `suspended` state for the single kill.

Impacted test: `.omo/evidence/task-18-senpi-mcp-plugin-impacted-final.log`

- Startup race, ping-on-call, service lifecycle, connection, and direct register-call MCP tests pass.

Conclusion: tests drive real stdio MCP fixtures and assert observable process/state/tool-call behavior. No hollow tests were added.

Manual QA bundle: `local-ignore/qa-evidence/20260706-mcp-w2-todo18/INDEX.md`

- Source CLI RPC process with local fake model and builtin MCP stdio server passed the idle/reconnect scenario.
- Keep-alive failure scenario killed the fixture with `SIGKILL`, observed recovery by the 30s ping loop, and confirmed the next tool call succeeded.
- Bundle result is 14/14 PASS with auth unchanged and cleanup receipt present.

## Prompt Cache / Secret Safety

- The change does not alter prompt/cache serialization formats.
- Idle shutdown preserves cached catalog entries; reconnect is exercised through cached direct tool registration.
- Logs and evidence avoid auth headers, env dumps, cookies, tokens, and private credentials.
- Manual QA is required to run in isolated `SENPI_CODING_AGENT_DIR` / `SENPI_CODING_AGENT_SESSION_DIR` sandboxes and prove the real `~/.senpi/agent/auth.json` hash is unchanged.

## Verification Artifacts

- Focused tests: `.omo/evidence/task-18-senpi-mcp-plugin-final.log`
- Impacted MCP tests: `.omo/evidence/task-18-senpi-mcp-plugin-impacted-final.log`
- Root check: `.omo/evidence/task-18-senpi-mcp-plugin-check-final.log`
- TS audit / LOC proof: `.omo/evidence/task-18-senpi-mcp-plugin-ts-audit-final.log`
- Manual QA bundle: `local-ignore/qa-evidence/20260706-mcp-w2-todo18/INDEX.md`
- Manual QA auth isolation: `local-ignore/qa-evidence/20260706-mcp-w2-todo18/auth-isolation.md`
- Manual QA cleanup: `local-ignore/qa-evidence/20260706-mcp-w2-todo18/cleanup-receipt.md`
