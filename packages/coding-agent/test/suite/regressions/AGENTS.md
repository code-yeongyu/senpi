# test/suite/regressions

One-concern-per-file regression tests, 162 files / ~22,790 LOC. Score 16 — distinct naming contract and the densest compaction/queue-ownership coverage in the repo.

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Compaction admission/rejection | `pre-prompt-compaction-no-continue.test.ts` (915 LOC), `compaction-synchronous-admission.test.ts`, `compaction-rejection-feedback.test.ts` |
| Post-compaction queue ownership | `post-compaction-queue-ownership.test.ts`, `post-compaction-queued-input-resume.test.ts`, `post-compaction-tool-continuation-deadlock.test.ts`, `post-compaction-recovery-{bounds,guards}.test.ts` |
| Stale generation/revision races | `compaction-generation-stale-revision.test.ts`, `stale-extension-context-after-session-replacement.test.ts`, `stale-goal-direct-input.test.ts` |
| Goal continuation caps | `goal-continuation-*.test.ts`, `issue-447-goal-continuation.test.ts`, `issue-566-goal-repetition-tool-reset.test.ts` |
| Provider retry/timeout | `provider-idle-{recovery,steering}.test.ts`, `provider-retry-recompaction.test.ts`, `provider-timeout-classification.test.ts` |
| Codex remote compaction | `issue-296-openai-codex-remote-compaction{,-boundaries}.test.ts` |
| Image generation arbitration | `imagegen-arbitration.test.ts` (740 LOC, 24-row truth table) |
| Model config/selector | `model-config-controls.test.ts`, `model-selector-favorites-search.test.ts`, `per-model-thinking-memory.test.ts` |
| Process/inspector/Windows | `inspector-*.test.ts`, `issue-812-windows-taskkill-enoent.test.ts`, `issue-823-mcp-pgrep-pattern.test.ts` |

## CONVENTIONS

- Name by behavior, not source module: `issue-<number>-<slug>.test.ts` for tracked issues, `todo-<n>-<slug>.test.ts` for todo tracks, plain behavior slugs otherwise. Do not infer coverage from the filename — several issue-numbered files test broad session/compaction behavior.
- 85 of 162 files import `../harness.ts`; the rest drive real `AgentSession` / `InteractiveMode` paths directly. Extensions are injected via `extensionFactories` and `pi.on(...)` hooks.
- Compaction regressions deliberately configure tiny context windows / reserve tokens to force the boundary under test. Model IDs, provider IDs, canonical paths, and MCP prefixes are exact-value assertions.
- Async coordination is deferred promises + captured event arrays + explicit release points; assertions inspect event order, queue ownership, payloads, usage, and persisted state.
- Windows path tests construct absolute `System32`/`Sysnative` candidates while running on POSIX; that is intentional, not dead code.

## ANTI-PATTERNS

- Never signal PID 1; never queue more than one pending continuation; never replay stale continuations.
- Do not continue after a rejected required compaction, and do not mutate the session while enforcing the transport image budget.
- Provider timeout policy must not match incidental extension/error text; unsupported providers must not enter Codex remote compaction; untrusted remote base URLs must never receive Codex OAuth compaction.
- Non-native / proxied image generation must never be reported as official native capability.
- Extension command dispatch must not wait behind barriers (`extension-command-immediate-dispatch.test.ts`).
- Do not convert a regression into a broad characterization test — that belongs one level up in `suite/`.

## COMMANDS

```bash
bun run --cwd packages/coding-agent test --run test/suite/regressions/<name>.test.ts
bun run --cwd packages/coding-agent test --run test/suite/regressions
```
