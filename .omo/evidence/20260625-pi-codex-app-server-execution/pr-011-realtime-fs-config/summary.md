# PR-011 Realtime/filesystem/plugin/config pass-through evidence

This work is using code-yeongyu/lazycodex teammode.

## Scope

- Implemented Wave 5 request pass-through only for PR-011-owned app-server client requests: filesystem `fs/*`, realtime `thread/realtime/*`, app/plugin/skills/hooks/marketplace/config/externalAgentConfig/remoteControl surfaces.
- Kept command/process/MCP/tool/account/model/review/fuzzy-file/windows/feedback/environment/mock surfaces outside PR-011 rejected as `unsupported-routing-method` unless already handled by prior specific routes.
- Added opaque notification coverage for fs/realtime/warning/deprecation/config/app/remote-control notifications through the existing app-server event envelope.

## Failing-first proof

- Command: `npx tsx ../../node_modules/vitest/dist/cli.js --run test/suite/pi-codex-app-server-pass-through.test.ts`
- Initial result before implementation: FAIL, 2 failed / 1 passed. New pass-through tests received `unsupported-routing-method` instead of app-server responses or capability-gated errors.

## Verification

- Targeted PR-011 test: `npx tsx ../../node_modules/vitest/dist/cli.js --run test/suite/pi-codex-app-server-pass-through.test.ts` -> PASS, 1 file / 4 tests.
- Full pi-codex adapter suite: `npx tsx ../../node_modules/vitest/dist/cli.js --run test/suite/pi-codex-app-server-*.test.ts` -> PASS, 15 files / 60 tests.
- Required check: `npm run check` -> PASS.
- senpi QA common harness: `node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check` -> PASS, 9/9, real auth unchanged.
- Adapter harness availability: `node packages/coding-agent/src/core/extensions/builtin/pi-codex-app-server/qa/drive-adapter.mjs --help` -> PASS.

## Scenario 17

- Scenario 17 live realtime text/audio against a real Codex app-server runtime is NOT-RUN for PR-011 in this isolated senpi worktree because PR-012/PR-013 final manual QA/redaction lanes remain gated and no live Codex realtime app-server endpoint is available here.
- PR-011 coverage instead proves protocol/router pass-through for `thread/realtime/*` and opaque realtime notifications with hermetic tests. No runtime transport, callback, stream projection, reconnect, redaction, or final evidence scope was added.

## Project tracking

- `gh project list --owner code-yeongyu --format json --limit 20` -> `BLOCKED:missing-gh-project-scope` because token is missing `read:project`.

## Cleanup

- Removed ignored `.codegraph` symlink at `/Users/yeongyu/.codex/worktrees/cd6e/senpi/.codegraph` so Biome would not follow `/Users/yeongyu/.omo/codegraph/projects/senpi-dab18ee9e5d425a8/daemon.sock` and fail `npm run check` with `internalError/fs Unknown file type`.
- Cleanup receipt: `local-ignore/qa-evidence/20260625-pi-codex-app-server/pr-011-realtime-fs-config/tool-state-cleanup.txt`.
- `npm install --ignore-scripts` was used only to hydrate the isolated worktree; `node_modules/` remains ignored and no package metadata was changed.

## Secret safety

- Evidence contains no raw tokens, auth headers, cookies, launchd environments, or real credential contents.
- senpi QA common self-check verified `/Users/yeongyu/.senpi/agent/auth.json` was unchanged.

## Residual risks

- Runtime transport and live realtime audio behavior remain covered by downstream manual QA lanes, not this protocol-only PR.
- PR-011 intentionally does not pass through command/process/MCP/tool/account/model/review/windows/feedback/environment surfaces.
