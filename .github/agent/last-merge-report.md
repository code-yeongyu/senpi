# Upstream Merge Report

## Upstream

- Upstream repo: `badlogic/pi-mono`
- Release tag: `v0.80.7`
- Release tag SHA: `818d67457cdd6b60bce6b121d16b23141c252dd8`
- Merged upstream/main SHA: `9d09075c53812f7af955ce4397d0508c4a62efac`
- Merge commit: `cea3d3a2c`
- Pin commit: `ca6ef930c`
- Changelog audit commit: `00fbe85ac`

## Preserved Fork Work

- Kept fork package identity, CalVer versions, bundled dependency wiring, `senpi` binary metadata, Node 24 engine policy, and fork release metadata.
- Preserved fork compaction/session behavior in `packages/coding-agent/src/core/agent-session.ts`, including the `_executeCompaction` flow, session-work barrier behavior, and `extraBody` auth propagation.
- Preserved fork model-registry behavior for provider disabling, whitelists/blacklists, cache retention, `extraBody`, tool-call formats, and custom provider handling while adding upstream Radius OAuth and session-affinity schema support.
- Kept fork changelog history and added new upstream release notes only under current `[Unreleased]` sections.

## Conflicts Resolved

- `package-lock.json`: attempted the instructed upstream seed, but npm could not regenerate from the upstream lock because it referenced the upstream workspace identity/path. Restored the fork-consistent lockfile seed and regenerated with `npm install --package-lock-only --ignore-scripts`.
- `packages/coding-agent/install-lock/package-lock.json` and `packages/coding-agent/publish-deps.lock.json`: regenerated with `node scripts/generate-coding-agent-install-lock.mjs` and `node scripts/generate-coding-agent-shrinkwrap.mjs`.
- Package manifests: kept fork names/versions/private flags/bundled dependencies and retained existing direct dependency surface.
- Changelogs: preserved fork release sections; added audit entries under `[Unreleased]` in `packages/ai/CHANGELOG.md` and `packages/coding-agent/CHANGELOG.md`.
- `packages/ai/src/api/bedrock-converse-stream.ts`: kept fork tool schema serialization and upstream stop-reason error propagation.
- `packages/ai/src/compat.ts`: kept fork faux-provider/tool-call middleware support and added upstream `BuiltinProvider` export plus `pi-messages`.
- `packages/ai/src/providers/opencode.models.ts`: accepted upstream `openai-nosession` session-affinity compat for OpenCode models.
- `packages/ai/src/providers/openrouter.models.ts`: accepted upstream OpenRouter pricing update for the conflicted model row.
- `packages/ai/test/openai-responses-compat.test.ts`: kept both fork reasoning-replay coverage and upstream required tool-choice coverage.
- `packages/coding-agent/src/core/agent-session.ts`: preserved fork compaction/session abstractions and restored upstream ambient-auth branch-summary behavior.
- `packages/coding-agent/src/core/model-registry.ts`: merged upstream Radius/session-affinity config with fork provider filters and custom compat options.

## Focused Fixes

- `8479cc3f8 fix(ai): align responses websocket affinity`
  - Updated OpenAI Responses WebSocket session-affinity headers to use `sessionAffinityFormat` after upstream removed `sendSessionIdHeader`.
- `8ba9273f1 fix(coding-agent): preserve branch summary ambient auth`
  - Switched branch-summary generation to the compaction auth path so ambient auth without a literal API key works.

## Changelog Audit

- Added `packages/ai` `[Unreleased]` entries for Radius gateway support, OpenAI/Codex forced tool calls, OpenCode session-id opt-out, Anthropic empty usage handling, OpenAI/Azure encrypted reasoning replay, Bedrock stop-reason errors, OpenRouter session affinity, and GitHub Copilot MAI-Code routing.
- Added `packages/coding-agent` `[Unreleased]` entries for Radius custom provider support, inherited OpenAI/Codex forced tool calls, system-prompt date removal, OpenCode session-id opt-out, login copy clarification, npm uninstall `--legacy-peer-deps`, branch-summary ambient auth, and inherited AI fixes.

## QA

- `npm run build` passed after focused fixes.
- `npm run check` passed after focused fixes.
- `npm test` passed after focused fixes.
- Built CLI smoke:
  - `node packages/coding-agent/dist/cli.js --version` -> `2026.7.14-2`
  - `node packages/coding-agent/dist/cli.js --help` passed.
- Senpi QA:
  - `node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check` passed.
  - `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test --evidence upstream-agent-mock-loop` passed.
  - `node .agents/skills/senpi-qa/scripts/cli-smoke.mjs --self-test` passed.
  - `node .agents/skills/senpi-qa/scripts/tui-smoke.mjs --self-test --driver tmux --evidence upstream-agent-tui` passed.
- Evidence:
  - `local-ignore/qa-evidence/20260714-upstream-agent/`
  - `local-ignore/qa-evidence/20260714-upstream-agent-tui/`

## Result

The bot branch is PR-ready locally. No push, pull request, tag, or release was created.
