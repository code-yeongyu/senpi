# TODO17 code-quality and slop review

Scope: TODO17 MCP reconnect/retry code and post-retry-fix cleanup.

Verdict: PASS after cleanup.

Evidence:
- No-excuse TypeScript audit: `.omo/evidence/task-17-quality-cleanup-no-excuse.log` reports no violations across 14 TODO17 TypeScript files.
- Pure LOC audit: `.omo/evidence/task-17-quality-cleanup-loc.log` reports every TODO17 TypeScript file at or below 250 pure LOC; `reconnect.test.ts` is 225 and `fixtures/reconnect.ts` is 48.
- Focused behavior test: `.omo/evidence/task-17-quality-cleanup-reconnect.log` reports 8 reconnect tests passed.
- Impacted MCP suite: `.omo/evidence/task-17-quality-cleanup-impacted.log` reports 7 files and 50 tests passed.
- Root check: `.omo/evidence/task-17-quality-cleanup-check.log` reports `npm run check` exit 0.
- Whitespace gate: `.omo/evidence/task-17-quality-cleanup-diff-check.log` captures `git diff --check HEAD~2` exit 0.
- Manual QA integrity: `.omo/evidence/task-17-quality-cleanup-manual-qa-integrity.log` verifies prior real CLI QA bundles and cleanup receipts because this cleanup did not change runtime code.

Remove-ai-slops criteria:
- Hollow tests: PASS. Reconnect tests assert observable reconnect state, counters, payload text, retry count, and error surfacing.
- Over-broad retry: PASS. Tests keep exactly-one failed-send retry and in-flight transport death without duplicate execution covered.
- Hidden compatibility downgrade: PASS. Cleanup only extracted test helpers and removed an unnecessary test-side type escape; runtime code and public APIs were unchanged.
- Fake QA: PASS. Prior real source CLI QA bundles remain non-empty and marker-verified; this cleanup references them only after integrity checks.
- LOC under 250: PASS. All TODO17 TypeScript files are at or below 250 pure LOC.
- Forbidden TypeScript syntax: PASS. No `any`, `as any`, `as unknown`, `@ts-ignore`, `@ts-expect-error`, inline imports, `enum`, or forbidden emit-only syntax were introduced.
- Secret leakage: PASS. Cleanup evidence contains command output and artifact paths only; prior retry-fix QA records localhost fake-provider usage and cleanup receipts.

Programming criteria:
- Type narrowing: PASS. Polling helper catches `unknown`, narrows with `instanceof Error`, and rethrows non-Error values.
- Test helper extraction: PASS. Shared reconnect fixture owns file-reading, wait, delay, and server-config helpers; test behavior remains semantically identical.
- No needless abstraction: PASS. Extracted helpers have multiple call sites or remove the oversized test-file defect.
- Adversarial classes recorded: stale_state, dirty_worktree, misleading_success_output, flaky_tests, hung_or_long_commands, prompt_injection/secret leakage, malformed_input, repeated_interruptions/no-duplicate preservation, cancel_resume not applicable.
