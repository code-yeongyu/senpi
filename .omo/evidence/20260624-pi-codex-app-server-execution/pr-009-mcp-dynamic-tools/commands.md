# PR-009 Commands

This work is using code-yeongyu/lazycodex teammode.

## Failing First

```bash
cd /Users/yeongyu/local-workspaces/senpi/packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/suite/pi-codex-app-server-mcp-dynamic-tools.test.ts
```

Result before implementation: 1 file failed, 3 of 4 tests failed. Dynamic tool
and MCP elicitation server requests returned adapter errors instead of
lossless callback delivery; unsupported-method copy still referenced PR-008
only. Raw local artifact:
`local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-009-mcp-dynamic-tools/failing-first.txt`.

## Targeted And Adjacent Tests

```bash
cd /Users/yeongyu/local-workspaces/senpi/packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/suite/pi-codex-app-server-mcp-dynamic-tools.test.ts
```

Result: 1 file / 4 tests passed. Raw local artifact:
`local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-009-mcp-dynamic-tools/targeted-mcp-dynamic-tools.txt`.

```bash
cd /Users/yeongyu/local-workspaces/senpi/packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run \
  test/suite/pi-codex-app-server-mcp-dynamic-tools.test.ts \
  test/suite/pi-codex-app-server-callbacks.test.ts \
  test/suite/pi-codex-app-server-contract.test.ts \
  test/suite/pi-codex-app-server-routing.test.ts \
  test/suite/pi-codex-app-server-streaming.test.ts \
  test/suite/pi-codex-app-server-backpressure.test.ts
```

Result: 6 files / 28 tests passed. Raw local artifact:
`local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-009-mcp-dynamic-tools/app-server-suite.txt`.

## Check And QA

```bash
cd /Users/yeongyu/local-workspaces/senpi
npm run check
```

Result: passed. Raw local artifact:
`local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-009-mcp-dynamic-tools/npm-run-check.txt`.

```bash
cd /Users/yeongyu/local-workspaces/senpi
NODE_PATH=/Users/yeongyu/local-workspaces/senpi/node_modules \
  node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check
NODE_PATH=/Users/yeongyu/local-workspaces/senpi/node_modules \
  node .agents/skills/senpi-qa/scripts/cli-smoke.mjs --self-test
NODE_PATH=/Users/yeongyu/local-workspaces/senpi/node_modules \
  node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test
node packages/coding-agent/src/core/extensions/builtin/pi-codex-app-server/qa/drive-adapter.mjs --help
npx tsx local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-009-mcp-dynamic-tools/tools/check-no-excuse-rules.ts \
  packages/coding-agent/src/core/extensions/builtin/pi-codex-app-server/server-request-bridge.ts \
  packages/coding-agent/src/core/extensions/builtin/pi-codex-app-server/item-stream-projector.ts \
  packages/coding-agent/test/suite/pi-codex-app-server-mcp-dynamic-tools.test.ts
git diff --check
```

Results:

- senpi QA common self-check: 9/9 passed.
- senpi QA CLI smoke: 5/5 passed.
- senpi QA mock loop: 5/5 passed.
- Adapter help rendered.
- No-excuse audit: no violations in 3 files.
- `git diff --check`: passed.

Raw local artifacts:

- `senpi-qa-common-self-check.txt`
- `senpi-qa-cli-smoke.txt`
- `senpi-qa-mock-loop.txt`
- `drive-adapter-help.txt`
- `no-excuse-audit.txt`
- `git-diff-check.txt`

## Project Tracking

```bash
gh project list --owner code-yeongyu --format json --limit 20
```

Result: `BLOCKED:missing-gh-project-scope`; token is missing `read:project`.
