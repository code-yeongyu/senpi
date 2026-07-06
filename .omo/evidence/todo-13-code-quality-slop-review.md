# TODO 13 code-quality / slop review

Date: 2026-07-06
Worktree: `/Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin`
Reviewed blocker fix: `packages/coding-agent/src/core/extensions/builtin/mcp/index.ts`

## Coverage

Loaded and applied:

- `/Users/yeongyu/.agents/skills/remove-ai-slops/SKILL.md`
- `/Users/yeongyu/.agents/skills/programming/SKILL.md`
- `/Users/yeongyu/.agents/skills/programming/references/typescript/README.md`
- `/Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin/AGENTS.md`

Gate review read:

- `.omo/evidence/todo-13-senpi-mcp-plugin-gate-review.md`

Scoped files read in full before editing:

- `packages/coding-agent/src/core/extensions/builtin/mcp/index.ts`
- `packages/coding-agent/src/core/extensions/builtin/mcp/instructions.ts`
- `packages/coding-agent/test/mcp/instructions.test.ts`
- `packages/coding-agent/test/mcp/register-call.test.ts`
- `packages/coding-agent/test/mcp/commands.test.ts`
- `packages/coding-agent/test/mcp/service-lifecycle.test.ts`
- `packages/coding-agent/test/mcp/exposure-policy.test.ts`

## remove-ai-slops review

- Excessive/useless tests: no new test file or assertion was added for this fix; existing TODO 13 tests remain behavior-focused around MCP instruction injection, cap, same-session stability, and escaping.
- Deletion-only tests: none added or modified.
- Tautological tests: none added or modified; existing assertions inspect provider-visible prompts and MCP service behavior, not local implementation variables.
- Implementation-mirroring tests: none added or modified; existing tests assert observable prompt blocks, active tool lists, model-visible tool results, and process lifecycle outcomes.
- Unnecessary extraction: none introduced. The fix is a one-line narrowing guard inside the existing catch block.
- Scope drift: no W2/TODO14 behavior, plan, ledger, dependency, or unrelated MCP behavior changed.
- Over-defensive code: blocker resolved by making the catch boundary explicit. Unknown non-`Error` throwables are not swallowed.
- Dead code / duplication / performance equivalence: no new dead code, duplicated branch, or speculative optimization introduced.
- Oversized module: touched production file is 50 pure LOC, under the 250 pure LOC limit.

Conclusion: remove-ai-slops coverage passes for this blocker-only fix.

## programming review

- No `any`: no `any` annotations or `as any` introduced.
- No type escapes: no `as unknown`, non-null assertion, `@ts-ignore`, or `@ts-expect-error` introduced.
- No dynamic/inline imports: no `import()` or inline type imports introduced.
- No non-erasable TypeScript: no `enum`, `namespace`, parameter property, `import =`, or `export =` introduced.
- No hardcoded paths: none introduced.
- No catch-without-narrowing: fixed. `catch (error)` now narrows with `error instanceof Error`; non-`Error` values are rethrown.
- No unhandled promises: no floating promise introduced; existing awaited async calls remain awaited.
- File pure LOC <=250: `packages/coding-agent/src/core/extensions/builtin/mcp/index.ts` measured at 50 pure LOC.
- LSP diagnostics: no diagnostics found for the changed file.

No-excuse command:

- Invocation: `bun run /Users/yeongyu/.agents/skills/programming/scripts/typescript/check-no-excuse-rules.ts packages/coding-agent/src/core/extensions/builtin/mcp/index.ts`
- Binary observable: `No violations in 1 file(s).`, `EXIT_CODE: 0`
- Artifact: `local-ignore/qa-evidence/20260706-mcp-w1/task13-fix-no-excuse-index.txt`

Conclusion: programming coverage passes for this blocker-only fix.

## Evidence quality

Raw RED/GREEN:

- RED proof artifact: `local-ignore/qa-evidence/20260706-mcp-w1/task13-red-instructions.txt`
- Prior GREEN instructions artifact: `local-ignore/qa-evidence/20260706-mcp-w1/task13-green-instructions-rerun.txt`
- Current focused GREEN artifact: `local-ignore/qa-evidence/20260706-mcp-w1/task13-fix-instructions-test.txt`

W1 INDEX:

- `local-ignore/qa-evidence/20260706-mcp-w1/INDEX.md`
- Current W1 rerun artifact: `local-ignore/qa-evidence/20260706-mcp-w1/task13-fix-w1-driver-rerun.txt`
- Current W1 result JSON: `local-ignore/qa-evidence/20260706-mcp-w1/task13-w1-results.json`

Check/test artifacts:

- `local-ignore/qa-evidence/20260706-mcp-w1/task13-fix-no-excuse-index.txt`
- `local-ignore/qa-evidence/20260706-mcp-w1/task13-fix-instructions-test.txt`
- `local-ignore/qa-evidence/20260706-mcp-w1/task13-fix-relevant-mcp-tests.txt`
- `local-ignore/qa-evidence/20260706-mcp-w1/task13-fix-npm-run-check.txt`

Real-surface / QA artifacts:

- Passing built-in MCP W1 surface: `local-ignore/qa-evidence/20260706-mcp-w1/task13-fix-w1-driver-rerun.txt`
- Result details: `local-ignore/qa-evidence/20260706-mcp-w1/task13-w1-results.json`
- Non-gating helper failure preserved: `local-ignore/qa-evidence/20260706-mcp-w1/task13-fix-senpi-qa-mock-loop-mcp-tool.txt`

Cleanup artifacts:

- `local-ignore/qa-evidence/20260706-mcp-w1/task13-fix-cleanup-scan.txt`
- `local-ignore/qa-evidence/20260706-mcp-w1/task13-fix-cleanup-ps.txt`
- `local-ignore/qa-evidence/20260706-mcp-w1/task13-fix-cleanup-receipt.txt`

Evidence conclusion: artifacts are present and non-empty for the blocker fix, focused tests, repo check, W1 real-surface rerun, and cleanup. The failed senpi QA helper is explicitly preserved as non-gating because it reproduces the prior helper limitation rather than the built-in MCP path.

## Final conclusion

TODO 13's two gate blockers are addressed:

1. Production catch handling now satisfies explicit TypeScript narrowing and the no-excuse checker.
2. This report provides the missing TODO 13 remove-ai-slops + programming review coverage with raw RED/GREEN, W1 index, test/check, and cleanup evidence paths.
