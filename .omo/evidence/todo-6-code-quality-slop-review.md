# Todo 6 Post-Fix Code Quality / Slop Review

Scope:

- `packages/coding-agent/test/mcp/wrap.test.ts`
- `packages/coding-agent/test/mcp/wrap-async.test.ts`

## Change Summary

- Split the oversized MCP wrapper test file by moving async wrapper and production logger coverage into `wrap-async.test.ts`.
- Kept error taxonomy and raw async source guard coverage in `wrap.test.ts`.
- No runtime/source behavior changed.

## No RED Justification

No RED run was required for this post-fix because the change is a test-only file split with unchanged assertions and imports adjusted only to match the new file boundary. The production logger regression remains covered by the focused passing test named `records wrapped error messages through the production MCP logger`.

## LOC Guardrail

Measured with both total `wc -l` and pure LOC excluding blank and `//` comment-only lines:

- `packages/coding-agent/test/mcp/wrap.test.ts`: 108 total LOC, 97 pure LOC.
- `packages/coding-agent/test/mcp/wrap-async.test.ts`: 194 total LOC, 172 pure LOC.

Both modified test files are below the 250 pure LOC guardrail.

Artifact: `local-ignore/qa-evidence/20260706-mcp-task-6-split/loc.txt`

## Programming Pass

- No `any` introduced.
- No inline imports introduced in checked TypeScript.
- Erasable TypeScript only: imports, interfaces, functions, classes, and object narrowing.
- Test assertions and behavior are preserved across the split.
- Temporary child-process scripts remain generated under OS temp directories and are cleaned by `afterEach`.

## Remove-AI-Slops Pass

- Deletion ladder: no test coverage was removed; async wrapper assertions were moved intact.
- Obvious comments: none added.
- Over-defensive code: no new defensive branches were added.
- Needlessly complex abstraction: no shared helper module was introduced; each test file owns only the helpers it needs.
- Duplication/performance: no production code path changed.
- Oversized modules: touched test files are now 97 and 172 pure LOC.

## Overfit Review

- The production logger regression still uses real `createMcpLogger`, not only `MemoryLogger`.
- The focused test verifies that `prod.scope` and `prod boom` are written to both ring buffer and file output.
- Artifact: `local-ignore/qa-evidence/20260706-mcp-task-6-split/prod-logger-focused-test.txt`

## Verification

- Focused wrap tests: `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/wrap.test.ts test/mcp/wrap-async.test.ts` passed 2 files / 9 tests.
- Production logger focused test: `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/wrap-async.test.ts -t "records wrapped error messages through the production MCP logger" --reporter verbose` passed 1 selected test.
- Manual QA gate: `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --with-tool --evidence mcp-task-6-split` passed 4/4 and reported real auth unchanged.
- Check: `npm run check` exited 0.

Evidence directory: `local-ignore/qa-evidence/20260706-mcp-task-6-split/`

## Residual Risk

Low. This is a test-only split; the only residual risk is import drift between split files, covered by the focused Vitest run and `npm run check`.
