# test/suite/regressions

One-concern-per-file regression tests: 213 direct test files, a shared image fixture, and a child-process fixture / ~30,100 TypeScript LOC. Score 7 — existing issue-oriented compaction/queue-ownership guide retained in UPDATE mode.

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Compaction admission/rejection | `pre-prompt-compaction-no-continue.test.ts`, `compaction-synchronous-admission.test.ts`, `compaction-rejection-feedback.test.ts` |
| Oversized-session resume | `1511-resume-oversized-session-compacts.test.ts` — compaction-required admission on resume |
| Post-compaction queue ownership | `post-compaction-queue-ownership.test.ts`, `post-compaction-queued-input-resume.test.ts`, `post-compaction-tool-continuation-deadlock.test.ts`, `post-compaction-recovery-{bounds,guards}.test.ts` |
| Stale generation/revision races | `compaction-generation-stale-revision.test.ts`, `stale-extension-context-after-session-replacement.test.ts`, `stale-goal-direct-input.test.ts` |
| Goal continuation caps | `goal-continuation-*.test.ts`, `issue-447-goal-continuation.test.ts`, `issue-566-goal-repetition-tool-reset.test.ts` |
| Provider retry/timeout | `provider-idle-{recovery,steering}.test.ts`, `provider-retry-recompaction.test.ts`, `provider-timeout-classification.test.ts` |
| Codex remote compaction | `issue-296-openai-codex-remote-compaction{,-boundaries}.test.ts` |
| Image generation arbitration | `imagegen-arbitration.test.ts` — 24-row truth table; shared image input in `issue-1455-image-fixture.ts` |
| Model config/selector | `model-config-controls.test.ts`, `model-selector-favorites-search.test.ts`, `per-model-thinking-memory.test.ts` |
| Process/inspector/Windows | `inspector-*.test.ts`, `issue-812-windows-taskkill-enoent.test.ts`, `issue-823-mcp-pgrep-pattern.test.ts` |
| Shutdown rejection boundary | `permission-system-shutdown-unhandled-rejection.test.ts`, `fixtures/permission-system-shutdown-unhandled-rejection.ts` |

## CONVENTIONS

- Name by behavior, not source module: `issue-<number>-<slug>.test.ts` for tracked issues, `todo-<n>-<slug>.test.ts` for todo tracks, plain behavior slugs otherwise. Do not infer coverage from the filename — several issue-numbered files test broad session/compaction behavior.
- Harness-driven cases import `../harness.ts`; direct integration cases drive `AgentSession` / `InteractiveMode`. Extensions are injected via `extensionFactories` and `pi.on(...)` hooks.
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
bun run --cwd packages/coding-agent test test/suite/regressions/<name>.test.ts
bun run --cwd packages/coding-agent test test/suite/regressions
```
