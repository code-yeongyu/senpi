# Upstream Merge Report

## Upstream

- Repository: `badlogic/pi-mono`
- Release tag: `v0.79.9`
- Merged upstream commit: `bc0db643502ba0bf1b227a97d9d5885cefc2b909`
- Local merge commit: `8fe37ddbf sync: merge upstream v0.79.9`
- Upstream pin: `.github/upstream.json` records tag `v0.79.9`, sha `bc0db643502ba0bf1b227a97d9d5885cefc2b909`, synced at `2026-06-21T13:08:46Z`

## Preserved Fork Behavior

- Kept senpi package identity, CLI branding, config directory, and package update behavior for `@code-yeongyu/senpi`.
- Preserved fork model-registry behavior from `packages/coding-agent/src/core/changes.md`, including configured model metadata, provider filters, prompt presets, service tiers, and favorite-model filtering.
- Preserved the unified compaction pipeline and restored `CompactionResult.estimatedTokensAfter` after context rebuild.
- Preserved generated global default extension shim handling and fork-only builtin extension resource-loader behavior.
- Preserved TUI working-status behavior while adopting upstream theme-controller shutdown changes.
- Preserved fork-only Bedrock Opus 4.7 `-v1` generated catalog entries and Xiaomi MiMo disabled-thinking compat metadata that are already produced by the fork generator.

## Conflicts Resolved

- `package-lock.json`: took upstream direction, regenerated with `npm install --package-lock-only --ignore-scripts --offline`, and retained required optional platform metadata.
- `packages/coding-agent/npm-shrinkwrap.json`: regenerated with `node scripts/generate-coding-agent-shrinkwrap.mjs`.
- Fork-modified runtime files were resolved semantically after reading `changes.md` notes:
  - `packages/agent/src/agent-loop.ts`
  - `packages/coding-agent/src/core/agent-session.ts`
  - `packages/coding-agent/src/core/model-registry.ts`
  - `packages/coding-agent/src/core/settings-manager.ts`
  - `packages/coding-agent/src/core/resource-loader.ts`
  - `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
  - `packages/tui/src/tui.ts`
- Retargeted new upstream subagent extension examples to `@code-yeongyu/senpi`.
- Restored low-level AI tests to explicitly register built-in providers after the new base entrypoint split.
- Kept `--list-models` as a full catalog listing so offline CLI smoke remains credential-free.

## Changelog Audit

- Followed `.github/agent/commands/cl.md`.
- Added `packages/coding-agent/CHANGELOG.md` `[Unreleased]` entry:
  - `Fixed the update notice to include a changelog URL when one is available.`
- Changelog commit: `fb47c4c12 docs(changelog): audit upstream bc0db6435`

## QA

Required gates from repository root:

- `npm run build` passed.
- `npm run check` passed with no formatter changes.
- `npm test` passed:
  - `@earendil-works/pi-agent-core`: 16 files, 174 tests passed.
  - `@earendil-works/pi-ai`: 82 files passed, 25 skipped; 595 tests passed, 726 skipped.
  - `@code-yeongyu/senpi`: 253 files passed, 5 skipped; 2597 tests passed, 45 skipped.
  - `@earendil-works/pi-tui`: 741 tests passed.

Built CLI smoke:

- `node packages/coding-agent/dist/cli.js --version` passed: `2026.6.17-2`.
- `node packages/coding-agent/dist/cli.js --help` passed.

Senpi QA evidence:

- `node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check` passed.
- `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test --evidence upstream-agent-mock-loop` passed.
- `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --run "upstream merge smoke" --evidence upstream-agent-mock-loop` passed and wrote request/stdout artifacts.
- `node .agents/skills/senpi-qa/scripts/cli-smoke.mjs --self-test` passed.
- `node .agents/skills/senpi-qa/scripts/tui-smoke.mjs --self-test --driver tmux --evidence upstream-agent-tui` passed.

Evidence files:

- `local-ignore/qa-evidence/20260621-upstream-agent/common-self-check.txt`
- `local-ignore/qa-evidence/20260621-upstream-agent/cli-smoke-self-test.txt`
- `local-ignore/qa-evidence/20260621-upstream-agent/mock-loop-self-test.txt`
- `local-ignore/qa-evidence/20260621-upstream-agent/mock-loop-run.txt`
- `local-ignore/qa-evidence/20260621-upstream-agent-mock-loop/mock-loop-openai-completions-stdout.txt`
- `local-ignore/qa-evidence/20260621-upstream-agent-mock-loop/mock-loop-openai-completions-requests.json`
- `local-ignore/qa-evidence/20260621-upstream-agent/tui-smoke-self-test.txt`
- `local-ignore/qa-evidence/20260621-upstream-agent-tui/tui-smoke-tmux.txt`
