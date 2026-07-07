# TODO15 Evidence Receipt

Task: 250ms startup race + late-connect hot-swap.

## RED -> GREEN

- RED: `.omo/evidence/task-15-senpi-mcp-plugin-red.log`
  - `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/startup-race.test.ts`
  - Failed before implementation because slow eager startup took 2359ms, hot-swap was not observable as cached-first, and wedged cached call did not expose a ConnectError cause.
- GREEN: `.omo/evidence/task-15-senpi-mcp-plugin-green.log`
  - Same focused test file passed: 6 tests.
- Final focused + impacted suite: `.omo/evidence/task-15-senpi-mcp-plugin-tests-final.log`
  - `test/mcp/startup-race.test.ts`
  - `test/mcp/catalog-cache.test.ts`
  - `test/mcp/register-call.test.ts`
  - `test/mcp/service-lifecycle.test.ts`
  - `test/mcp/connection.test.ts`
  - `test/mcp/ping-on-call.test.ts`
  - Passed: 6 files, 39 tests.

## Static Gates

- Root check: `.omo/evidence/task-15-senpi-mcp-plugin-npm-check.log`
  - `npm run check`
  - Passed.
- TypeScript no-excuse audit: `.omo/evidence/task-15-senpi-mcp-plugin-ts-audit.log`
  - No dedicated helper found in `.agents` or `scripts`; explicit changed-file `rg` audit found no forbidden patterns.

## Manual QA

- Bundle: `local-ignore/qa-evidence/20260706-mcp-w2-todo15/INDEX.md`
- Command receipt: `.omo/evidence/task-15-senpi-mcp-plugin-manual-qa.log`
- Happy path: real source CLI over RPC, warm cache, slow `--slow-start 5000` fixture. Prompt provider request arrived 52ms after prompt submission while fixture was still connecting; later hot-swap exposed `mcp_fx_tool_2` and the tool result reached the model.
- Failure path: real source CLI over RPC, warm cache, `--wedge` fixture. Cached `mcp_fx_tool_1` stayed visible; first call completed in 589ms with model-visible `ConnectError`; `get_state` succeeded afterward.
- Auth isolation: `auth-isolation.txt` in the bundle records unchanged real `~/.senpi/agent/auth.json` hash.
- Cleanup: `cleanup.txt` in the bundle records fixture process death and sandbox removal.
