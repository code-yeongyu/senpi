# TODO24 Code Quality / Slop Review

Scope:
- packages/coding-agent/src/core/extensions/builtin/mcp/auth/commands-auth.ts
- packages/coding-agent/src/core/extensions/builtin/mcp/config-schema.ts
- packages/coding-agent/test/mcp/oauth-callback.test.ts

Skills applied:
- programming: TypeScript strictness, TDD order, no any/dynamic imports/non-erasable TS, no one-off helpers, 250 pure LOC ceiling.
- remove-ai-slops: deletion ladder, over-defensive code, needless abstraction, dead code, duplication, complexity, performance equivalence, oversized file, and missing/tautological/overfit test coverage review.

Behavior lock:
- RED first: local-ignore/qa-evidence/20260708-mcp-w3-todo24-fix/red-oauth-callback.txt
  - fixed port not wired through runAuth.
  - fixed busy port opened browser instead of failing fast.
  - override runAuth rejected via waitForCode instead of pending paste completion.
- GREEN final: local-ignore/qa-evidence/20260708-mcp-w3-todo24-fix/green-oauth-callback-final.txt
  - 10 callback tests passed.
- Impacted tests: local-ignore/qa-evidence/20260708-mcp-w3-todo24-fix/impacted-oauth-tests-final.txt
  - 15 impacted OAuth tests passed.

Deletion ladder:
- Existing LoopbackCallbackServer behavior was reused; no new callback server abstraction was added.
- Existing pending provider map and runAuthComplete paste flow were reused for override completion.
- Existing OAuthFlowError/actionable message path was reused for port conflicts.
- A temporary one-use production helper was removed before final verification; callback-port selection is local to runInteractive.
- A superseded channel-only override test was removed after the full runAuth override test covered the same user-visible requirement.

Slop category review:
- Obvious comments: no new decorative or restating comments in production. Existing comments explain flow boundaries.
- Over-defensive code: no duplicate state validation added; fixed-port selection only gates the configured pre-registered path. No broad catch/empty catch added to committed TS.
- Excessive complexity: no nested ternary or tagged-variant if-chain remains in changed production. The callback-port condition is a single guarded branch.
- Needless abstraction: no new helper/interface remains for a single caller.
- Boundary violations: config schema owns parsing shape; commands-auth owns auth orchestration; tests own harness-only probes.
- Dead code: no unused imports after removing the channel-only override test; final check passed.
- Duplication: test helper reuse remains for port, auth fixture, and redirect following. No new production duplication.
- Performance equivalence: no algorithmic/performance changes were made.
- Oversized modules: pure LOC artifact shows callback.ts 164, commands-auth.ts 165, config-schema.ts 132, oauth-callback.test.ts 235; all under 250.

Programming review:
- No `any`, `as any`, `as unknown`, `@ts-ignore`, `@ts-expect-error`, `enum`, namespace/module syntax, dynamic import, console logging, debugger, throw literal, or empty catch found in changed TS files.
- Static scan artifact: local-ignore/qa-evidence/20260708-mcp-w3-todo24-fix/targeted-static-scan.txt
- Full project check artifact: local-ignore/qa-evidence/20260708-mcp-w3-todo24-fix/npm-run-check-final.txt
- No dependency, lockfile, shrinkwrap, or generated model changes.

Test overfit/slop review:
- Fixed-port tests assert observable redirect_uri and busy-port browser count, not private implementation.
- Override test drives runAuth plus runAuthComplete and asserts zero listener via port probe, pending paste state, and stored token.
- Timeout test asserts observable port closure and active server-handle non-growth; the prior unsupported "handle returns to baseline" wording was removed.
- Tests are not deletion-only and do not mirror implementation internals beyond the public auth command surface.

Manual QA review:
- Artifact: local-ignore/qa-evidence/20260708-mcp-w3-todo24-fix/manual-todo24-fix-qa-final.txt
- Curl-follow happy path, duplicate auth rejection, fixed-port busy conflict, override paste completion, timeout teardown, and cleanup receipts all passed.
- senpi QA artifacts prove real auth isolation:
  - local-ignore/qa-evidence/20260708-mcp-w3-todo24-fix/senpi-qa-common-self-check.txt
  - local-ignore/qa-evidence/20260708-mcp-w3-todo24-fix/senpi-qa-cli-smoke.txt
  - local-ignore/qa-evidence/20260708-mcp-w3-todo24-fix/senpi-qa-mock-loop.txt

Result:
- CLEAN. No TODO24-specific code slop or overfit issue remains from this pass.
