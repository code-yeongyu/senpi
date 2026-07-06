# TODO15 Code Quality / Slop Review

Verdict: PASS after follow-up split.

## Scope

Changed TODO15 TypeScript files audited:

- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/connection.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts`
- `packages/coding-agent/test/mcp/startup-race.test.ts`

## LOC Check

Command:

```bash
awk '!/^[[:space:]]*$/ && !/^[[:space:]]*(\/\/|#|--)/' <file> | wc -l
```

Captured artifact: `.omo/evidence/task-15-senpi-mcp-plugin-ts-audit.log`

Results:

- `service.ts`: 230 pure LOC, under the 250 limit.
- `startup-race.ts`: 80 pure LOC, under the 250 limit.
- `connection.ts`: 249 pure LOC, under the 250 limit.
- `expose/register.ts`: 174 pure LOC, under the 250 limit.
- `startup-race.test.ts`: 171 pure LOC, under the 250 limit.

## TypeScript Hygiene

Captured audit found no forbidden TypeScript escapes or inline imports:

- no `any` additions or `as any`
- no `@ts-ignore` / `@ts-expect-error`
- no `await import(...)` or type-position `import(...)`
- no secret logging keyword hits

Async/timer hits are intentional and covered:

- `startup-race.ts` keeps one `void connect.then(...)` continuation for the late hot-swap. The connected path calls `refreshMcpToolsAfterStartupRace`, which catches and logs refresh failures without unhandled rejection.
- `startup-race.ts` uses the 250ms `setTimeout(...).unref()` startup race deadline.
- `startup-race.test.ts` uses a bounded polling helper only for the behavior under test: late asynchronous MCP connect/hot-swap visibility.

## Slop Criteria

- Oversized modules: fixed by moving startup-race connection/cache refresh orchestration out of `service.ts`; all audited files are below 250 pure LOC.
- Needless abstractions: no new broad framework or speculative layer; helper is focused on startup race/connect-refresh responsibilities already introduced by TODO15.
- Defensive code: no new catch-all behavior beyond existing connect/cache-refresh degradation paths.
- Hollow or tautological tests: focused test drives real local MCP stdio fixture behavior, warm cache registration, late live tool execution, byte-identical active tool arrays, and wedged ConnectError behavior.
- Excessive tests: one focused regression file plus impacted MCP suites; no broad unrelated test additions.
- Prompt-cache instability: covered by `keeps unchanged cached tool arrays byte-identical across late refresh` and manual QA provider payloads showing cached-first then hot-swapped MCP tool names.
- Secret safety: logs and manual QA transcripts redact mock provider authorization; no real auth content is copied. Auth isolation receipt records only hash/unchanged status.

## Verification Artifacts

- Focused TODO15 test: `.omo/evidence/task-15-senpi-mcp-plugin-tests-final.log`
- Impacted MCP tests: `.omo/evidence/task-15-senpi-mcp-plugin-impacted.log`
- Root check: `.omo/evidence/task-15-senpi-mcp-plugin-npm-check.log`
- TS/LOC audit: `.omo/evidence/task-15-senpi-mcp-plugin-ts-audit.log`
- Manual QA bundle: `local-ignore/qa-evidence/20260706-mcp-w2-todo15/INDEX.md`
