# PR-010 Commands

This work is using code-yeongyu/lazycodex teammode.

Commands were run from `/Users/yeongyu/.codex/worktrees/pr010-reconnect-resume/senpi` unless noted.

- `git fetch origin main`
- `git worktree add -b code-yeongyu/pi-codex-app-server-reconnect-resume /Users/yeongyu/.codex/worktrees/pr010-reconnect-resume/senpi origin/main`
- `node node_modules/vitest/dist/cli.js --run test/suite/pi-codex-app-server-reconnect.test.ts`
- `node node_modules/vitest/dist/cli.js --run test/suite/pi-codex-app-server-reconnect.test.ts test/suite/pi-codex-app-server-reconnect-review.test.ts` after adding review regressions for nested `turn.id` and cursor preservation.
- `node node_modules/vitest/dist/cli.js --run test/suite/pi-codex-app-server-contract.test.ts test/suite/pi-codex-app-server-harness.test.ts test/suite/pi-codex-app-server-routing.test.ts test/suite/pi-codex-app-server-session-read-routing.test.ts test/suite/pi-codex-app-server-callbacks.test.ts test/suite/pi-codex-app-server-streaming.test.ts test/suite/pi-codex-app-server-backpressure.test.ts test/suite/pi-codex-app-server-mcp-dynamic-tools.test.ts test/suite/pi-codex-app-server-reconnect.test.ts test/suite/pi-codex-app-server-reconnect-review.test.ts`
- `npm run check`
- `node /Users/yeongyu/.codex/plugins/cache/sisyphuslabs/omo/4.13.0/skills/programming/scripts/typescript/check-no-excuse-rules.ts <changed TypeScript files>`
- `node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check`
- `node .agents/skills/senpi-qa/scripts/cli-smoke.mjs --self-test`
- `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test`
- `node packages/coding-agent/src/core/extensions/builtin/pi-codex-app-server/qa/drive-adapter.mjs --help`
- `gh project list --owner code-yeongyu --format json --limit 20`

The worktree uses local untracked `node_modules` symlinks to the already-installed dependency tree at `/Users/yeongyu/local-workspaces/senpi/node_modules`; these are cleanup-only local conveniences and are not staged.
