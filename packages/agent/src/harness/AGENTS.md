# src/harness

Optional Node-side harness over the core agent loop: durable sessions, lane state machine, compaction, skills/prompt templates, built-in tools, and schema-first telemetry. Public entry `AgentHarness` (`agent-harness.ts`), exported via `src/node.ts`.

Earned its own file: 41 files / ~10k LOC, distinct domain from the browser-safe core (score 12: file count, export surface, 23+ `AgentHarness` references in coding-agent).

## WHERE TO LOOK

| Task | File |
|---|---|
| Run/compaction/navigation/queue lifecycle | `agent-harness.ts` (`AgentHarness`, `AgentLane`) |
| Record-log validation, lane state reduction | `reducer.ts` (`validateRecordLog`, `reduceLaneState`, `RecordLogCorruption`) |
| Telemetry span schemas | `telemetry.ts` (`AI_TELEMETRY_SCHEMA`, `HARNESS_TELEMETRY_SCHEMA`, `startAiSpan`/`startHarnessSpan`) |
| Node process/filesystem environment | `env/nodejs.ts` (`NodeExecutionEnv`, Windows process-tree teardown) |
| Compaction and branch summaries | `compaction/` (`compaction.ts`, `branch-summarization.ts`) |
| Session persistence | `session/` (own AGENTS.md) |
| Built-in tools | `tools/` (own AGENTS.md) |
| Skills, prompt templates, system prompt | `skills.ts`, `prompt-templates.ts`, `system-prompt.ts` |
| Result/error vocabulary | `result.ts`, `types.ts` (`Result`, `TaggedError`, `matchError`) |
| Output truncation, shell capture | `utils/truncate.ts`, `utils/shell-output.ts` |

## CONVENTIONS

- `docs/harness.md` is the normative implementation spec (entries + registers + usage ledger, transactional writes, op-state recovery). When code and spec contradict, stop for review; do not improvise a new durable contract.
- Operational failures are tagged errors inside `Result` values, never untyped exceptions.
- Telemetry is schema-first: edit the const schemas in `telemetry.ts`, then regenerate `docs/telemetry-schema.md` (`bun run generate-telemetry-docs`; `bun run check:telemetry-docs` verifies CI-exact output).
- Harness tools are `AgentTool & { replay?: "never" | "safe" }` (`HarnessTool`); only tools marked replay-safe re-run after recovery.
- Harness tests run under `vitest.harness.config.ts` (`test/harness/**`; coverage limited to `src/harness/**` plus `src/agent.ts` and `src/agent-loop.ts`).

## ANTI-PATTERNS

- Weakening `never`-typed fields that keep invalid entry/record/operation unions unrepresentable.
- Defining telemetry spans or attributes outside the schemas in `telemetry.ts`.
- Treating non-zero command exits as thrown execution failures; they are values in the execution result (spawn/timeout/abort are the distinct error cases).
- Truncation that returns partial lines; `utils/truncate.ts` must never split a line (documented bash-tail edge case aside).
