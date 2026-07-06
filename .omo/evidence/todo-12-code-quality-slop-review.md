# TODO 12 Code Quality And Slop Review

Date: 2026-07-06
Branch: code-yeongyu/senpi-mcp-plugin-w1
Scope: TODO 12 gate-review blockers only.

## Skill Inputs

- Read `/Users/yeongyu/.agents/skills/programming/SKILL.md`.
- Read `/Users/yeongyu/.agents/skills/programming/references/typescript/README.md`.
- Read `/Users/yeongyu/.agents/skills/remove-ai-slops/SKILL.md`.
- Local `scripts/typescript/check-no-excuse-rules.ts` was not present in this worktree, so source scans below are explicit `rg`/LOC checks plus `npm run check`.

## Verdict

PASS. The TODO 12 gate blockers are resolved without TODO 11/W2 scope creep.

## Code Smells

PASS.

- Source reviewed:
  - `packages/coding-agent/src/core/extensions/builtin/mcp/status.ts`
  - `packages/coding-agent/test/mcp/commands.test.ts`
- Change shape:
  - Production behavior remains best-effort status rendering.
  - Test fixture now creates a real `ExtensionRunner` command context instead of asserting a partial object through `unknown`.
- No new dependency, public API, generated file, or config change.

## Catch Handling

PASS.

- Previous blocker: `status.ts` swallowed all `connection.client.listTools` failures without explanation.
- Fix: `readToolCount` now catches `unknown`, normalizes non-`Error` rejections with `error instanceof Error ? error : new Error(String(error))`, and passes an `Error` to `unavailableToolCount`.
- Boundary justification: tool counts are display-only status detail. If a connected server rejects `tools/list`, `/mcp status` remains responsive and renders `tools=?`.
- Verification scan:
  - `rg -n "as unknown as ExtensionCommandContext|catch \\{|catch \\([^)]*\\)" packages/coding-agent/src/core/extensions/builtin/mcp/status.ts packages/coding-agent/test/mcp/commands.test.ts`
  - Observable: only `packages/coding-agent/src/core/extensions/builtin/mcp/status.ts:62` remains as the intended status boundary catch.

## Type Escapes

PASS.

- Previous blocker: `commands.test.ts` used `as unknown as ExtensionCommandContext`.
- Fix: `createCtx` now constructs an `ExtensionRunner` with `SessionManager.inMemory()` and `ModelRegistry.create(AuthStorage.create(...))`, sets the typed test UI context, and returns `runner.createCommandContext()`.
- The test UI now implements `ExtensionUIContext` directly; unused UI methods are no-op test double methods, and `custom<T>()` throws if called rather than asserting a generic return.
- Verification scan:
  - `rg -n "as unknown as|as any|: any|import\\(|await import|enum |namespace |module |@ts-ignore|@ts-expect-error|~/.senpi|\\.senpi/agent" <TODO 12 source/test files>`
  - Observable: exit 1, no matches.

## Test Overfit, Tautology, Excessiveness

PASS.

- `commands.test.ts` still asserts observable slash-command behavior:
  - `/mcp` registration count/name.
  - Panel/status text from service snapshots.
  - `/mcp add` confirm yes/no file effects.
  - enable/disable config rewrite and service resync.
  - logs/reconnect-stub/unknown-server messages.
  - live fixture `/mcp test` success with elapsed milliseconds.
  - wedged fixture bounded failure and responsive follow-up status.
- The new context fixture is infrastructure only; it reduces type coupling and does not add tautological assertions.
- No tests were deleted or weakened.

## Scope Drift

PASS.

- No TODO 11 exposure-policy implementation.
- No W2 reconnect/resilience implementation.
- `/mcp reconnect` remains the explicit TODO 12 stub: `MCP reconnect for <name> is not available until W2.`
- Verification scan:
  - `rg -n "TODO 11|exposure policy|exposurePolicy|policy" <TODO 12 source/test files>`
  - Observable: exit 1, no matches.

## LOC

PASS with one warning-band file that already belongs to the TODO 12 command test surface.

- `commands.ts`: 165 pure LOC.
- `config-edit.ts`: 56 pure LOC.
- `status.ts`: 62 pure LOC.
- `index.ts`: 23 pure LOC.
- `service.ts`: 226 pure LOC.
- `commands.test.ts`: 244 pure LOC.
- `extension-load.test.ts`: 106 pure LOC.
- Command used:
  - `awk '!/^[[:space:]]*$/ && !/^[[:space:]]*(\\/\\/|#|--)/' <file> | wc -l`
- `commands.test.ts` is under the 250 pure LOC defect threshold and should be split before future growth.

## Banned TypeScript Syntax

PASS.

- No `enum`.
- No `namespace`/`module`.
- No parameter properties introduced.
- No inline imports or dynamic imports.
- No `@ts-ignore` or `@ts-expect-error`.
- No `any` annotations or `as any`.
- No `as unknown`.

## Hardcoded Config Path

PASS.

- Scan found no hardcoded `~/.senpi` or `.senpi/agent` in TODO 12 touched source/test files.

## Manual Evidence Quality

PASS.

- Existing manual artifacts are non-empty:
  - `manual-mcp-panel.txt`: 1776 bytes.
  - `manual-wedged-test.txt`: 8015 bytes.
  - `manual-responsive-status.txt`: 8396 bytes.
  - `manual-auth-proof.txt`: 326 bytes.
  - `manual-cleanup.txt`: 125 bytes.
- Consolidated matrix created at `local-ignore/qa-evidence/20260706-mcp-w1-task12/INDEX.md`.

## Verification Commands

PASS.

- `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/commands.test.ts`
  - Artifact: `local-ignore/qa-evidence/20260706-mcp-w1-task12/commands-fix-final.txt`
  - Observable: 1 file passed, 6 tests passed.
- `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/extension-load.test.ts test/mcp/service-lifecycle.test.ts test/mcp/register-call.test.ts`
  - Artifact: `local-ignore/qa-evidence/20260706-mcp-w1-task12/dependency-regressions-fix-final.txt`
  - Observable: 3 files passed, 19 tests passed.
- `npm run check`
  - Artifact: `local-ignore/qa-evidence/20260706-mcp-w1-task12/npm-run-check-fix.txt`
  - Observable: exit 0.

## Remaining Risks

- `/mcp reconnect` is intentionally a W2 stub.
- `commands.test.ts` is in the 200-250 pure LOC warning band at 244 pure LOC.
