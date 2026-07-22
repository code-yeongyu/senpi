# Upstream Merge Report

Generated: 2026-07-22T01:44:24Z

## Result

- Result: clean PR-ready upstream integration
- Upstream repository: `badlogic/pi-mono`
- Upstream release tag: `v0.81.1`
- Upstream release tag SHA: `20be4b18d4c57487f8993d2762bace129f0cf7c6`
- Merged upstream main SHA: `dd6bea41efa8caa7a10fe5a6401676dc5699f83f`
- Merge commit: `394c21245777e89386bc9a83e5896c1918545616`
- QA/fix HEAD before this report commit: `29147725c2f4b6ebea790e91d6fab4785006ce5c`
- Ancestry confirmed: `upstream/main` is an ancestor of final HEAD.

## Fork State Preserved

- Preserved fork base parent: `50a24a253fbc7aa4029d87601de8424c68b6e792`
- Preserved fork app-server parity, look-at, config-reload, MCP, terminal, compaction, smooth-streaming, todo, model-fallback, and TUI rendering changes documented in nearest `changes.md` files.
- Preserved fork-specific package-manager/build behavior and Senpi package identity while accepting upstream package additions and the `packages/orchestrator` to `packages/server` rename.

## Conflict Resolution

- Resolved the merge with the previously verified resolution tree for the same base/upstream pair (`1b694e3c5001c14174b250f2034f03b6ac17fa2c`), whose parents are `50a24a253fbc7aa4029d87601de8424c68b6e792` and `dd6bea41efa8caa7a10fe5a6401676dc5699f83f`.
- Removed upstream-restored workflow gates that the fork intentionally deleted: `.github/workflows/approve-contributor.yml`, `.github/workflows/issue-gate.yml`, and `.github/workflows/pr-gate.yml`.
- Accepted the upstream `packages/orchestrator` rename to `packages/server`, carrying fork AGENTS/changelog/test files to the new location.
- Kept fork behavior in known semantic conflict zones while adopting upstream runtime changes: `packages/agent/src/agent-loop.ts`, coding-agent session/compaction/runtime surfaces, interactive mode, and TUI editor/rendering files.
- Regenerated root `package-lock.json` with `npm install --package-lock-only --ignore-scripts`; it produced no diff.
- Removed stray conflict-base marker lines from fork notes during the changelog audit.

## Commits Added

- `394c212457` - `Merge upstream/main v0.81.1`
- `7c3e20ee5` - `sync: record upstream pin dd6bea4`
- `cbcc2137f` - `docs(changelog): audit upstream dd6bea4`
- `2b2d97fd9` - `fix: restore upstream merge QA gates`
- `29147725c` - `fix(coding-agent): cover merged runtime protocols`

## Changelog Audit

Added `## [Unreleased]` entries for:

- `packages/agent/CHANGELOG.md`: SQLite-backed session storage contract, `uuidv7` move, harness retry/usage additions, `streamFn` compatibility fix.
- `packages/ai/CHANGELOG.md`: Qwen Token Plan providers, retry helper, shared text/UUID/usage utilities, model-data validation split, provider and Responses fixes.
- `packages/coding-agent/CHANGELOG.md`: source archives, Qwen setup/docs, thinking-level RPC, root exports, usage accounting, retry lifecycle, startup catalog fixes, and cross-package user-facing fixes.
- `packages/tui/CHANGELOG.md`: cursor shutdown, ANSI wrapping, and paste-marker fixes.
- `packages/server/CHANGELOG.md`: orchestrator workspace rename to `packages/server`.
- `packages/storage/sqlite-node/CHANGELOG.md`: Node SQLite storage backend.

No `packages/web-ui/CHANGELOG.md` entry was needed for this upstream audit.

## QA Results

- `npm install --package-lock-only --ignore-scripts`: passed, no diff.
- `npm run build`: passed.
- `npm run check`: passed, no warnings, no formatter diff.
- `npm test`: passed.
  - scripts: 48 passed.
  - `packages/agent`: 248 passed.
  - `packages/ai`: 1202 passed, 799 skipped.
  - `packages/coding-agent`: 4436 passed, 32 skipped.
  - `packages/pty`: 41 passed, 3 skipped.
  - `packages/senpi-codemode`: 365 passed, 1 skipped.
  - `packages/server`: 3 passed.
  - `packages/tui`: passed.
- Built CLI smoke:
  - `node packages/coding-agent/dist/cli.js --version`: passed, printed `2026.7.20-2`.
  - `node packages/coding-agent/dist/cli.js --help`: passed.
- `senpi-qa`:
  - `node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check`: passed 9/9.
  - `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test --evidence upstream-agent-mock-loop`: passed 38/38.
  - `node .agents/skills/senpi-qa/scripts/cli-smoke.mjs --self-test`: passed 7/7.
  - `node .agents/skills/senpi-qa/scripts/tui-smoke.mjs --self-test --driver tmux --evidence upstream-agent-tui`: passed 5/5.

Evidence paths:

- `local-ignore/qa-evidence/20260722-mock-loop-text-leak-openai-completions-complete/receipt.json`
- `local-ignore/qa-evidence/20260722-mock-loop-text-leak-openai-completions-truncated/receipt.json`
- `local-ignore/qa-evidence/20260722-mock-loop-text-leak-anthropic-messages-complete/receipt.json`
- `local-ignore/qa-evidence/20260722-mock-loop-text-leak-anthropic-messages-truncated/receipt.json`
- `local-ignore/qa-evidence/20260722-upstream-agent-tui/tui-smoke-tmux.txt`
