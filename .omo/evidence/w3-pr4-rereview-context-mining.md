# W3 PR#4 Context Mining Re-Review

Worktree: `/Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w3`
Branch: `code-yeongyu/senpi-mcp-plugin-w3`
HEAD: `e1ab175f9`
Diff baseline: `origin/main...HEAD`

## Goal

Re-run the W3 PR#4 context-mining gate and look specifically for missed requirements, superseded assumptions, or background context that would change whether W3 is ready.

## Sources Searched

### Plan / Spec

- `.omo/plans/senpi-mcp-plugin.md`
- `/Users/yeongyu/local-workspaces/research/senpi-mcp-plugin-research/02-senpi-mcp-plugin-spec.md`
- `/Users/yeongyu/local-workspaces/research/senpi-mcp-plugin-research/01-comparison.md`

### Git History

- `git log --oneline --decorate -n 20 --graph --all --max-count=20`
- `git log --oneline --decorate --grep='oauth\|auth\|refresh\|mcp' --max-count=80`
- `git log --oneline --decorate --max-count=30 -- .`

### Current Code Cross-References

- `packages/coding-agent/src/core/extensions/builtin/mcp/config-schema.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/token-store.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/oauth-provider.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/commands-auth.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/commands-auth-dispatch.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/callback.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/context.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/oauth-refresh.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-register.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/connection.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/health.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/index.ts`

### Review / Evidence Context

- `.omo/evidence/w3-pr4-review-qa-execution.md`
- `.omo/evidence/w3-pr4-review-security.md`
- `.omo/evidence/w3-pr4-debugging-runtime-audit.md`
- `.omo/evidence/w3-pr4-review-goal-constraints.md`
- `.omo/evidence/w3-pr4-todo23-27-28-gate-fix-addendum.md`
- `.omo/evidence/todo28-senpi-mcp-plugin-final-gate-review.md`
- `.omo/evidence/todo28-senpi-mcp-plugin-final-rereview.md`
- `local-ignore/qa-evidence/20260708-mcp-w3-todo28/INDEX.md`
- `local-ignore/qa-evidence/20260708-mcp-w3-todo28/final-raw-token-scan.log`
- `local-ignore/qa-evidence/20260708-mcp-w3-todo28/auth-isolation-receipt.json`

### Commands Run

- `git -C /Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w3 rev-parse --short HEAD`
- `git -C /Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w3 status --short`
- `sed -n '1,240p' /Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w3/.omo/plans/senpi-mcp-plugin.md`
- `sed -n '1,260p' /Users/yeongyu/local-workspaces/research/senpi-mcp-plugin-research/02-senpi-mcp-plugin-spec.md`
- `sed -n '1,260p' /Users/yeongyu/local-workspaces/research/senpi-mcp-plugin-research/01-comparison.md`
- `git -C /Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w3 log --oneline --decorate -n 20 --graph --all --max-count=20`
- `rg -n "mcp oauth|oauth refresh|refresh token|client provider|headless|callback server|bearer|auth-start|auth-complete|needs_auth|token store|mcp-auth|McpAuth|OAuthClientProvider" packages/coding-agent .omo/plans/senpi-mcp-plugin.md .omo/evidence -g '!**/*.log'`
- `rg -n "PR#4|W3|todo2[2-8]|auth gate|refresh race|client_credentials|paste flow|loopback|refresh" .omo/evidence .omo/plans/senpi-mcp-plugin.md packages/coding-agent/src packages/coding-agent/test`
- `gh pr view 4 --json number,title,state,headRefName,baseRefName,body,comments,reviews,files,commits`
- `gh pr list --head code-yeongyu/senpi-mcp-plugin-w3 --json number,title,state,headRefName,baseRefName,body --limit 20`
- `gh issue list --state all --search 'mcp oauth W3 auth' --json number,title,state,labels,comments`
- `gh issue list --state all --search 'MCP auth refresh race' --json number,title,state,body,labels --limit 20`
- `rg -n "TODO|FIXME|XXX|TBD|PENDING|missing|inert until|not implemented|test-only escape hatch|headless betrayal|NOT implemented|placeholder" packages/coding-agent/src/core/extensions/builtin/mcp .omo/evidence/w3-pr4* .omo/evidence/task-28* .omo/evidence/todo28*`
- `rg -n "McpRefreshManager|ensureFresh\\(|refresh\\(\\)|needs_auth|authPlan\\.refresh|reconnectServer|attachSession\\(" packages/coding-agent/src/core/extensions/builtin/mcp`
- `sed -n '1,320p' packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`
- `sed -n '1,260p' packages/coding-agent/src/core/extensions/builtin/mcp/connection.ts`
- `sed -n '1,240p' packages/coding-agent/src/core/extensions/builtin/mcp/health.ts`
- `sed -n '1,200p' packages/coding-agent/src/core/extensions/builtin/mcp/index.ts`

## Findings

### 1. The earlier refresh-runtime concern is closed in current HEAD.

The review notes in `.omo/evidence/w3-pr4-review-goal-constraints.md` said TODO23/TODO27 proof was only helper-level and that production runtime did not invoke `McpRefreshManager`. That was a valid concern in the older evidence set, but it is no longer true at current HEAD.

Current code shows the runtime path now uses the refresh manager:

- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts:204` calls `entry.authPlan?.refresh?.ensureFresh()` in the reconnect path.
- `packages/coding-agent/src/core/extensions/builtin/mcp/health.ts:137` also calls `ensureFresh()` before tool-call health checks.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-register.ts:28` passes `ensureFresh` through to direct tool registration.
- `packages/coding-agent/src/core/extensions/builtin/mcp/index.ts` wires `attachSession(...)` on `session_start`, so the runtime path is not isolated to test-only helpers.

This means the prior “helper-only refresh” gap is not a live blocker anymore.

### 2. The auth surface now matches the W3 requirements that mattered for readiness.

The current code and evidence cover the important W3 requirements from the plan/spec:

- OAuth 2.1 provider + PKCE S256 enforcement: `packages/coding-agent/src/core/extensions/builtin/mcp/auth/oauth-refresh.ts`
- 0600 token store with URL-derived directory layout and cross-process locking: `packages/coding-agent/src/core/extensions/builtin/mcp/auth/token-store.ts`
- Headless paste flow and client_credentials support: `packages/coding-agent/src/core/extensions/builtin/mcp/auth/commands-auth.ts`
- Loopback callback server with CSRF/state validation and timeout handling: `packages/coding-agent/src/core/extensions/builtin/mcp/auth/callback.ts`
- Bearer/header auth autodetect rules with explicit header-based opt-out: `packages/coding-agent/src/core/extensions/builtin/mcp/auth/context.ts`
- Needs-auth fail-fast behavior in non-UI paths: `packages/coding-agent/src/core/extensions/builtin/mcp/health.ts`

The plan/spec and the recent commit trail line up with those behaviors.

### 3. The earlier evidence-hygiene concern is superseded by newer TODO28 evidence.

The older review artifacts (`.omo/evidence/w3-pr4-review-qa-execution.md`) flagged stale evidence files that contained secret-like filenames or driver scaffolding. However:

- `.omo/evidence/todo28-senpi-mcp-plugin-final-rereview.md` explicitly says the controlling artifact is the newer `final-raw-token-scan.log`.
- `local-ignore/qa-evidence/20260708-mcp-w3-todo28/final-raw-token-scan.log` reports `match_count=0` and `verdict=PASS`.
- `local-ignore/qa-evidence/20260708-mcp-w3-todo28/auth-isolation-receipt.json` reports the real `~/.senpi/agent/auth.json` unchanged and `~/.senpi/agent/mcp-auth` absent before/after.

So the earlier stale-evidence issue does not remain a blocker for the current gate.

## Missed Requirements / Background Check

No blocking missed requirement remains after re-checking the plan/spec, runtime code, and the latest W3 evidence bundle.

Background context that changed the judgment:

- The W3 gate was previously conservative because the runtime refresh path had not been proven.
- That concern is now closed by current HEAD wiring and by the later TODO28 evidence addendum.
- The remaining evidence hygiene note is historical, not controlling.

## Verdict

<verdict>PASS</verdict>

Blockers: none.
