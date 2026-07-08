# TODO25 Code Quality / Slop Review

Scope:

- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/oauth.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/health.ts`
- `packages/coding-agent/test/mcp/oauth-headless.test.ts`

## Behavior Lock

- RED: `red-toolcall.log`, `red-one-use.log`.
- GREEN: `green-oauth-headless-final.log`.
- Adjacent regressions: OAuth provider/callback/race/token-store/auth-modes/register-call logs in `local-ignore/qa-evidence/20260708-mcp-w3-todo25/`.
- Full gate: `npm-run-check.log`.

## Deletion Ladder

- Delete entirely: none. The added behavior is required by TODO25 non-UI and expired/one-use code criteria.
- Reuse existing code: reused `OAuthFlowError`, `isInvalidGrant`, `AuthError`, existing token-store invalidation, and existing MCP tool definition execution path.
- Platform/dependency: retained SDK auth; no hand-rolled OAuth protocol.
- Simplify in place: bounded cause unwrapping mirrors existing connection classification.

## Category Review

- Obvious comments: no new restating comments added.
- Over-defensive code: bounded cause unwrapping has a named reason (SDK/transport wraps auth errors). No broad catch-and-swallow.
- Excessive complexity: no function exceeds 50 lines from this change; no new nested branching beyond one guard classifier.
- Needless abstraction: no new exported helper or module.
- Boundary violations: auth handling remains inside MCP auth/health layers; tests use fixture IdP.
- Dead code/debug: static scan found no `console.log`, `debugger`, TODO/FIXME, `any`, `as any`, ts-ignore, or enum usage in changed files.
- Duplication: test helpers are small and local. `oauth-headless.test.ts` is 203 pure LOC; next expansion should extract harness helpers before adding more cases.
- Performance equivalence: no algorithmic/performance change.
- Oversized modules: all changed files below 250 pure LOC (`health.ts` 148, `oauth.ts` 182, `oauth-headless.test.ts` 203).

## Quality Gates

- Regression tests: PASS.
- Lint/typecheck/check: PASS via `npm run check`.
- LSP diagnostics: PASS, no diagnostics on changed TS files.
- Static/no-excuse scan: PASS, only benign substring/comment hits.
- Manual QA: PASS, tmux TUI paste flow + headless failure/M2M transcript archived.

## Remaining Risks

- `oauth-headless.test.ts` is in the 200-250 LOC warning band.
- Remote real-world OAuth servers remain out of scope for TODO25 and are fixture-gated by the plan.

Final status: CLEAN.
