# Upstream Merge Report

Generated: 2026-07-21T21:11:30Z

## Result

- Upstream release tag: `v0.81.1`
- Upstream release tag SHA: `20be4b18d4c57487f8993d2762bace129f0cf7c6`
- Merged upstream main SHA: `dd6bea41efa8caa7a10fe5a6401676dc5699f83f`
- Merge commit: `6fa674e5f`
- Changelog audit commit: `4d1b7cade`
- Upstream pin: `.github/upstream.json` now records `v0.81.1`, `dd6bea41efa8caa7a10fe5a6401676dc5699f83f`, and `2026-07-21T21:11:30Z`.

## Preserved Fork Commits

- Preserved current fork head before merge: `50a24a253fbc7aa4029d87601de8424c68b6e792`.
- Preserved `2044` fork-side commits not present on `upstream/main`.
- Recent preserved fork work includes app-server parity (`50a24a253`, `7dbb2fac`), look-at extension work (`40293d4c8`, `3ae1dd0d8`, `bdc78266d`), app-server replay fixes (`d9edfaab6`, `8c0ee26e0`), and Alibaba token plan provider integration (`ea09c41d`).

## Conflict Resolution Notes

- `package-lock.json`: took upstream during conflict resolution and regenerated with `npm install --package-lock-only --ignore-scripts`.
- `bun.lock`: absent after the merge; no regenerated Bun lock is present.
- `**/changes.md`: preserved fork notes and removed stray conflict-base marker lines during the changelog audit.
- Markdown/docs: accepted upstream documentation where the fork did not intentionally diverge, while preserving fork app-server and package-surface notes.
- `packages/coding-agent/src/core/extensions/builtin/**`: preserved fork-owned builtin behavior, including look-at, gpt-apply-patch, and related app-server/tooling notes.
- Known fork-modified runtime files were merged semantically, preserving fork app-server parity, compaction behavior, model/runtime settings, resource loading, interactive startup behavior, TUI behavior, and extension surfaces while adopting upstream stream/retry/model-catalog improvements.
- `packages/orchestrator` upstream rename was adopted as `packages/server`; fork package identity remains `@code-yeongyu/senpi-orchestrator`.
- Added focused merge fixes for Kimi K3 thinking metadata, RPC `get_available_thinking_levels`, summarization test stream mocks, legacy usage accounting, and footer totals.

## Changelog Audit

- Added Unreleased entries for `packages/ai`, `packages/agent`, `packages/coding-agent`, `packages/tui`, and `packages/web-ui`.
- Removed merge-artifact base marker lines from fork `changes.md` notes.
- Did not edit released changelog version sections.

## QA

- `npm run build`: passed.
- `npm run check`: passed with no warnings after rerun.
- `npm test`: passed after fixing legacy usage accounting.
- Built CLI smoke:
  - `node packages/coding-agent/dist/cli.js --version`: passed, printed `2026.7.20-2`.
  - `node packages/coding-agent/dist/cli.js --help`: passed.
- Focused checks run during repair:
  - `npm --prefix packages/ai run check:model-data`: passed.
  - `npm --prefix packages/ai test -- supports-xhigh.test.ts`: passed.
  - `npm --prefix packages/coding-agent test -- branch-summarization.test.ts compaction-summary-reasoning.test.ts footer-width.test.ts interactive-mode-startup-input.test.ts rpc.test.ts`: passed.
  - `npm --prefix packages/coding-agent test -- session-manager/fallback-model-restore.test.ts footer-width.test.ts`: passed.
- `senpi-qa` evidence:
  - `node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check`: passed 9/9; tee receipt in `local-ignore/qa-evidence/20260721-upstream-v0811/common-self-check.txt`.
  - `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test --evidence upstream-agent-mock-loop`: passed 38/38; evidence in `local-ignore/qa-evidence/20260721-upstream-agent-mock-loop` plus tee receipt in `local-ignore/qa-evidence/20260721-upstream-v0811/mock-loop-self-test.txt`.
  - `node .agents/skills/senpi-qa/scripts/cli-smoke.mjs --self-test`: passed 7/7; tee receipt in `local-ignore/qa-evidence/20260721-upstream-v0811/cli-smoke-self-test.txt`.
  - `node .agents/skills/senpi-qa/scripts/tui-smoke.mjs --self-test --driver tmux --evidence upstream-agent-tui`: passed 5/5; evidence in `local-ignore/qa-evidence/20260721-upstream-agent-tui` plus tee receipt in `local-ignore/qa-evidence/20260721-upstream-v0811/tui-smoke-self-test.txt`.

## Final State

- No pushes, pull requests, tags, rebases, force-pushes, release script runs, or history rewrites were performed.
- Branch is intended to be PR-ready after committing this report.
