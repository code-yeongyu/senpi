# Upstream Merge Report

## Upstream

- Repository: `badlogic/pi-mono`
- Release tag: `v0.80.6`
- Upstream main SHA: `34582ef34beec868b0df4fb969385b8af5960c45`
- Upstream pin: `.github/upstream.json`
- Pin synced at: `2026-07-09T23:39:02Z`

## Branch State

- Branch: `automation/upstream-v0.80.6-29057623306`
- Merge commit: `34ec26bbee8b6d16f9e3666b23c444edbb52baf4` (`sync: merge upstream v0.80.6`)
- Changelog audit commit: `1d4fa3d721bce390d38f9ba0abc21a52cf883355` (`docs(changelog): audit upstream 34582ef`)
- Follow-up fix commits:
  - `3c1640ee0` (`fix(ai): preserve narrowed thinking signature`)
  - `cf38c3c64` (`fix(ai): preserve max reasoning mappings`)
  - `5eb04fe88` (`fix(ai): gate standalone signed thinking replay`)

Fork-specific history and package identity were preserved on the bot branch. The merge kept the fork's CalVer package versions, `@code-yeongyu/senpi` package identity, Node 24 environment assumptions, bundled workspace install flow, and fork changelog release history.

## Conflict Resolution

- `package-lock.json`: upstream lockfile did not match fork package identity, so the fork-side lockfile was retained and regenerated with `npm install --package-lock-only --ignore-scripts`.
- `packages/coding-agent/npm-shrinkwrap.json` and install-lock files: regenerated after lockfile reconciliation.
- Changelogs: preserved released fork CalVer sections and added upstream `v0.80.6` items under current `[Unreleased]` sections only.
- Documentation: kept fork `senpi` naming where intentionally divergent and accepted upstream `max` thinking documentation.
- Release scripts: preserved fork CalVer release flow and incorporated the upstream full-test gate. `scripts/local-release.mjs` keeps `--skip-test` support for local release validation.
- Runtime source conflicts: semantically merged fork behavior with upstream reasoning/thinking updates in `packages/ai` and `packages/coding-agent`; follow-up fixes preserve fork-compatible reasoning replay behavior while adopting upstream `max` thinking support.

No unresolved conflicts remain.

## Changelog Audit

Added `[Unreleased]` entries to:

- `packages/ai/CHANGELOG.md`
- `packages/agent/CHANGELOG.md`
- `packages/tui/CHANGELOG.md`
- `packages/coding-agent/CHANGELOG.md`

## QA

Required gates run from the repository root unless noted:

- `npm run build`: passed.
- `npm run check`: passed with no warnings and no formatter rewrites.
- Focused AI regression run from `packages/ai`: passed, 7 files / 107 tests, 2 skipped.
- Focused Julia kernel rerun from `packages/senpi-codemode`: passed, 1 file / 3 tests.
- `npm test`: passed after the AI replay fix; AI, coding-agent, senpi-codemode, TUI, and other workspace suites completed green.
- Built CLI smoke:
  - `node packages/coding-agent/dist/cli.js --version`: passed, printed `2026.7.9-2`.
  - `node packages/coding-agent/dist/cli.js --help`: passed, printed usage.

`senpi-qa` evidence:

- `local-ignore/qa-evidence/20260710-upstream-v0.80.6/common-self-check.txt`: `common.mjs --self-check` passed 9/9, auth unchanged.
- `local-ignore/qa-evidence/20260710-upstream-v0.80.6/mock-loop-self-test.txt`: `mock-loop.mjs --self-test --evidence upstream-agent-mock-loop` passed 5/5, all requests stayed on localhost fake providers, auth unchanged.
- `local-ignore/qa-evidence/20260710-upstream-v0.80.6/cli-smoke-self-test.txt`: `cli-smoke.mjs --self-test` passed 7/7, auth unchanged.
- `local-ignore/qa-evidence/20260710-upstream-v0.80.6/tui-smoke-self-test.txt`: `tui-smoke.mjs --self-test --driver tmux --evidence upstream-agent-tui` passed 5/5, auth unchanged.
- `local-ignore/qa-evidence/20260710-upstream-agent-tui/tui-smoke-tmux.txt`: TUI smoke artifact written by the harness.

## Result

The bot branch is PR-ready. No push, PR creation, tag creation, release command, rebase, force-push, or history rewrite was performed.
