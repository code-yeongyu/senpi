# W3 PR#4 Goal And Constraint Rereview

recommendation: APPROVE
verdict: PASS
worktree: `/Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w3`
branch: `code-yeongyu/senpi-mcp-plugin-w3`
head: `e1ab175f957815ab2cdcf357b9f8127a0f80f578`
base: `origin/main...HEAD` at merge-base `af3a2769dac62670349785cabe657ba420fa0f9e`
reportPath: `.omo/evidence/w3-pr4-rereview-goal-constraints.md`

## originalIntent

Implement Wave 3 / PR#4 TODOs 22-28 from `.omo/plans/senpi-mcp-plugin.md`: MCP OAuth 2.1 auth, hashed 0600 token storage, loopback and headless auth flows, bearer/header auth rules, refresh-race proof, and the W3 11-step auth QA gate. The user-visible outcome is that senpi MCP auth works safely in real CLI/runtime paths, without leaking tokens or requiring real provider credentials.

## desiredOutcome

Reviewers should be able to trust that W3 auth is actually shipped: OAuth tokens are persisted safely, near-expiry tokens refresh through runtime catalog/tool paths, invalid grants lead to clean reauth guidance, callback ports are bounded and conflict-fast, header/bearer auth does not trigger OAuth discovery, race locking prevents rotating-refresh-token family invalidation, and TODO28 evidence proves the real CLI surfaces in an isolated sandbox.

## userOutcomeReview

PASS. The previous failed-gate blockers are fixed at the requested HEAD. `McpRefreshManager` is no longer helper-only: `service.ts`, `startup-race.ts`, `service-register.ts`, `catalog.ts`, `expose/session.ts`, `expose/register.ts`, and `health.ts` carry and invoke `ensureFresh()` before real connect/catalog/tool-call paths. Degraded or needs-auth renewals now surface the same `/mcp auth-start` + `/mcp auth-complete` guidance. `callbackPort` is constrained at schema boundary and fixed-port conflicts fail before browser open. Current TODO28 and gate-fix evidence are present, secret-safe for the current reviewed bundle, and backed by a focused suite I reran locally.

## blockers

None.

## requirementBreakdown

| Requirement | Verdict | Evidence |
|---|---|---|
| TODO22 token store | PASS | `token-store.ts:53-55` hashes URL paths; `:146-149` enforces `0700`; `:166-173` writes atomic `0600`; `:151-163` uses `proper-lockfile`; `:136-144` clears dir and index. `token-store.test.ts:33-56`, `:118-128`, `:130-140`, `:142-168`, `:170-191` cover modes, traversal, clear, concurrent RMW, and held-lock failure. |
| TODO23 OAuth provider/refresh | PASS | `oauth.ts:24-40` refuses missing S256 before redirect; `oauth-provider.ts:158-160` binds RFC8707 resource; `oauth-refresh.ts:25-30`, `:43-85`, `:88-137` implement expiry-5min, in-process coalescing, store lock, terminal invalid-grant cleanup, transient retry. `oauth-provider.test.ts:55-170` covers PKCE/resource/CIMD/refresh/invalid_grant/transient. |
| TODO24 callback server | PASS | `callback.ts:93-119` lazy-binds `127.0.0.1`; `:135-158` fails fixed-port conflict clearly; `:161-198` enforces state and teardown. `commands-auth.ts:102-116` uses fixed port only for static pre-registered clients without callback override. Tests cover schema range, busy port before browser, concurrent auth, override zero-listener. |
| TODO25 headless/client_credentials | PASS | `commands-auth.ts:69-87`, `:147-173`, `:176-182` implement `/mcp auth`, auth-start/complete, client_credentials, and logout. `health.ts:176-180` gives headless guidance for runtime failures. `oauth-headless.test.ts:114-249` covers paste, malformed paste, verifier continuity, client_credentials, logout, initial and degraded headless guidance. |
| TODO26 bearer/header auth | PASS | `auth/context.ts:32-39` makes headers disable OAuth autodetect and bearer env explicit; `transport.ts:179-188` injects `OAUTH_ACCESS_TOKEN` for stdio OAuth; `transport.ts:199-220` resolves bearer env at connect time. `auth-modes.test.ts:52-149` covers zero discovery, env rotation/unset failure, literal-token warning, and redaction. |
| TODO27 race proof | PASS | `oauth-race-worker.ts:78-131` now drives `ServerConnection` + `McpConnectionEntry` + `connectAndRefreshMcpCatalog`, not direct helper-only refresh. `oauth-race.test.ts:129-194` proves lock-on one token hit/no family invalidation and lock-off >=2 hits/family invalidation/post-race failure. |
| TODO28 auth e2e QA gate | PASS | `local-ignore/qa-evidence/20260708-mcp-w3-todo28/INDEX.md` reports 11/11 PASS; `auth-isolation-receipt.json` shows real auth unchanged and real mcp-auth absent; `final-raw-token-scan.log` reports `files_scanned=49`, `match_count=0`; step 5 transcript shows TUI auth-start/auth-complete/test success; step 11 shows print-mode auth-needed isError with no browser attempts. |

## previousBlockerReview

- Refresh manager constructed but not wired: PASS. Runtime wiring is visible at `service.ts:168-186`, `service.ts:201-206`, `startup-race.ts:29-35`, `service-register.ts:22-29`, `catalog.ts:18-24`/`:35-41`/`:57-64`, `expose/session.ts:31-50`, `expose/register.ts:96-120`, and `health.ts:24-29`/`:131-145`.
- Degraded/suspended renew path lost auth guidance: PASS. `health.ts:121-127` converts renew auth failures; `health.ts:176-180` names `senpi interactive`, `/mcp auth-start <server>`, and `/mcp auth-complete <server> <redirect-url>`. Regression: `oauth-headless.test.ts:223-249`.
- `callbackPort` schema too loose: PASS. `config-schema.ts:15-22` bounds integer ports to `0..65_535`; regression: `config.test.ts:165-181`.
- Evidence hygiene concerns: PASS for current W3 gate artifacts. TODO28 final scan and gate-fix final scans are zero-match; stale helper-only reports are explicitly superseded by `.omo/evidence/w3-pr4-todo23-27-28-gate-fix-addendum.md`.

## removeAiSlopsAndProgrammingReview

Loaded and applied `remove-ai-slops` and `programming` with the TypeScript reference. Direct pass over the changed MCP diff found no blocking slop:

- No deletion-only, tautological, mock-only, or helper-call-only replacement tests for the repaired refresh path. The runtime test asserts token endpoint deltas, family-invalidation state, cached catalog content, and real tool result text.
- No unnecessary production parsing/normalization beyond the required TypeBox `callbackPort` boundary.
- No broad new abstraction; refresh is threaded through existing entry/catalog types.
- Static diff scan found no new `any`, `as any`, `as unknown`, TypeScript suppressions, inline imports, empty catches, or obvious debug leftovers in changed MCP source/test diff.
- Changed production MCP auth/expose files are under 250 pure LOC by direct scan; largest are `expose/register.ts` 192, `token-store.ts` 190, `oauth.ts` 182.
- The slop/code-quality report itself explicitly covers helper-vs-runtime overclaim, deletion-only/tautological/mock-only tests, unnecessary parsing, broad abstraction, pure LOC, and evidence hygiene in `.omo/evidence/w3-pr4-gate-fix-code-quality-slop-review.md`.

## commandsRun

- `git status --short --branch`
- `git rev-parse HEAD`
- `git merge-base origin/main HEAD`
- `git log --oneline --decorate --max-count=30`
- `git diff --name-status origin/main...HEAD`
- `rg -n "TODO (2[2-8])|TODO2[2-8]|TODO 22|TODO 23|TODO 24|TODO 25|TODO 26|TODO 27|TODO 28|W3|auth" .omo/plans/senpi-mcp-plugin.md`
- `rg -n "PKCE|RFC8707|resource|client_credentials|invalid_grant|refresh|callback|loopback|OAuth|bearer|headers|token|auth" <spec/comparison>`
- `nl -ba ... | sed -n ...` over plan TODOs, runtime source, auth source, and tests listed below.
- `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/config.test.ts test/mcp/oauth-provider.test.ts test/mcp/oauth-callback.test.ts test/mcp/oauth-headless.test.ts test/mcp/auth-modes.test.ts test/mcp/oauth-race.test.ts test/mcp/token-store.test.ts`
  - Result: PASS, `Test Files 7 passed (7)`, `Tests 56 passed (56)`.
- `git diff --check origin/main...HEAD`
  - Result: non-blocking evidence-log whitespace only: blank line at EOF in three `local-ignore/qa-evidence/20260708-mcp-w3-todo28/*` log/transcript files.
- `git diff --name-only origin/main...HEAD | rg -v '^(packages/coding-agent/src/core/extensions/builtin/mcp/|packages/coding-agent/test/mcp/|\.omo/evidence/|local-ignore/qa-evidence/)'`
  - Result: no output; scope stayed inside W3 extension/test/evidence surfaces.
- Pure LOC scan over changed MCP production TS files.
- Static slop scan over changed MCP source/test diff for `any`, TS suppressions, inline imports, empty catch, console/debug leftovers.
- Current evidence secret scan over `.omo/evidence` and W3 local-ignore evidence. It found only unrelated historical fake-provider/mock-key references and a pre-sanitization local scratch scan log; current TODO28 final scan and gate-fix after/final scans are zero-match.

## checkedArtifactPaths

- `.omo/plans/senpi-mcp-plugin.md`
- `/Users/yeongyu/local-workspaces/research/senpi-mcp-plugin-research/02-senpi-mcp-plugin-spec.md`
- `/Users/yeongyu/local-workspaces/research/senpi-mcp-plugin-research/01-comparison.md`
- `.omo/evidence/w3-pr4-review-goal-constraints.md`
- `.omo/evidence/w3-pr4-gate-fix-refresh-runtime.md`
- `.omo/evidence/w3-pr4-gate-fix-code-quality-slop-review.md`
- `.omo/evidence/w3-pr4-todo23-27-28-gate-fix-addendum.md`
- `.omo/evidence/w3-pr4-review-security.md`
- `.omo/evidence/w3-pr4-review-qa-execution.md`
- `.omo/evidence/subagent-stop-22-w3-pr4-gate-fix-verification.md`
- `.omo/evidence/subagent-stop-22-w3-pr4-gate-fix-verification-2.md`
- `.omo/evidence/subagent-stop-22-w3-pr4-gate-fix-verification-3.md`
- `local-ignore/qa-evidence/20260708-mcp-w3-todo28/INDEX.md`
- `local-ignore/qa-evidence/20260708-mcp-w3-todo28/auth-isolation-receipt.json`
- `local-ignore/qa-evidence/20260708-mcp-w3-todo28/final-raw-token-scan.log`
- `local-ignore/qa-evidence/20260708-mcp-w3-todo28/step-04.json`
- `local-ignore/qa-evidence/20260708-mcp-w3-todo28/step-05-auth-flow-transcript.txt`
- `local-ignore/qa-evidence/20260708-mcp-w3-todo28/step-05.json`
- `local-ignore/qa-evidence/20260708-mcp-w3-todo28/step-07.json`
- `local-ignore/qa-evidence/20260708-mcp-w3-todo28/step-08.json`
- `local-ignore/qa-evidence/20260708-mcp-w3-todo28/step-09.json`
- `local-ignore/qa-evidence/20260708-mcp-w3-todo28/step-10.json`
- `local-ignore/qa-evidence/20260708-mcp-w3-todo28/step-11.json`
- `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/required-focused-auth-suite-after-check.log`
- `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/npm-run-check.log`
- `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/senpi-qa-mock-loop-self-test.log`
- `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/senpi-qa-mock-loop-mcp-tool.log`
- `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/final-raw-token-scan.log`
- `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/race-debug/lock-on-happy-proof.json`
- `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/race-debug/lock-off-family-invalidation-control-proof.json`
- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/context.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/token-store.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/oauth.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/oauth-provider.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/oauth-refresh.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/callback.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/commands-auth.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/config-schema.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/transport.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-register.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/catalog.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/session.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/health.ts`
- `packages/coding-agent/test/mcp/config.test.ts`
- `packages/coding-agent/test/mcp/oauth-provider.test.ts`
- `packages/coding-agent/test/mcp/oauth-callback.test.ts`
- `packages/coding-agent/test/mcp/oauth-headless.test.ts`
- `packages/coding-agent/test/mcp/auth-modes.test.ts`
- `packages/coding-agent/test/mcp/oauth-race.test.ts`
- `packages/coding-agent/test/mcp/fixtures/oauth-race-worker.ts`
- `packages/coding-agent/test/mcp/token-store.test.ts`

## secretSafeEvidenceSummary

Current W3 runtime/evidence artifacts do not expose raw credentials. TODO28 final raw token scan reports `match_count=0`; gate-fix raw scan reports `match_count=0`; named after-sanitization scans report `match_count=0` and `filename_match_count=0`; real `/Users/yeongyu/.senpi/agent/auth.json` is unchanged and real MCP auth storage is absent before/after. The broad rereview scan found only unrelated historical fake-provider/mock-key mentions and an untracked pre-sanitization scratch log; those are not part of the current reviewed W3 tracked evidence and are superseded by the final zero-match scans.

## exactEvidenceGaps

None blocking. Residual non-blocking notes:

- `git diff --check origin/main...HEAD` reports blank-line EOF whitespace in three local-ignore evidence logs/transcripts, not product or test code.
- Historical failed reports and stale tracked/local evidence exist as audit trail; current gate-fix reports and addendum supersede their helper-only refresh claims.
- I did not rerun root `npm run check` because this repo's command includes `biome check --write`; running it would violate the read-only constraint. I inspected the saved passing artifact and reran the non-writing focused auth suite locally.

## finalVerdict

PASS. W3 PR#4 satisfies the plan/spec/comparison requirements for TODO22-28 at `e1ab175f9`, including the previously failed runtime refresh wiring, auth guidance, callbackPort, and evidence-hygiene classes.
