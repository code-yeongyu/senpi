# Ctrl+P context-window skip QA

## What was tested

- On `mengmotaMac` through bunshin, transferred this worktree to an isolated
  `/tmp/ctrl-p-context-skip-*` directory.
- Ran `bun install --frozen-lockfile`.
- Ran `bun scripts/build-all.mjs`.
- Ran
  `bunx vitest run packages/coding-agent/test/suite/agent-session-model-extension.test.ts`.

## What was observed

- Build exited 0.
- The focused suite passed: 1 test file, 20 tests.
- The regression covers both an exhausted favorite being skipped before the next
  usable favorite and all alternative favorites being rejected with a structured
  result.
- The isolated remote tree was removed after the run with exit 0.

## Why this is enough

- The test exercises `AgentSession.cycleModel()` with the real faux-provider
  harness and observes the emitted `model_change_skipped` events and selected
  model.
- The build proves the new event is accepted by the coding-agent and transport
  TypeScript surfaces.

## Omitted

- No credentials, environment dumps, provider requests, or raw remote logs are
  included.
