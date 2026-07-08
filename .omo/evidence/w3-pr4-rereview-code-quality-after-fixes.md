# W3 PR#4 Code Quality Rereview After Fixes

codeQualityStatus: WATCH
recommendation: APPROVE
reportPath: `/Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w3/.omo/evidence/w3-pr4-rereview-code-quality-after-fixes.md`

## Verdict

<verdict>PASS</verdict>

## Scope

- Worktree: `/Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w3`
- Current HEAD: `558566e5a` (`test(coding-agent): record w3 evidence hygiene fix`)
- Code-quality fix commit in ancestry: `d2132da45` (`fix(coding-agent): surface mcp oauth refresh auth guidance`)
- Reviewed diff: `origin/main...HEAD`, with focused after-fix review against original blocker report `.omo/evidence/w3-pr4-rereview-code-quality.md`
- Fix evidence inspected as untrusted input, then verified against current code/tests:
  - `.omo/evidence/w3-pr4-rereview-code-quality-fix.md`
  - `.omo/evidence/subagent-stop-22-w3-pr4-code-quality-fix-verification-3.md`
  - `local-ignore/qa-evidence/20260708-w3-pr4-rereview-code-quality-fix/*`

## Skill Perspective Check

- Loaded `code-review`; used severity-first review with findings grouped by CRITICAL/HIGH/MEDIUM/LOW.
- Loaded `remove-ai-slops`; ran the overfit/slop pass over production and test changes. No deletion-only tests, tautological tests, implementation-constant-only tests, or unnecessary production parsing/data extraction were found in the blocker fix. The new regressions drive real MCP OAuth fixture/server/service paths and assert observable state/guidance.
- Loaded `programming` plus TypeScript `README.md`, `error-handling.md`, and `type-patterns.md`; applied strict TypeScript/error-boundary rules. Production blocker fix satisfies the perspective. The checker reports one non-blocking test-fixture catch narrowing violation, listed under LOW.
- Codegraph was unavailable for this worktree (`no .codegraph/ directory`), so I used direct file/diff reads.

## Commands Run

- `git merge-base origin/main HEAD && git log --oneline --decorate --max-count=8 && git diff --name-status origin/main...HEAD`
- `git diff --stat origin/main...HEAD`
- `sed -n '1,240p' .omo/evidence/w3-pr4-rereview-code-quality.md`
- `sed -n '1,240p' .omo/evidence/w3-pr4-rereview-code-quality-fix.md`
- `sed -n '1,220p' .omo/evidence/subagent-stop-22-w3-pr4-code-quality-fix-verification-3.md`
- Full numbered reads of `health.ts`, `startup-race.ts`, `service.ts`, `reconnect.ts`, `oauth-headless.test.ts`, `oauth-race-worker.ts`, `connection.ts`, `service-snapshot.ts`, `oauth-refresh.ts`, `errors.ts`, `service-register.ts`, `expose/session.ts`, and `expose/register.ts`.
- `git diff --find-renames --find-copies --check e1ab175f957815ab2cdcf357b9f8127a0f80f578..HEAD -- packages/coding-agent/src/core/extensions/builtin/mcp packages/coding-agent/test/mcp` -> PASS, no output.
- `./node_modules/.bin/tsgo --noEmit` -> PASS, no output.
- `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/oauth-headless.test.ts` -> PASS, `13 passed`.
- `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/oauth-headless.test.ts test/mcp/config.test.ts test/mcp/oauth-race.test.ts test/mcp/oauth-callback.test.ts test/mcp/oauth-provider.test.ts test/mcp/auth-modes.test.ts test/mcp/token-store.test.ts` -> PASS, `7 passed`, `59 passed`.
- `bun run /Users/yeongyu/.agents/skills/programming/scripts/typescript/check-no-excuse-rules.ts <six touched fix files>` -> one LOW test-fixture violation at `oauth-race-worker.ts:126`.
- Evidence logs directly inspected:
  - `red-oauth-headless.log` shows the three original blocker regressions failed before the fix.
  - `green-oauth-headless-v2.log` shows `13 passed`.
  - `focused-w3-auth-suite-after-check.log` shows `59 passed`.
  - `manual-mcp-auth-guidance.log` shows startup and reconnect both at `lifecycleState: "needs_auth"` with guidance visible and token store cleared.
  - `npm-run-check.log` shows prior `npm run check` exited 0 after formatting one touched file.

Note: I did not rerun `npm run check` because this assignment forbids write-formatting the repo and the project command runs `biome check --write`. I verified current HEAD with `tsgo --noEmit`, `git diff --check`, focused tests, and the submitted check artifact.

## Findings By Severity

### CRITICAL

None.

### HIGH

None.

### MEDIUM

None.

### LOW

1. `packages/coding-agent/test/mcp/fixtures/oauth-race-worker.ts:126` still trips the programming skill no-excuse rule `catch-without-narrowing`.
   - Evidence: the skill checker reports `catch without instanceof narrowing or re-throw`.
   - Context: this is a test worker serialization boundary, and the same broad catch pattern existed before the after-fix commit. The latest change improves cause traversal with `oauthKind` at `oauth-race-worker.ts:134`; it does not affect production behavior or blocker closure.
   - Recommendation: clean up in a follow-up by narrowing known OAuth/guidance errors before serializing `kind`, and rethrowing unexpected errors so worker failures preserve stack traces.

2. `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts` remains above the programming skill 250 pure-LOC ceiling (`274` pure LOC in my check).
   - Context: this was already noted in the prior report and predates the after-fix commit; the blocker fix adds narrow handling at `service.ts:207` and `service.ts:238`.
   - Recommendation: avoid growing this file further without extracting a responsibility.

## Original Blocker Status

- Startup/catalog refresh: closed. `connectAndRefreshMcpCatalog` catches terminal refresh failures, calls `markMcpConnectionNeedsAuth`, logs guidance, and throws `AuthError` at `packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts:38`. The shared marker sets `needs_auth` and stores the guidance error at `packages/coding-agent/src/core/extensions/builtin/mcp/health.ts:145`; guidance text includes `/mcp auth-start <server>` at `health.ts:180`.
- `McpService.attachSession`: closed. Lazy startup wraps catalog refresh with `ignoreStartupNeedsAuth` at `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts:238`, and the race path uses the same helper at `packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts:23`. `ignoreStartupNeedsAuth` suppresses expected `needs_auth` startup rejection at `startup-race.ts:73`, allowing session startup to remain alive.
- Reconnect: closed. The reconnect callback now refreshes credentials before renew, converts terminal auth failures to `needs_auth`, and throws guidance at `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts:207`. `reconnect.ts:125` no longer overwrites `needs_auth` with generic `degraded`, and manual reconnect still propagates the guidance error at `reconnect.ts:176`.
- Snapshot/guidance propagation: closed. `buildMcpServerSnapshot` reports the connection state and `lastError` message at `packages/coding-agent/src/core/extensions/builtin/mcp/service-snapshot.ts:17`, so `needs_auth` plus guidance are visible to `/mcp` status surfaces.

## Regression Coverage

- `packages/coding-agent/test/mcp/oauth-headless.test.ts:334` covers revoked refresh credentials through `connectAndRefreshMcpCatalog`, asserting thrown `/mcp auth-start fix`, `connection.state === "needs_auth"`, cached catalog absent, and token store cleared.
- `packages/coding-agent/test/mcp/oauth-headless.test.ts:370` covers `McpService.attachSession`, asserting startup stays alive, snapshot lifecycle is `needs_auth`, guidance is visible in `lastError`, tools are not registered, and the token store is cleared.
- `packages/coding-agent/test/mcp/oauth-headless.test.ts:400` covers manual reconnect, asserting `reconnectServer("fix")` throws `/mcp auth-start fix`, snapshot lifecycle is `needs_auth`, and the token store is cleared.
- The tests are meaningful under the `remove-ai-slops` and `programming` perspectives: they use the real OAuth IdP fixture, token store, MCP connection/service paths, and observable service snapshots rather than mirroring private implementation constants.

## Blockers

None.

## Final Decision

The original HIGH blockers are closed in current code and covered by focused regressions. Remaining findings are LOW/non-blocking.

<verdict>PASS</verdict>
