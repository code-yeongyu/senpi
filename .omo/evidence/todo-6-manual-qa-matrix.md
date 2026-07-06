# Todo 6 Fix Manual QA Matrix

Evidence root: `local-ignore/qa-evidence/20260706-mcp-task-6-fix/`
Main log: `.omo/evidence/task-6-fix-senpi-mcp-plugin.log`

| Scenario | Invocation | Binary observable | Captured artifact |
|---|---|---|---|
| RED production logger regression | `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/wrap.test.ts` after adding only the real-logger test | Exit 1 with `expected ... to contain 'prod boom'`; received JSON had `message:"prod.scope"` and `data:{}` | `.omo/evidence/task-6-fix-senpi-mcp-plugin.log` |
| GREEN focused wrapper suite | `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/wrap.test.ts` after implementation | Exit 0; `Test Files 1 passed`; `Tests 9 passed` | `.omo/evidence/task-6-fix-senpi-mcp-plugin.log` |
| Wrapped child-process survival | Same focused wrapper suite, test `keeps a child process alive when a wrapped timer callback throws` | Child exits 0, stdout contains `child.timer:timer boom`, stderr empty | `.omo/evidence/task-6-fix-senpi-mcp-plugin.log` |
| Unwrapped scratch failure | Same focused wrapper suite, test `proves an unwrapped timer callback exits non-zero in the scratch failure probe` | Child exits non-zero and stderr contains `unwrapped boom` | `.omo/evidence/task-6-fix-senpi-mcp-plugin.log` |
| Production logger safeTimer probe | `node node_modules/tsx/dist/cli.mjs /tmp/todo6-prod-logger-probe.mjs` | Exit 0; JSON has `ok:true`, `uncaught:null`, ring/file entries include `data.message:"prod boom"` | `local-ignore/qa-evidence/20260706-mcp-task-6-fix/prod-logger-probe.txt` and `.omo/evidence/task-6-fix-senpi-mcp-plugin.log` |
| senpi real-surface mock-loop QA | `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test` | Exit 0; 5/5 passed; localhost fake providers only; real auth unchanged | `local-ignore/qa-evidence/20260706-mcp-task-6-fix/mock-loop-self-test.txt` and `.omo/evidence/task-6-fix-senpi-mcp-plugin.log` |
| Repository quality gate | `npm run check` | Exit 0; Biome no fixes; shrinkwrap/install-lock up to date; `check:neo` passed | `local-ignore/qa-evidence/20260706-mcp-task-6-fix/npm-run-check.txt` and `.omo/evidence/task-6-fix-senpi-mcp-plugin.log` |
| Cleanup | `rm /tmp/todo6-prod-logger-probe.mjs`; process scan for probe/mock/test commands | Temp probe removed; no leftover matching processes | `.omo/evidence/task-6-fix-senpi-mcp-plugin.log` |

## Notes

- The RED failure proves the rejected production-logger bug, not a synthetic `MemoryLogger` mismatch.
- The production probe avoids misleading success by inspecting both the in-memory ring and file sink output from `createMcpLogger`.
- LSP diagnostics were checked on changed files. `wrap.test.ts` reported no diagnostics. `wrap.ts` reported Node-type resolution diagnostics on pre-existing Node timer/import lines while `npm run check` and `tsgo --noEmit` passed; this is recorded in the main log as an LSP server resolution issue, not a TypeScript gate failure.
