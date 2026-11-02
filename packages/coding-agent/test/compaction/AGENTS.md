# test/compaction

Compaction mechanics and policy: blocking, speculative, idle/warm, pruning, routing, retry/degradation, tool-pair repair, and OpenAI remote compaction. 57 files / ~13,100 LOC, ~612 test call sites. Score 15 — distinct policy domain with numeric constants pinned as contracts.

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Extension wiring / handlers | `*-characterization.test.ts`, tests importing `src/core/extensions/builtin/compaction/index.ts` |
| Speculative warm-start | `speculative-compaction.test.ts` (848 LOC), `speculative-budget-handoff.test.ts`, `stale-context-idle-warmup.test.ts`, `stale-warm-blocking-repro.test.ts` |
| OpenAI remote route | `openai-remote-compaction.test.ts` (1,160 LOC), `openai-remote-abort-standdown.test.ts`, shared fixtures in `openai-remote-test-models.ts` |
| Checkpoint provenance | `canonical-routes.test.ts` (1,017 LOC) |
| Deterministic degradation | `required-compaction-deterministic-fallback.test.ts`, `summarization-body-too-large.test.ts` |
| Thresholds / budgets | `adaptive-threshold.test.ts`, `context-reduction.test.ts`, `hard-limit-emergency.test.ts`, `idle-compaction.test.ts` |
| Tool-call pairing | `tool-pair-repair.test.ts`, `todo-preservation.test.ts` |
| Restoration bookkeeping | `restoration-tracker.test.ts` |

`openai-remote-test-models.ts` is the only shared module: it exports `OPENAI_NATIVE_LEGACY_MODEL` (Responses/WebSocket, `supportsRemoteCompactionV2`) and `OPENAI_CANONICAL_LEGACY_MODEL` (canonical endpoint/base URL derivation).

## CONVENTIONS

- File names encode route, failure mode, boundary, or incident (`blocking-*`, `stale-*`, `summarization-*`, `openai-remote-*`, `*-characterization`) — deliberately not one-file-per-source-module.
- Session-manager entries are constructed explicitly (`type`, `id`, `parentId`, `timestamp`, payload), often as complete OpenAI-native branches, to verify replay and provenance.
- Compaction is exercised through extension harnesses and event callbacks (`beforeAgentStart`, `sessionBeforeCompact`, `agentEnd`, context hooks), not by calling pure functions alone. Provider request/header/context hooks are installed to validate the final pipeline plus redaction.
- Assertions inspect machine values: route/transport, payload input, persisted details, revisions, reasons, emitted events. Numeric policy constants (37.5% speculative threshold, adaptive ratios, context windows, retry bounds, hard caps) are literal contracts — changing a constant means changing these tests deliberately.
- Remote OpenAI coverage distinguishes the direct compact endpoint from the Responses WebSocket route and validates provenance against endpoint, stable headers, auth tenant, hook-filtered prefixes, and model identity.

## ANTI-PATTERNS

- Raw provider items must never be treated as context-boundary provenance.
- Cancellation must never be reported as a credential error.
- Stale-generation continuations must not start another warm-up or throw; stale/warm paths must not end feedback without an applied entry.
- Oversized summarization responses (HTTP 413 / "Request body too large") are the same recovery class as token-window overflow: shrink and retry, then degrade deterministically. An unclassified failure causing a long stall is the bug.
- A failed speculative warm start must reuse the existing job/watchdog failure path — never discard it and issue a second full-budget blocking request.
- Never apply a speculative summary after a superseding revision/generation or a rewritten boundary; never replay checkpoints after endpoint/auth/context-hook provenance changes; never persist raw credentials; never drop tool-call/result pairs.

## COMMANDS

```bash
bun run --cwd packages/coding-agent test --run test/compaction/<file>.test.ts
bun run --cwd packages/coding-agent test --run test/compaction
```
