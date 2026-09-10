# src/harness

Optional harness libraries and an `AgentHarness` scaffold over the core loop, exported through `src/index.ts`; only the Node execution adapter requires `src/node.ts`.

Earned its own file: 42 TypeScript files, distinct durable-runtime domain (score 9: file count, code ratio, symbol/export density; cross-workspace centrality not credited).

## WHERE TO LOOK

| Task | File |
|---|---|
| Public scaffold, configuration, explicit unsupported operations | `agent-harness.ts` (`AgentHarness`, `AgentLane`, `HarnessNotImplemented`) |
| Record-log validation, lane state reduction | `reducer.ts` (`validateRecordLog`, `reduceLaneState`, `RecordLogCorruption`) |
| Telemetry span schemas | `telemetry.ts` (`AI_TELEMETRY_SCHEMA`, `HARNESS_TELEMETRY_SCHEMA`, `startAiSpan`/`startHarnessSpan`) |
| Node process/filesystem environment | `env/nodejs.ts` (`NodeExecutionEnv`, Windows process-tree teardown) |
| Compaction and branch summaries | `compaction/` (`compaction.ts`, `branch-summarization.ts`) |
| Session persistence | `session/` (own AGENTS.md) |
| Built-in tools | `tools/` (own AGENTS.md) |
| Skills, prompt templates, system prompt | `skills.ts`, `prompt-templates.ts`, `system-prompt.ts` |
| Result/error vocabulary | `result.ts`, `types.ts` (`Result`, `TaggedError`, `matchError`) |
| Output truncation, shell capture | `utils/truncate.ts`, `utils/shell-output.ts` |
| Internal event subscriptions and snapshot buffering | `events.ts` (`HarnessEventBus`); not yet wired into the public scaffold |

## CONVENTIONS

- `packages/agent/docs/harness.md` is the intended implementation spec, ahead of the current scaffold. Preserve its durable-contract decisions, but do not describe planned execution/recovery as shipped behavior.
- `AgentHarness.create()` accepts sessions without lane records; recorded sessions reject with `HarnessNotImplemented("create.restore")`. Prompt, compaction, navigation, queues, recovery, watches, hooks, and events remain explicit unsupported operations; see `test/harness/agent-harness-scaffold.test.ts`.
- Configuration accessors and session reads work. `setThinkingLevel()` persists `configuration_update` for `gpt-6-astra` on `openai`/`openai-codex`; the durable writer regression lives in `test/harness/configuration-update-writer.test.ts`.
- Result-returning APIs use tagged errors; scaffold operations reject with `HarnessNotImplemented`/`HarnessClosed`, storage rejects with `SessionError`, and tool execution throws. Do not conflate these contracts.
- `HarnessTool = AgentTool & { replay?: "never" | "safe" }` declares intended recovery policy; the scaffold does not yet execute or replay tools.
- `messages.ts:convertToLlm` drops failed assistant turns and orphaned tool results using pi-ai's `dropFailedAssistantTurns`. Compaction estimates count the same retained messages, but `lastUsageIndex` remains relative to the caller's original array.
- Harness tests run under `vitest.harness.config.ts` (`test/harness/**`; coverage limited to `src/harness/**` plus `src/agent.ts` and `src/agent-loop.ts`).

## ANTI-PATTERNS

- Weakening `never`-typed fields that keep invalid entry/record/operation unions unrepresentable.
- Defining telemetry spans or attributes outside the schemas in `telemetry.ts`.
- Treating `events.ts:HarnessEventBus` as the implementation of `AgentHarness.events`; the latter still uses `UnavailableRegistry`.
- Treating non-zero command exits as thrown execution failures; they are values in the execution result (spawn/timeout/abort are the distinct error cases).
- Truncation that returns partial lines; `utils/truncate.ts` must never split a line (documented bash-tail edge case aside).
