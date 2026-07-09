# Upstream Merge Report

## Result

- Upstream tag: `v0.80.5`
- Upstream main SHA merged: `8432c6f28595b88538a9ff67be9073f90ceafb8a`
- Merge commit: `43a639974619f8ab035e7a0c16f83a90a496a583`
- Pin updated in `.github/upstream.json` with `synced_at: 2026-07-09T19:52:23Z`
- Changelog audit commit: `e911d6d94 docs(changelog): audit upstream 8432c6f`

## Preserved Fork Behavior

- Kept fork package naming, private package graph, CalVer workspace versions, and generated install/shrinkwrap artifacts.
- Preserved fork-only builtin extension behavior, including bundled codemode, MCP, goal, terminal, permission, and import-repro surfaces.
- Preserved session-work settling, service-tier/favorite-model flows, context-exclusion compaction behavior, and fork model request metadata.
- Preserved neo/RPC fork surfaces while adding upstream `agent_settled` event handling.

## Conflicts Resolved

- `package-lock.json`: upstream lockfile did not match the fork package graph after conflict resolution, so the fork-compatible lockfile was regenerated with `npm install --package-lock-only --ignore-scripts`.
- `packages/coding-agent/src/core/agent-session.ts`: merged upstream settled-event behavior with fork abort, retry, queued-message, and session-work semantics. Added guards so aborted turns do not drain queued continuations.
- `packages/coding-agent/src/core/model-registry.ts`: preserved fork request metadata maps and added upstream configured model overrides.
- `packages/coding-agent/src/core/resource-loader.ts`: preserved bundled builtin extension loading and upstream inline extension naming support.
- `packages/coding-agent/src/core/compaction/compaction.ts`: preserved context-exclusion handling and added upstream custom-message budgeting.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: preserved fork favorite-model and auth-provider behavior while keeping upstream cache/session/auth completion changes.
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`: kept the fork connection-handler implementation because upstream's inline version was incompatible with the fork RPC surface.

## Changelog Entries Added

- `packages/ai/CHANGELOG.md`
- `packages/agent/CHANGELOG.md`
- `packages/coding-agent/CHANGELOG.md`
- `packages/tui/CHANGELOG.md`

## Focused Fixes After QA

- Added Go/neo coverage for the new `agent_settled` event and marked it as transcript-ignored.
- Fixed RPC test helper typing for `AgentSessionEvent[]`.
- Restored footer token comma formatting.
- Kept inline extension naming tests focused on inline entries when default builtins are present.
- Prevented aborted session turns and goal tool aborts from scheduling hidden continuations.
- Ensured MCP status refreshes captured stderr diagnostics before rendering `lastError`.

## QA

- `npm run build`: passed.
- `npm run check`: passed; final run applied one formatter fix and completed cleanly.
- `npm test`: passed.
- Built CLI smoke:
  - `node packages/coding-agent/dist/cli.js --version`: `2026.7.9`
  - `node packages/coding-agent/dist/cli.js --help`: passed.
- Focused regression checks:
  - `npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-session-concurrent.test.ts test/footer-token-format.test.ts test/suite/goal-e2e.test.ts test/suite/regressions/6260-inline-extension-naming.test.ts`: passed.
  - `npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/commands.test.ts`: passed.
- senpi-qa:
  - `node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check`: passed.
  - `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test --evidence upstream-agent-mock-loop`: passed.
  - `node .agents/skills/senpi-qa/scripts/cli-smoke.mjs --self-test`: passed.
  - `node .agents/skills/senpi-qa/scripts/tui-smoke.mjs --self-test --driver tmux --evidence upstream-agent-tui`: passed.

## Evidence

- `local-ignore/qa-evidence/20260709-upstream-agent-qa/common-self-check.log`
- `local-ignore/qa-evidence/20260709-upstream-agent-qa/mock-loop-self-test.log`
- `local-ignore/qa-evidence/20260709-upstream-agent-qa/cli-smoke-self-test.log`
- `local-ignore/qa-evidence/20260709-upstream-agent-qa/tui-smoke-self-test.log`
- `local-ignore/qa-evidence/20260709-upstream-agent-tui/tui-smoke-tmux.txt`

## Secret Safety

- QA ran in isolated sandboxes with `PI_OFFLINE=1` where applicable.
- senpi-qa confirmed the real `/home/runner/.senpi/agent/auth.json` hash was unchanged.
- Evidence paths are under `local-ignore/` and are not committed.
