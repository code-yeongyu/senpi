# TODO19/TODO20 Gate Review

recommendation: APPROVE

blockers: None.

originalIntent:
- TODO19: add MCP stdio failure diagnosis and HTTP session-expiry recovery.
- TODO20: add MCP large-output guarding with spill-to-file and bounded previews.

desiredOutcome:
- TODO19 commit contains diagnostic/retry behavior and focused/broader verification.
- TODO20 commit contains output guard behavior and tests, without leaking into TODO19.
- Manual QA proves real CLI surface behavior, auth isolation, cleanup, and no tracked/staged dirt.

userOutcomeReview:
- TODO19 is satisfied by `c804d6140`: it adds `diagnose.ts`, session-expiry retry handling, and `diagnose.test.ts`; direct grep of the TODO19 diff found no output-guard/spill strings.
- TODO20 is satisfied by `9e1df72ba`: it adds `guard/output-guard.ts`, wires `applyMcpOutputGuard()` into MCP tool registration, and adds `output-guard.test.ts`.
- Fresh receipt confirms focused reruns: `diagnose.test.ts` 4 passed and `output-guard.test.ts` 7 passed.
- Broader evidence confirms TODO19 impacted run 5 files/39 tests, TODO20 impacted run 4 files/26 tests, `npm run check` passed, manual QA overall PASS, and every changed source/test file is at or below 250 pure LOC.

checkedArtifactPaths:
- `.omo/plans/senpi-mcp-plugin.md`
- `.omo/evidence/subagent-stop-22-split-commit-verification-3.md`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo19-todo20/INDEX.md`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo19-todo20/summary.json`
- `local-ignore/qa-evidence/20260707-mcp-w2-todo19-todo20/driver-transcript.txt`
- `.omo/evidence/todo-19-code-quality-slop-review.md`
- `.omo/evidence/todo-20-code-quality-slop-review.md`
- `.omo/evidence/task-19-senpi-mcp-plugin-impacted.log`
- `.omo/evidence/task-20-senpi-mcp-plugin-impacted.log`
- `.omo/evidence/task-19-task-20-senpi-mcp-plugin-check.log`
- `.omo/evidence/task-19-task-20-loc-audit.log`

exactEvidenceGaps:
- None found. The only secret-scan hits in inspected summaries were filename false positives from `task-*`; no obvious raw secret leak was present in the inspected summaries.

directSlopAndProgrammingPass:
- Code-review artifacts explicitly covered programming and remove-ai-slops perspectives: no hollow tests, no speculative abstraction, no new `any`/`as any`/suppression escapes, no debug leftovers, no unnecessary compatibility layer, and LOC within the ceiling.
- Direct diff inspection found TODO20 output guard behavior only in `9e1df72ba`, not `c804d6140`.
- Direct test inspection found behavioral assertions rather than deletion-only or tautological tests: TODO19 asserts stderr redaction, bounded rerun, command-not-found UX, and one-retry session expiry; TODO20 asserts byte/line bounds, spill path/readability, binary summary, uniqueness, cleanup, `isError` passthrough, and unwritable fallback.
