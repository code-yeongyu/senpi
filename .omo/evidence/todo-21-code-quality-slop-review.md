# TODO21 Code Quality / Slop Review

Scope: TODO21 final gate blockers for `code-yeongyu/senpi-mcp-plugin-w2`.

Files reviewed:
- `packages/coding-agent/src/core/extensions/builtin/mcp/connection.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/connection-types.ts`
- `packages/coding-agent/test/suite/regressions/mcp-prefixed-extension-tool-allowlist.test.ts`

Gate reviewer exact blockers:
- Missing TODO21-specific slop/code-quality artifact: fixed by this report.
- `mcp-prefixed-extension-tool-allowlist.test.ts` non-null assertion: fixed by explicit `model === undefined` narrowing with a clear setup error.
- `connection.ts` over 250 pure LOC: fixed by extracting public connection state/event/options contracts into `connection-types.ts`.

remove-ai-slops category audit:
- Obvious comments: PASS, no obvious/comment-only slop added.
- Over-defensive code: PASS, the new model guard is boundary/setup validation for a possibly absent registry entry, not defensive duplication.
- Excessive complexity: PASS, no new nesting or complex boolean logic.
- Needless abstraction: PASS, `connection-types.ts` is a cohesive public type-contract split needed to clear the 250 LOC module defect while preserving the `connection.ts` re-export surface.
- Boundary violations: PASS, no new cross-layer runtime imports or side effects.
- Dead code: PASS, no unused helpers or removed-but-referenced code.
- Duplication: PASS, no duplicated logic introduced.
- Performance equivalences: N/A, no behavior-preserving optimization was attempted.
- Missing tests: PASS, existing focused regression and MCP connection tests cover the touched behavior; no new behavior was introduced.
- Oversized modules: PASS, final pure LOC artifact reports `connection.ts` 245, `connection-types.ts` 31, regression test 71.

programming category audit:
- Strict TypeScript: PASS, no `any`, no non-null assertion, no `@ts-ignore`, no `@ts-expect-error`, no inline imports.
- Erasable TS: PASS, only type aliases/interface/import type/re-export type were added.
- File size: PASS, all touched TS files are <= 250 pure LOC.
- Behavior lock before cleanup: PASS, baseline regression and connection tests passed before editing; baseline no-excuse and LOC artifacts reproduced the blockers.

Gate reviewer exact checks:
- Excessive/useless tests: PASS, no tests added; existing regression still asserts observable active tool names.
- Deletion-only tests: PASS, no test deletion or deletion-only assertion was introduced.
- Implementation-mirroring/tautological tests: PASS, no implementation detail assertions were added.
- Unnecessary extraction: PASS, extraction owns public connection contracts and keeps `connection.ts` on the state-machine responsibility.
- Oversized module handling: PASS, real split used; no `SIZE_OK` escape.
- No-excuse results: PASS in `local-ignore/qa-evidence/20260707-mcp-w2-todo21-quality-fix/final-no-excuse-gate-command.txt`.
- Pure LOC results: PASS in `local-ignore/qa-evidence/20260707-mcp-w2-todo21-quality-fix/final-pure-loc-scope.txt`.
- Scope drift: PASS, code changes are limited to the two blocker TS files plus the new cohesive split file and TODO21 evidence.
- Secret safety: PASS, no secret-bearing logs committed; QA artifacts are under ignored `local-ignore/`, and chaos cleanup records auth unchanged.
- Dirty worktree scope: PASS, unrelated pre-existing `.omo/evidence/subagent-*`, stop-hook, and gate-review files were left unstaged.

Verification artifacts:
- Baseline focused tests: `local-ignore/qa-evidence/20260707-mcp-w2-todo21-quality-fix/baseline-regression-test.txt`, `baseline-connection-test.txt`.
- Baseline blockers: `baseline-no-excuse-subset.txt`, `baseline-pure-loc.txt`.
- Final required tests: `final-regression-test.txt`, `final-impacted-mcp-tests.txt`.
- Final static gates: `final-no-excuse-gate-command.txt`, `final-pure-loc-scope.txt`, `rerun-npm-run-check-after-compile-fix.txt`.
- senpi QA: `final-senpi-qa-mock-loop-self-test.txt`.
- Cleanup: `final-cleanup-receipts.txt`, `chaos-current-diff/cleanup-receipt.txt`.

Follow-up full-suite stabilization:
- The out-of-scope `packages/coding-agent/test/footer-data-provider.test.ts` timeout drift was removed.
- MCP-only wait stabilization was kept in `catalog-cache.test.ts`, `idle.test.ts`, and `startup-race.test.ts` because eager and keep-alive registration are asynchronous after the current MCP startup-race fixes.
- Focused MCP tests passed: `local-ignore/qa-evidence/20260707-mcp-w2-todo21-full-test-green/focused-mcp-tests.txt`.
- Full root `npm test` passed with provider env stripped and `PI_NO_LOCAL_LLM=1`: `local-ignore/qa-evidence/20260707-mcp-w2-todo21-full-test-green/root-npm-test-final.txt`.
- `npm run check`, exact no-excuse gate command, pure LOC, senpi mock-loop QA, and cleanup receipts passed under `local-ignore/qa-evidence/20260707-mcp-w2-todo21-full-test-green/`.

Residual risk:
- None identified in the current evidence set.

Final status: CLEAN FOR TODO21 QUALITY BLOCKERS AND FULL ROOT TEST GATE.
