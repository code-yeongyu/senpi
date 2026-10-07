# src/harness

Optional Node-side harness over the core agent loop: durable sessions, lane operation state machine, compaction, skills/prompt templates, built-in tools, and schema-first telemetry. Public entry `AgentHarness` (`agent-harness.ts`, built by `createAgentHarness` from `runtime/harness.ts`), exported via `src/node.ts`.

Earned its own file: ~80 files, distinct domain from the browser-safe core (file count, export surface, 23+ `AgentHarness` references in coding-agent).

## WHERE TO LOOK

| Task | File |
|---|---|
| Public interfaces and re-exports | `agent-harness.ts` (`AgentHarness`, `AgentLane`, `LaneSnapshot`, `SuspendedRun`) |
| Harness/lane implementations, restore on open | `runtime/harness.ts` (`Harness`, `createAgentHarness`), `runtime/lane.ts` (`Lane`), `runtime/restore.ts` (`restoreSession`, `restoreLaneState`) |
| Operation drive loop and its phases | `runtime/drive.ts` (`driveOperation`), `runtime/drive/` (`checkpoint.ts`, `generation.ts`, `tools.ts`, `boundary.ts`, `deferred.ts`, `structural.ts`, `recovery.ts`, `retry.ts`, `terminal.ts`) |
| Lane snapshot reduction from events | `runtime/reducer.ts` (`reduceLaneSnapshot`) |
| Streaming progress channels, transcript reads | `runtime/progress.ts` (`openFrameProgress`, `openToolProgress`), `runtime/transcript.ts` (`readBoundedContext`, `readLaneQueues`) |
| Assistant streaming and tool execution primitives | `execution/assistant.ts` (`streamHarnessAssistant`), `execution/tools.ts`, `execution/effect-gate.ts` (`createGate`) |
| Hooks, events, config validation | `hooks.ts` (`HookRegistry`), `events.ts` (`HarnessEventBus`), `config.ts` (`validateRetryPolicy`, `validateCompactionSettings`) |
| Telemetry span schemas | `telemetry.ts` (`AI_TELEMETRY_SCHEMA`, `HARNESS_TELEMETRY_SCHEMA`, `startAiSpan`/`startHarnessSpan`) |
| Node process/filesystem environment | `env/nodejs.ts` (`NodeExecutionEnv`, Windows process-tree teardown) |
| Compaction and branch summaries | `compaction/` (`compaction.ts`, `branch-summarization.ts`) |
| Session persistence | `session/` (own AGENTS.md) |
| Built-in tools | `tools/` (own AGENTS.md) |
| Skills, prompt templates, system prompt | `skills.ts`, `prompt-templates.ts`, `system-prompt.ts` |
| Result/error vocabulary | `result.ts`, `types.ts` (`Result`, `TaggedError`, `matchError`) |
| Output truncation, shell capture | `utils/truncate.ts`, `utils/shell-output.ts` |

## CONVENTIONS

- `docs/harness.md` is the normative implementation spec (entries + values + usage ledger, transactional writes, op-state recovery). When code and spec contradict, stop for review; do not improvise a new durable contract.
- Operational failures are tagged errors inside `Result` values, never untyped exceptions.
- Telemetry is schema-first: edit the const schemas in `telemetry.ts`, then regenerate `docs/telemetry-schema.md` (`bun run generate-telemetry-docs`; `bun run check:telemetry-docs` verifies CI-exact output).
- Harness tools are `AgentHarnessTool` values (`types.ts`): `execute` receives the turn's tool context plus an `AgentHarnessToolInvocation` whose `getMemo`/`setMemo` hold the durable replay memos that make re-running after recovery safe.
- Operation state lives in the `OperationState` union (`session/types.ts`); `runtime/drive.ts` dispatches on `state.at` and each phase module in `runtime/drive/` owns one slice.
- Harness tests run under `vitest.harness.config.ts` (`test/harness/**`; coverage limited to `src/harness/**` plus `src/agent.ts` and `src/agent-loop.ts`).

## ANTI-PATTERNS

- Weakening `never`-typed fields that keep invalid entry/operation/write unions unrepresentable.
- Defining telemetry spans or attributes outside the schemas in `telemetry.ts`.
- Treating non-zero command exits as thrown execution failures; they are values in the execution result (spawn/timeout/abort are the distinct error cases).
- Truncation that returns partial lines; `utils/truncate.ts` must never split a line (documented bash-tail edge case aside).
