# Upstream Merge Report

## Upstream

- Upstream repo: `badlogic/pi-mono`
- Latest upstream release tag: `v0.80.10`
- Release tag SHA: `8dc78834cde4e329284cf505f9e3f99763df5529`
- Merged `upstream/main` SHA: `216e672e7c9fc65682553394b74e483c0c9e47f7`
- Previous fork HEAD: `3abc5cffc8de715c66649f121adbc0d363106bf6`
- Merge commit: `8230be00de8035504a86f9831e5e18709211c5e5`
- Pin commit: `8ba58577f606e49f794123dd0e585f045f0ea7f6`
- Changelog audit commit: `771630a89623c5b7272c905507422146b37d3aa1`

## Preserved Fork Work

- Preserved the fork branch history with a `git merge --no-ff` merge; no rebase, force-push, tag creation, PR creation, or release script was run.
- Preserved fork package identities, CalVer package versions, Senpi branding, config directories, Node 24+ engine policy, bundled workspace layout, and generated install/publish lock conventions.
- Preserved fork changelog history and existing released sections; upstream release-only version headers were not copied into fork released sections.
- Preserved 1,641 fork-side commits already ahead of `upstream/main` before the merge, with previous fork HEAD `3abc5cffc8de715c66649f121adbc0d363106bf6` as the merge commit's first parent.

## Conflicts Resolved

- `package-lock.json`: took the upstream conflict side, then regenerated with `npm install --package-lock-only --ignore-scripts`; final diff contains the upstream example-extension version refresh and remains consistent with fork metadata.
- `packages/coding-agent/install-lock/package-lock.json` and `packages/coding-agent/publish-deps.lock.json`: regenerated through `node scripts/generate-coding-agent-install-lock.mjs` and `node scripts/generate-coding-agent-shrinkwrap.mjs` after preserving fork package names and versions.
- Package manifests under `packages/{ai,agent,coding-agent,orchestrator,tui}`: preserved fork names, versions, dependency graph, build scripts, and engine policy instead of upstream release-version metadata.
- Changelogs under `packages/{ai,agent,coding-agent,orchestrator,tui}`: preserved fork changelog sections during merge and audited missing `[Unreleased]` notes afterward.
- `packages/ai/src/providers/openrouter.models.ts`: accepted upstream v0.80.10 pricing metadata for OpenRouter.
- `packages/ai/src/providers/opencode-go.models.ts`: accepted upstream v0.80.10 OpenCode Go catalog additions for Grok 4.5 and Kimi K3.

## Changelog Audit

- Added `packages/ai/CHANGELOG.md` `[Unreleased]` fixed entry for inherited OpenCode Go catalog additions and OpenRouter pricing refresh from upstream v0.80.10.
- Duplicated the same user-facing catalog/pricing entry in `packages/coding-agent/CHANGELOG.md`.
- Skipped release housekeeping, upstream-sync merge commits, pin updates, and already-released upstream changelog section moves per `.github/agent/commands/cl.md`.

## QA

- `npm run build` passed.
- `npm run check` passed, including Biome, pinned deps, TS imports, shrinkwrap/install-lock checks, TypeScript, browser smoke, web UI check, and `check:neo` Go build/vet/test.
- `npm test` passed across the workspace. Notable summaries: scripts 48/48, agent 190/190, AI 890 passed with live-gated skips, coding-agent 3,615 passed, orchestrator 3/3, pty 39 passed, codemode 356/356, and TUI completed successfully.
- Built CLI smoke passed:
  - `node packages/coding-agent/dist/cli.js --version` -> `2026.7.16-2`
  - `node packages/coding-agent/dist/cli.js --help` rendered usage successfully.
- Senpi QA passed:
  - `common.mjs --self-check`: 9/9
  - `mock-loop.mjs --self-test --evidence upstream-agent-mock-loop`: 5/5
  - `cli-smoke.mjs --self-test`: 7/7
  - `tui-smoke.mjs --self-test --driver tmux --evidence upstream-agent-tui`: 5/5
- Every Senpi QA channel verified the real `~/.senpi/agent/auth.json` remained unchanged.
- Evidence logs:
  - `local-ignore/qa-evidence/20260716-upstream-v08010/`
  - `local-ignore/qa-evidence/20260716-upstream-agent-tui/`

## Result

The branch is PR-ready locally with committed merge, upstream pin, changelog audit, and this report.

MERGE_RESULT: CLEAN_PR_READY
