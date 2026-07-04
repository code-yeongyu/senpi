# Upstream Merge Report

## Upstream

- Upstream repository: `badlogic/pi-mono`
- Requested release tag: `v0.80.3`
- Release tag SHA: `a23abe4a695df8b69b613f73e9fdda2a8af894d4`
- Merged upstream/main SHA: `ee24a9ec54a9602d55dc7ac767c270cec806c291`
- Upstream pin updated in `.github/upstream.json` with `synced_at: 2026-07-04T09:14:50Z`

## Preserved Fork Commits

The bot branch was merged with `upstream/main` using a history-preserving merge commit and no rebase or force-push. Recent fork commits already present on `main` were preserved, including:

- `b548566b1` docs(upstream): document detector head output
- `b00def123` feat(coding-agent): hide external stdout while a TUI owns the terminal
- `86aabe2f` fix(tui): sanitize control characters in terminal titles
- `0413d21c` feat(tui): guard against external stdout writes while terminal active
- `5c816dcd` fix(tui): reset render scheduling state across stop/start
- `126abb34` feat(coding-agent): show live hook identity in tool hook status rows
- `66300736` fix(coding-agent): sanitize live tool hook status updates
- `eba52925` fix(coding-agent): hide stderr while tui owns terminal

## Conflicts Resolved

- `.github/APPROVED_CONTRIBUTORS`: accepted upstream metadata for the modified/deleted conflict.
- `packages/ai/CHANGELOG.md`: restored the fork side during merge resolution to avoid modifying released CalVer sections, then added missing upstream entries under `[Unreleased]` in the changelog audit commit.
- `packages/ai/src/providers/nvidia.models.ts`: accepted upstream generated catalog addition for `z-ai/glm-5.2`.
- `packages/ai/src/providers/openrouter.models.ts`: accepted upstream generated catalog pricing and max-token refreshes.
- No package lockfile or `bun.lock` conflicts occurred.

## Changelog Audit

Added missing `[Unreleased]` entries in:

- `packages/ai/CHANGELOG.md`
  - Refreshed generated model catalogs from models.dev.
  - Fixed OAuth device-code `slow_down` interval handling.
  - Fixed OpenAI Codex WebSocket session age rotation.
  - Fixed Cloudflare 524 retry classification.
- `packages/coding-agent/CHANGELOG.md`
  - Added inherited generated model catalog refreshes.
  - Fixed startup model resolution awaiting model availability.
  - Fixed pnpm self-update prune hint documentation.
  - Fixed edit tool schema extra replacement fields.
  - Duplicated inherited AI fixes for OAuth `slow_down`, Codex WebSocket rotation, and Cloudflare 524 retries.
  - Removed Vercel AI Gateway attribution headers.

The merge had placed two upstream coding-agent entries in the released `2026.7.2` section; the audit moved those entries to `[Unreleased]`.

## Focused Fix

- `a78fa94bb` fixed the fork branding expectation in `packages/coding-agent/test/package-command-paths.test.ts`, changing the upstream hard-coded `pi update --self` assertion to use `APP_NAME`.

## QA Results

- `npm run build`: passed.
- `npm run check`: passed before full tests; passed again after the focused test fix, with no formatter changes.
- `npx tsx ../../node_modules/vitest/dist/cli.js --run test/package-command-paths.test.ts` from `packages/coding-agent`: passed after the focused fix.
- `npm test`: first run found the stale `pi update --self` test assertion; rerun after the focused fix passed.
- `node packages/coding-agent/dist/cli.js --version`: passed, printed `2026.7.3`.
- `node packages/coding-agent/dist/cli.js --help`: passed.

## senpi-qa Evidence

- `local-ignore/qa-evidence/20260704-upstream-v0803/common-self-check.txt`: `common.mjs --self-check` passed 9/9 and confirmed real auth unchanged.
- `local-ignore/qa-evidence/20260704-upstream-v0803/mock-loop-self-test.txt`: `mock-loop.mjs --self-test --evidence upstream-agent-mock-loop` passed 5/5 for OpenAI Completions, Anthropic Messages, and OpenAI Responses against localhost-only fake providers.
- `local-ignore/qa-evidence/20260704-upstream-v0803/cli-smoke-self-test.txt`: `cli-smoke.mjs --self-test` passed 5/5.
- `local-ignore/qa-evidence/20260704-upstream-v0803/tui-smoke-self-test.txt`: `tui-smoke.mjs --self-test --driver tmux --evidence upstream-agent-tui` passed 5/5.
- `local-ignore/qa-evidence/20260704-upstream-agent-tui/tui-smoke-tmux.txt`: tmux TUI smoke artifact written by the harness.

## Result

The branch is PR-ready locally with merge, pin, changelog audit, focused test fix, and merge report commits. No push, PR creation, tag creation, release command, rebase, force-push, or history rewrite was performed.
