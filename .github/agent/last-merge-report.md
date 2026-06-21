# Upstream Merge Report

## Summary

- Result: clean PR-ready merge
- Upstream repo: `badlogic/pi-mono`
- Upstream release tag: `v0.79.9`
- Merged upstream main: `bc0db643502ba0bf1b227a97d9d5885cefc2b909`
- Merge commit: `6fdaed01d`
- Upstream pin: `.github/upstream.json` records tag `v0.79.9`, sha `bc0db643502ba0bf1b227a97d9d5885cefc2b909`, and sync time `2026-06-21T13:50:02Z`

## Preserved Fork Commits

The merge preserved the current fork branch history from `main`, including the upstream automation fixes already present before this run:

- `c9881ae39` `ci(upstream): scope offline QA mode`
- `0fde54bdd` `ci(upstream): require agent check parity`
- `356319841` `ci(upstream): pin gh commands to actions repo`
- `731e9d91a` `ci(upstream): keep merge report cleanup clean`
- Fork runtime and QA infrastructure commits from the `2026.6.17-2` release line remain in the first-parent history.

## Conflicts Resolved

- Used a history-preserving `git merge --no-ff upstream/main`.
- Resolved conflicts using the previous same-parent resolved merge tree as reference, preserving fork changes documented in nearby `changes.md` files while taking upstream docs/manifests where required.
- `package-lock.json` was refreshed with `npm install --package-lock-only --ignore-scripts`.
- No `bun.lock` was present.
- Fork notes under `changes.md` were preserved.
- Fork-specific runtime behavior preserved included:
  - agent abort/compaction/session lifecycle handling
  - coding-agent resource-loader duplicate-extension policy
  - interactive-mode working/status/favorite-model/startup behavior
  - TUI differential rendering behavior
  - fork package naming and bundled workspace dependency behavior

## Changelog Audit

Added one missing `## [Unreleased]` changelog entry:

- `packages/coding-agent/CHANGELOG.md`: `Fixed the update notice to include a changelog URL when one is available.`

Committed as `d6390ad63 docs(changelog): audit upstream bc0db6435`.

## Focused Fix Commits

- `359944056 fix(coding-agent): resolve upstream merge build issues`
- `23db16e11 fix: resolve upstream merge typecheck`
- `eed8fc82f fix: restore upstream merge test expectations`
- `74f722e91 fix(coding-agent): list full catalog in model command`

## QA

Repository gates:

- `npm run build`: passed
- `npm run check`: passed
- `npm test`: passed
- `node packages/coding-agent/dist/cli.js --version`: passed, printed `2026.6.17-2`
- `node packages/coding-agent/dist/cli.js --help`: passed

senpi QA evidence:

- `local-ignore/qa-evidence/20260621-upstream-self-checks/common-self-check.txt`
- `local-ignore/qa-evidence/20260621-upstream-self-checks/mock-loop-self-test.txt`
- `local-ignore/qa-evidence/20260621-upstream-self-checks/cli-smoke-self-test.txt`
- `local-ignore/qa-evidence/20260621-upstream-self-checks/tui-smoke-self-test.txt`
- `local-ignore/qa-evidence/20260621-upstream-agent-tui/tui-smoke-tmux.txt`

senpi QA results:

- `common.mjs --self-check`: 9/9 passed
- `mock-loop.mjs --self-test --evidence upstream-agent-mock-loop`: 5/5 passed
- `cli-smoke.mjs --self-test`: 5/5 passed
- `tui-smoke.mjs --self-test --driver tmux --evidence upstream-agent-tui`: 5/5 passed

Notes:

- `npm install --package-lock-only --ignore-scripts` reported one high-severity audit finding but did not modify beyond the lockfile refresh.
- Negative-path tests intentionally emitted npm 404 and git auth failure messages for nonexistent packages/repos; the full `npm test` run passed.
