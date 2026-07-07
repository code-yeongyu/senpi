# TODO15 Final Gate Review

recommendation: PASS
AdversarialVerify verdict: accepted after follow-up split and fresh verification.

## Original Intent

TODO15 required a 250ms MCP startup race for eager/keep-alive servers:

- session startup must not block on a slow MCP connect
- cached tools must be available immediately
- late connect must hot-swap refreshed tools through the stable sorted registration path
- unchanged tool arrays must remain byte-identical for prompt-cache stability
- wedged servers must keep cached tools visible while tool calls fail with a typed `ConnectError`

## Remediation Summary

The earlier blocker was `service.ts` exceeding the 250 pure LOC ceiling after TODO15. The follow-up split moves startup race, connection, and cache-refresh orchestration into `startup-race.ts`, leaving `service.ts` as the session/service coordinator.

Current pure LOC proof from `.omo/evidence/task-15-senpi-mcp-plugin-ts-audit.log`:

- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`: 230
- `packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts`: 80
- `packages/coding-agent/src/core/extensions/builtin/mcp/connection.ts`: 249
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts`: 174
- `packages/coding-agent/test/mcp/startup-race.test.ts`: 171

## Verification

Fresh commands run after the current WIP:

- Focused TODO15 test: `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/startup-race.test.ts`
  - Result: PASS, 1 file / 6 tests.
  - Artifact: `.omo/evidence/task-15-senpi-mcp-plugin-tests-final.log`
- Impacted MCP tests: `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/catalog-cache.test.ts test/mcp/register-call.test.ts test/mcp/service-lifecycle.test.ts test/mcp/connection.test.ts test/mcp/ping-on-call.test.ts`
  - Result: PASS, 5 files / 33 tests.
  - Artifact: `.omo/evidence/task-15-senpi-mcp-plugin-impacted.log`
- Root check: `npm run check`
  - Result: PASS, including Biome, pinned deps, TS imports, shrinkwrap/install-lock checks, TypeScript, browser/web UI checks, and `check:neo`.
  - Artifact: `.omo/evidence/task-15-senpi-mcp-plugin-npm-check.log`
- No-excuse TS/LOC/manual QA audit
  - Result: PASS.
  - Artifact: `.omo/evidence/task-15-senpi-mcp-plugin-ts-audit.log`

## Code Quality / Slop Review

Detailed review artifact: `.omo/evidence/todo-15-code-quality-slop-review.md`

Covered criteria:

- LOC limits: all audited TODO15 TS files are below 250 pure LOC.
- Forbidden TypeScript: no `any`, `as any`, `@ts-ignore`, `@ts-expect-error`, inline imports, or non-erasable TypeScript syntax found.
- Async safety: the single `void connect.then(...)` is the intended late hot-swap continuation; it reaches a refresh helper that catches and logs refresh failures. Timer use is the bounded 250ms race.
- Hollow tests: focused test drives local MCP fixture behavior, warm cache registration, late live tool execution, byte-identical active tool arrays, and wedged `ConnectError` behavior.
- Prompt-cache sorting: late refresh reuses `registerDirectMcpTools` and `registerToolsPreservingActiveSet`; sorted registration lines are captured in the audit log.
- Secret safety: evidence uses mock provider authorization redaction and records only auth hashes/unchanged status.

## Manual QA Provenance

Manual QA bundle: `local-ignore/qa-evidence/20260706-mcp-w2-todo15/`

Required non-empty artifacts confirmed by `.omo/evidence/task-15-senpi-mcp-plugin-ts-audit.log`:

- `INDEX.md`
- `command-transcript.txt`
- `auth-isolation.txt`
- `cleanup.txt`
- `happy-rpc-transcript.json`
- `failure-rpc-transcript.json`
- `todo15-manual-qa-driver.mjs`

Observed scenarios:

- Happy path: PASS. Cached tool reached first provider request in 42ms; late hot-swap exposed `mcp_fx_tool_1,mcp_fx_tool_2`.
- Failure path: PASS. Cached tool stayed visible; `ConnectError` returned to the model in 558ms and RPC stayed responsive.
- Auth isolation: PASS. `realAuthAfterUnchanged=true`.
- Cleanup: PASS. `cleanup=complete`; no tmux sessions left.

## Residual Worktree Note

Untracked stop-hook evidence for TODO14/TODO16 is unrelated and intentionally left unstaged/unmodified. It is not part of TODO15 completion.
