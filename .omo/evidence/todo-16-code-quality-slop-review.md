# TODO16 code-quality/slop review

Goal: TODO16 ping-on-call revalidation and in-place renewal for MCP tool calls.

Commit reviewed: `70a27910589f960976b44f69d73546579b8286b1` (`feat(coding-agent): ping mcp tools before stale calls`)

Verdict: PASS

codeQualityStatus: CLEAR
recommendation: APPROVE
blockers: none

## Scope

Reviewed files:

- `packages/coding-agent/src/core/extensions/builtin/mcp/health.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/connection.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts`
- `packages/coding-agent/test/mcp/ping-on-call.test.ts`
- `packages/coding-agent/test/mcp/fixtures/options.ts`
- `packages/coding-agent/test/mcp/fixtures/sdk-server.ts`
- `packages/coding-agent/test/mcp/fixtures/stdio-server.ts`
- `.omo/evidence/task-16-senpi-mcp-plugin.md`
- `.omo/evidence/task-16-senpi-mcp-plugin-gate-review.md`
- `.omo/evidence/task-16-stop-hook-verification.md`
- `.omo/evidence/task-16-stop-hook-verification-2.md`
- `.omo/evidence/task-16-stop-hook-verification-3.md`
- Raw QA summaries under `local-ignore/qa-evidence/20260706-mcp-w2-todo16/`

Skill perspective check: ran. I loaded and applied:

- `remove-ai-slops`: overfit/slop criteria, hollow test detection, needless abstraction, broad catch/catch-swallow review, deletion ladder, and evidence skepticism.
- `programming`: TypeScript strictness, no-excuse rules, test-shape criteria, parse-at-boundary guidance, no `any`, no inline imports, no catch-swallow, and no unnecessary abstraction.
- `programming/references/typescript/README.md`: TypeScript-specific iron list and no-excuse audit rules.

Diff status against these perspectives: no blocking violations found.

## Findings by severity

### CRITICAL

None.

### HIGH

None.

### MEDIUM

None.

### LOW

None blocking. The temporary fixture wrapper string in `ping-on-call.test.ts` uses a generated script with `catch {}` and `await import(...)`. I do not count this as a TODO16 blocker because it is test-only temp-script glue, not checked production/test TypeScript syntax, and the real no-excuse audit passes on the committed `.ts` files. It remains worth simplifying in a later cleanup if this fixture pattern grows.

## Slop and overfit review

- Hollow tests: none found. The new tests drive real MCP fixture connections through registered tools, not stubbed private helpers.
- Deletion-only/requested-removal-only tests: none found. The tests verify new runtime behavior: renewal after process death, 30s ping cache, bounded failed renewal, and concurrent stale-call coalescing.
- Tautological tests: none found. Assertions inspect observable tool results, pid changes, ping counter effects, and `ToolExecError`, not just existence of constants or mocks returning arranged values.
- Implementation-mirroring tests: none found. The tests do not assert `WeakMap`, internal promise identity, helper names, or private state. The ping-count assertions are observable fixture behavior.
- Overbroad abstraction: none found. `health.ts` is a small, focused MCP call-health module; `ServerConnection.renew()` is a direct lifecycle operation at the existing connection boundary.
- Unnecessary production extraction/parsing/normalization: none found. The production diff adds ping/renew state only; it does not introduce unrelated parsing, schema conversion, or data extraction.
- Scope drift: none found. The diff stays within MCP connection health, MCP tool-call registration, and fixture/test support.
- Catch-swallow/no-excuse violations: none in committed TypeScript files per no-excuse audit. Existing and added catch blocks in fixtures narrow `ENOENT` and rethrow unknown errors. The generated wrapper-string caveat is noted above.
- Unsafe `any`: none found in the reviewed diff or no-excuse audit.
- Inline imports: production code has none. The generated wrapper string has `await import(...)` only inside a temp `.mjs` fixture script.
- Hardcoded `~/.senpi`: none in production/test code. Evidence references the auth path only to prove isolation and unchanged real auth.
- Secret-bearing evidence: no raw secret-shaped matches found in targeted evidence scan; QA model request artifacts state auth headers were sanitized, and `auth-isolation.json` stores hashes only.

## Programming perspective

- Type boundaries: MCP tool args remain `Record<string, unknown>` at the existing tool boundary; no new `any` or untyped escape hatch was introduced.
- Error behavior: ping failures mark the connection degraded, renew once, and let a failed renewal propagate through the existing `ToolExecError` path for model-visible failure.
- Async/concurrency: stale validation is coalesced per connection with `pendingValidation`; per-call arguments remain isolated and the original call executes after health validation.
- Retry bounds: renewal is one attempt in `pingOrRenew()` / `renewConnection()` and does not loop.
- Background behavior: no new eager polling or keep-alive loop was introduced.
- File size: gate review observed no touched file above 250 pure LOC; `connection.ts` and `sdk-server.ts` are in the warning band only.

## Evidence considered

Focused test, rerun in this review:

```text
cd packages/coding-agent &&
npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/ping-on-call.test.ts

Test Files  1 passed (1)
Tests       4 passed (4)
```

No-excuse audit, rerun in this review:

```text
bun run /Users/yeongyu/.agents/skills/programming/scripts/typescript/check-no-excuse-rules.ts <7 touched files>

No violations in 7 file(s).
```

Saved focused and impacted test evidence:

- `.omo/evidence/task-16-senpi-mcp-plugin-green-focused.log`: 1 file passed, 4 tests passed.
- `.omo/evidence/task-16-senpi-mcp-plugin-green-impacted-after-check.log`: 3 files passed, 17 tests passed.

Saved root check evidence:

- `.omo/evidence/task-16-senpi-mcp-plugin-npm-check.log`: `npm run check` passed; Biome, pinned deps, TS import check, shrinkwrap/install-lock checks, `tsgo --noEmit`, browser smoke, web UI check, and `check:neo` passed.
- Stop-hook verification 2 and 3 also reran `npm run check` with exit 0 after the TODO16 commit.

Manual QA evidence:

- `local-ignore/qa-evidence/20260706-mcp-w2-todo16/manual-qa.log`: 7/7 checks passed through the real source CLI in RPC mode.
- `happy-summary.json`: killed fixture renewed in place, pid changed `24974 -> 24983`, and the second model-visible tool payload returned.
- `failure-summary.json`: failed renewal attempted exactly once after initial spawn (`attempts=2`) and produced model-visible `ToolExecError` while RPC remained alive.
- `auth-isolation.json`: real `/Users/yeongyu/.senpi/agent/auth.json` hash unchanged.
- `cleanup-receipt.json`: fixture pids dead and temp sandboxes removed.

Secret scan run in this review:

```text
rg -n --hidden --no-ignore "sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|x-api-key|Authorization:|Bearer [A-Za-z0-9._-]{20,}|OPENAI_API_KEY|ANTHROPIC_API_KEY|Cookie:" <TODO16 evidence paths>

No matches.
```

## Final status

TODO16 passes the required remove-ai-slops and programming perspective review. The previous gate blocker was the missing report artifact, not a production or test-code blocker. This artifact closes that evidence gap.
