# Upstream Merge Report

- Result: clean PR-ready branch
- Upstream repo: badlogic/pi-mono
- Upstream tag: v0.80.3
- Upstream main SHA: dd87c02cbf2681c9301cf809146651483ff16030
- Merge commit: 9aadf8f4e
- Pin commit: 50561489e
- Changelog audit commit: 2097a6da5
- Focused fix commits: bcdff49b9, 6a9c03d07

## Preserved Fork Behavior

- Preserved the fork package identity and CalVer package metadata for `@code-yeongyu/senpi`, `@code-yeongyu/senpi-install`, and `@code-yeongyu/senpi-orchestrator`.
- Preserved fork-only contribution gate removals by keeping `.github/APPROVED_CONTRIBUTORS`, `.github/workflows/issue-gate.yml`, and `.github/workflows/pr-gate.yml` deleted.
- Preserved fork dynamic system prompt construction in `packages/coding-agent/src/core/agent-session.ts` while adopting upstream next-turn context refresh.
- Preserved fork TUI working-status behavior: two-frame/bullet working indicator, elapsed working text, active tool working labels, hook status rows, compaction progress text, and abort queue handling.
- Preserved fork pre-prompt compaction barrier behavior while adopting upstream's no-continue regression coverage.

## Conflicts Resolved

- `package-lock.json`: restored fork-compatible workspace identities, then regenerated with `npm install --package-lock-only --ignore-scripts`.
- `packages/coding-agent/install-lock/package-lock.json` and `packages/coding-agent/npm-shrinkwrap.json`: regenerated from fork package metadata with repository generator scripts.
- Package metadata conflicts: kept fork names, private flags, CalVer versions, bundled workspace dependencies, and install package identity.
- Changelog conflicts: kept fork CalVer changelog history during merge; added upstream-facing entries under `## [Unreleased]` in the audit commit.
- `packages/ai/src/api/openai-completions.ts`: merged upstream provider error-body formatting with the fork's typed OpenRouter raw metadata helper.
- `packages/ai/src/providers/openrouter.models.ts`: accepted upstream generated model metadata/pricing updates.
- `packages/coding-agent/src/core/agent-session.ts`: adopted `prepareNextTurnWithContext` refresh, preserved dynamic prompt options and system-prompt override handling, and fixed pre-prompt overflow compaction reason reporting.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: adopted upstream status indicators while preserving fork working/status behavior and test-harness compatibility.

## Changelog Audit

- `packages/agent/CHANGELOG.md`: added `prepareNextTurnWithContext` and `prepareNextTurn` abort-signal fix entries.
- `packages/ai/CHANGELOG.md`: added Claude Sonnet 5 metadata, Codex SSE timeout, Xiaomi pricing, provider error-body, and Z.AI thinking replay entries.
- `packages/coding-agent/CHANGELOG.md`: added inherited model/provider entries plus RPC tree access, session-name extension events, output padding, pre-prompt compaction, extension tool refresh, undici client-error, and status-indicator fixes.

## QA

- `npm run build`: passed.
- `npm run check`: passed with no formatter changes.
- Targeted regression rerun: `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-session-concurrent.test.ts test/assistant-message.test.ts test/interactive-mode-compaction.test.ts test/interactive-mode-status.test.ts test/suite/regressions/pre-prompt-compaction-no-continue.test.ts` passed.
- `npm test`: passed.
- Built CLI smoke: `node packages/coding-agent/dist/cli.js --version` and `node packages/coding-agent/dist/cli.js --help` passed.
- senpi QA common self-check: `node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check` passed.
- senpi QA CLI smoke: `node .agents/skills/senpi-qa/scripts/cli-smoke.mjs --self-test` passed.
- senpi QA mock loop self-test: `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test --evidence upstream-agent-mock-loop` passed.
- senpi QA mock loop evidence run: `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --run "Reply with mock evidence." --evidence upstream-agent-mock-loop` passed; evidence at `local-ignore/qa-evidence/20260630-upstream-agent-mock-loop/`.
- senpi QA TUI smoke: `node .agents/skills/senpi-qa/scripts/tui-smoke.mjs --self-test --driver tmux --evidence upstream-agent-tui` passed; evidence at `local-ignore/qa-evidence/20260630-upstream-agent-tui/tui-smoke-tmux.txt`.

## Secret Safety

- QA used isolated senpi sandboxes and verified `/home/runner/.senpi/agent/auth.json` was unchanged.
- Evidence paths are under gitignored `local-ignore/qa-evidence/`.
- No raw credentials, tokens, auth headers, cookies, or private secrets were added to tracked files.
