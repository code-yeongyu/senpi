# W3 PR#4 Security After-Fixes Rereview

recommendation: APPROVE
verdict: PASS

<verdict>PASS</verdict>

## blockers

None.

## originalIntent

Re-review W3 PR#4 security/evidence hygiene blockers after the latest fixes in `/Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w3` at HEAD `558566e5ab9ab5294f1f39f23d58777fe005219c`, diffed against `origin/main...HEAD`.

## desiredOutcome

PASS only if the previously leaking raw sentinel access/refresh token values are absent from W3 evidence, the repaired scan scope includes the previously omitted historical QA log and final W3 gate-fix evidence, and newly changed product files after `e1ab175f9` do not introduce any CRITICAL/HIGH security issue.

## userOutcomeReview

The shipped outcome satisfies the security/evidence hygiene request:

- The previously leaking `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/secret-scan-named-before.log` now has `raw_sentinel_count=0`.
- The historical QA log `local-ignore/qa-evidence/20260708-mcp-w3-todo28/final-raw-token-scan.log` is included in the repaired broad raw-sentinel scan scope and has `raw_sentinel_count=0`.
- All 28 files under `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/` are included in the repaired broad raw-sentinel scan scope.
- Independent broad W3 evidence scan covered 338 W3 evidence files and found `raw_sentinel_matching_files=0`.
- Product/security review of files changed after `e1ab175f9` found no CRITICAL/HIGH issue.

## checkedArtifactPaths

- `.omo/evidence/w3-pr4-rereview-security.md`
- `.omo/evidence/w3-pr4-rereview-security-fix.md`
- `.omo/evidence/w3-pr4-rereview-code-quality-fix.md`
- `.omo/evidence/w3-pr4-gate-fix-code-quality-slop-review.md`
- `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/secret-scan-named-before.log`
- `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/secret-scan-named-after.log`
- `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/secret-scan-named-filenames-after.log`
- `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/complete-secret-scan-after-sanitization.log`
- `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/complete-secret-scan-scope-after-sanitization.txt`
- `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/raw-sentinel-absence-after-sanitization.log`
- `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/raw-sentinel-absence-scope-after-sanitization.txt`
- `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/rg-raw-sentinel-absence-after-sanitization.log`
- `local-ignore/qa-evidence/20260708-mcp-w3-todo28/final-raw-token-scan.log`
- `local-ignore/qa-evidence/20260708-w3-pr4-rereview-code-quality-fix/focused-w3-auth-suite-after-check.log`
- `local-ignore/qa-evidence/20260708-w3-pr4-rereview-code-quality-fix/green-oauth-headless-v2.log`
- `local-ignore/qa-evidence/20260708-w3-pr4-rereview-code-quality-fix/npm-run-check.log`
- `local-ignore/qa-evidence/20260708-w3-pr4-rereview-code-quality-fix/manual-mcp-auth-guidance.log`
- `local-ignore/qa-evidence/20260708-w3-pr4-rereview-code-quality-fix/secret-scan.log`
- `packages/coding-agent/src/core/extensions/builtin/mcp/health.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/reconnect.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts`
- `packages/coding-agent/test/mcp/fixtures/oauth-race-worker.ts`
- `packages/coding-agent/test/mcp/oauth-headless.test.ts`

## blockerStatus

- Prior blocker: historical W3 QA evidence contained raw sentinel access/refresh token values.
  Status: resolved. Direct counts on the previously leaking file and historical QA log are zero.
- Prior blocker: final scan scope omitted the leaking historical QA artifact.
  Status: resolved. The repaired raw-sentinel scope includes the historical todo28 final scan log and all final gate-fix evidence files.
- Product security after `e1ab175f9`.
  Status: PASS. No CRITICAL/HIGH issue found in the four runtime files changed after that commit.

## verificationCommands

```bash
git rev-parse HEAD
git diff --name-status e1ab175f9..HEAD
git diff --name-only e1ab175f9..HEAD -- 'packages/coding-agent/src/**' 'packages/coding-agent/test/**' | sort
```

Observed HEAD `558566e5ab9ab5294f1f39f23d58777fe005219c`. Product/test files changed after `e1ab175f9`:

- `packages/coding-agent/src/core/extensions/builtin/mcp/health.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/reconnect.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts`
- `packages/coding-agent/test/mcp/fixtures/oauth-race-worker.ts`
- `packages/coding-agent/test/mcp/oauth-headless.test.ts`

```bash
grep -Fqx 'local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/secret-scan-named-before.log' local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/raw-sentinel-absence-scope-after-sanitization.txt
grep -Fqx 'local-ignore/qa-evidence/20260708-mcp-w3-todo28/final-raw-token-scan.log' local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/raw-sentinel-absence-scope-after-sanitization.txt
find local-ignore/qa-evidence/20260708-w3-pr4-gate-fix -type f | sort | comm -23 - <(sort local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/raw-sentinel-absence-scope-after-sanitization.txt) | wc -l
```

Observed:

- `secret-scan-named-before.log`: PRESENT in repaired raw-sentinel scope.
- `final-raw-token-scan.log`: PRESENT in repaired raw-sentinel scope.
- `gate_fix_files_missing_from_raw_sentinel_scope=0` out of `gate_fix_files_total=28`.

```bash
rg -I -o --pcre2 'SENTINEL_(?:AT|RT)_[A-Za-z0-9_-]+' local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/secret-scan-named-before.log | wc -l
rg -I -o --pcre2 'SENTINEL_(?:AT|RT)_[A-Za-z0-9_-]+' local-ignore/qa-evidence/20260708-mcp-w3-todo28/final-raw-token-scan.log | wc -l
rg -I -o --pcre2 'SENTINEL_(?:AT|RT)_[A-Za-z0-9_-]+' local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/raw-sentinel-absence-after-sanitization.log | wc -l
rg -I -o --pcre2 'SENTINEL_(?:AT|RT)_[A-Za-z0-9_-]+' local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/rg-raw-sentinel-absence-after-sanitization.log | wc -l
```

Observed all direct counts as `0`.

```bash
tmp=$(mktemp /tmp/w3-evidence-scope-final.XXXXXX)
{ git diff --name-only origin/main...HEAD | rg '^(\.omo/evidence|local-ignore/qa-evidence)/' || true; find .omo/evidence -type f | rg '/(w3-pr4|task-2[2-8]|todo-?2[2-8]|subagent-stop-22-(todo2[2-8]|w3-pr4))' || true; find local-ignore/qa-evidence -type f | rg '20260708-(mcp-w3|w3-pr4)' || true; } | sort -u > "$tmp"
xargs -r rg -l -I --pcre2 'SENTINEL_(?:AT|RT)_[A-Za-z0-9_-]+' < "$tmp" | wc -l
rm -f "$tmp"
```

Observed:

- `files_scanned=338`
- `raw_sentinel_matching_files=0`
- `includes_secret_scan_named_before=1`
- `includes_historical_todo28_final_raw_token_scan=1`
- `gate_fix_files_missing_from_scope=0`
- cleanup: removed temporary scope file.

```bash
grep -E 'files_scanned|match_count|verdict|scope' local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/complete-secret-scan-after-sanitization.log
grep -E 'files_scanned|match_count|verdict|scope' local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/raw-sentinel-absence-after-sanitization.log
grep -E 'files_scanned|match_count|verdict|scope' local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/rg-raw-sentinel-absence-after-sanitization.log
```

Observed:

- complete gate-fix scan: `files_scanned=28`, `scope_includes_historical_before_log=true`, `scope_includes_final_scan_log=true`, `match_count=0`, `raw_sentinel_match_count=0`, `verdict=PASS`.
- raw-sentinel absence scan: `files_scanned=240`, `match_count=0`, `verdict=PASS`.
- explicit `rg` absence scan: `files_scanned=240`, `match_count=0`, `verdict=PASS`.

```bash
git diff --check e1ab175f9..HEAD -- packages/coding-agent/src/core/extensions/builtin/mcp/health.ts packages/coding-agent/src/core/extensions/builtin/mcp/reconnect.ts packages/coding-agent/src/core/extensions/builtin/mcp/service.ts packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts
git diff e1ab175f9..HEAD -- packages/coding-agent/src/core/extensions/builtin/mcp | rg -n 'console\.|debugger|TODO|FIXME'
git diff e1ab175f9..HEAD -- packages/coding-agent/src/core/extensions/builtin/mcp | rg -n 'Bearer[[:space:]]+[A-Za-z0-9._~+/=-]{12,}'
git diff e1ab175f9..HEAD -- packages/coding-agent/src packages/coding-agent/test | rg -o --pcre2 'SENTINEL_(?:AT|RT)_[A-Za-z0-9_-]+' | wc -l
```

Observed:

- `git diff --check`: PASS.
- new runtime `console`/`debugger`/`TODO`/`FIXME`: `0`.
- new runtime bearer literals: `0`.
- new diff raw sentinel values: `0`.

## productSecurityAfterE1ab175f9

Reviewed the post-`e1ab175f9` runtime changes directly:

- `health.ts` now centralizes terminal OAuth refresh failures through `markMcpConnectionNeedsAuth`, marks the connection `needs_auth`, and emits guidance without exposing token material.
- `startup-race.ts` now converts terminal refresh failures to `needs_auth` and suppresses that expected startup rejection so `attachSession` can remain alive and expose status guidance. Non-auth errors are still rethrown.
- `service.ts` now applies the same auth guidance path during reconnect pre-renew refresh.
- `reconnect.ts` no longer overwrites `needs_auth` as generic `degraded`.

No CRITICAL/HIGH issue found.

## qaEvidenceConsulted

- `local-ignore/qa-evidence/20260708-w3-pr4-rereview-code-quality-fix/green-oauth-headless-v2.log`: `Test Files 1 passed (1)`, `Tests 13 passed (13)`.
- `local-ignore/qa-evidence/20260708-w3-pr4-rereview-code-quality-fix/focused-w3-auth-suite-after-check.log`: `Test Files 7 passed (7)`, `Tests 59 passed (59)`.
- `local-ignore/qa-evidence/20260708-w3-pr4-rereview-code-quality-fix/npm-run-check.log`: check exited 0; Biome, pinned deps, import checks, shrinkwrap/install-lock checks, `tsgo --noEmit`, browser smoke, web UI check, and `check:neo` passed.
- `local-ignore/qa-evidence/20260708-w3-pr4-rereview-code-quality-fix/manual-mcp-auth-guidance.log`: startup and reconnect both reported `lifecycleState: "needs_auth"`, guidance visible, and store cleared.
- `local-ignore/qa-evidence/20260708-w3-pr4-rereview-code-quality-fix/secret-scan.log`: `match_count=0`.

Note: `local-ignore/qa-evidence/20260708-w3-pr4-gate-fix/race-green-after-worker.log` is a stale intermediate failed artifact. It is superseded by the later post-fix focused auth suite above.

## removeAiSlopsAndProgrammingReview

Direct pass:

- No deletion-only tests, removal-only tests, or tautological helper-call tests introduced after `e1ab175f9`.
- New tests exercise observable runtime behavior: catalog refresh guidance, startup survival with `needs_auth`, manual reconnect guidance, store clearing, and the real service snapshot/tool registration surface.
- No unnecessary production extraction, parsing, or normalization found in the post-`e1ab175f9` product diff.
- New production catch blocks either convert the expected terminal OAuth class to typed `AuthError` guidance or rethrow unknown errors.
- No raw credential values, bearer literals, console/debug output, TypeScript suppression, or non-erasable TypeScript syntax introduced in the reviewed runtime diff.

Report coverage:

- `.omo/evidence/w3-pr4-gate-fix-code-quality-slop-review.md` explicitly covers slop/overfit criteria: no deletion-only tests, no helper-call assertions, no tautological mock-only refresh coverage, no product parsing/normalization beyond boundary validation, no broad abstraction, no real provider calls, and no raw credential values in the committed report.
- `.omo/evidence/w3-pr4-rereview-code-quality-fix.md` records the post-`e1ab175f9` RED/GREEN evidence, adversarial classes, secret scan, cleanup receipt, and residual risk for the guidance wrapper.

## exactEvidenceGaps

None for the requested security/evidence-hygiene rereview.

Residual note: older intermediate logs remain in the evidence tree, including one failed race debug artifact, but they do not contain raw sentinel token values and are superseded by later passing post-fix evidence.

## cleanupReceipt

- Product code/tests/commits/branches/PRs were not edited by this rereview.
- Temporary scratch files under `/tmp/w3-*` were removed.
- Final scratch check found no remaining `/tmp/w3-evidence-scope*`, `/tmp/w3-gate-scope*`, `/tmp/w3-raw-sentinel-matching-paths.txt`, or `/tmp/w3-diff-check.out`.
- `git status --short --branch --untracked-files=no` showed no tracked product worktree changes; product files are clean at HEAD.
- This report is the only workspace file written by this rereview.
