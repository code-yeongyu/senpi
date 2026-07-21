# Upstream Merge Report

## Summary

- Result: PR-ready merge of `badlogic/pi-mono` release `v0.81.1`.
- Upstream release tag: `v0.81.1` (`20be4b18d4c57487f8993d2762bace129f0cf7c6`).
- Merged upstream head: `upstream/main` (`dd6bea41efa8caa7a10fe5a6401676dc5699f83f`).
- Confirmed ancestry: `upstream/main` is an ancestor of `HEAD`.
- Upstream pin: `.github/upstream.json` records tag `v0.81.1`, sha `dd6bea41efa8caa7a10fe5a6401676dc5699f83f`, synced at `2026-07-21T22:06:51Z`.

## Commits

- `1b694e3c5` - `Merge upstream/main v0.81.1`
- `40e38a2d6` - `sync: record upstream pin dd6bea4`
- `1868ce4b7` - `docs(changelog): audit upstream dd6bea4`
- `69c44ec36` - `fix: restore upstream merge QA gates`
- `d7a09995e` - `fix(coding-agent): cover merged runtime protocols`

## Fork Preservation

- Preserved fork package identity and runtime names: `@code-yeongyu/senpi`, `senpi`, `.senpi`, and CalVer `2026.7.20-2`.
- Preserved fork-only builtin extension behavior under `packages/coding-agent/src/core/extensions/builtin/`.
- Accepted upstream `packages/orchestrator` to `packages/server` rename while preserving Senpi-compatible state paths and `SENPI_ORCHESTRATOR_DIR`.
- Kept fork `changes.md` notes and fork release changelog sections intact.

## Conflict Resolution

- `package-lock.json`: took upstream shape and regenerated with npm lock tooling.
- `packages/coding-agent/install-lock/package-lock.json` and `packages/coding-agent/publish-deps.lock.json`: regenerated after manifest/package resolution changes.
- Fork-modified runtime files were resolved semantically, preserving Senpi behavior while adopting upstream changes:
  - `packages/agent/src/agent-loop.ts`
  - `packages/coding-agent/src/core/agent-session.ts`
  - `packages/coding-agent/src/core/model-runtime.ts`
  - `packages/coding-agent/src/core/session-manager.ts`
  - `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
  - `packages/tui/src/tui.ts`
- Removed stale conflict-base marker lines from markdown/changelog surfaces during cleanup.
- No unresolved conflicts remain.

## Changelog Audit

Added upstream `Unreleased` entries for affected packages:

- `packages/agent/CHANGELOG.md`
- `packages/ai/CHANGELOG.md`
- `packages/coding-agent/CHANGELOG.md`
- `packages/server/CHANGELOG.md`
- `packages/storage/sqlite-node/CHANGELOG.md`
- `packages/tui/CHANGELOG.md`

No already-released fork changelog sections were edited for release notes beyond merge preservation.

## QA

Passed:

- `npm run build`
- `npm run check`
- `npm test`
- `node packages/coding-agent/dist/cli.js --version` -> `2026.7.20-2`
- `node packages/coding-agent/dist/cli.js --help`
- `node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check` -> 9/9 passed
- `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test --evidence upstream-agent-mock-loop` -> 38/38 passed
- `node .agents/skills/senpi-qa/scripts/cli-smoke.mjs --self-test` -> 7/7 passed
- `node .agents/skills/senpi-qa/scripts/tui-smoke.mjs --self-test --driver tmux --evidence upstream-agent-tui` -> 5/5 passed

Evidence directories:

- `local-ignore/qa-evidence/20260721-mock-loop-text-leak-openai-completions-complete`
- `local-ignore/qa-evidence/20260721-mock-loop-text-leak-openai-completions-truncated`
- `local-ignore/qa-evidence/20260721-mock-loop-text-leak-anthropic-messages-complete`
- `local-ignore/qa-evidence/20260721-mock-loop-text-leak-anthropic-messages-truncated`
- `local-ignore/qa-evidence/20260721-upstream-agent-tui`
