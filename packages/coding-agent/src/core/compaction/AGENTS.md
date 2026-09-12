# packages/coding-agent/src/core/compaction

Core compaction **mechanics** — token estimation, cut-point selection, summary generation, branch summarization, stream watchdogs. Distinct from `extensions/builtin/compaction/`, which owns compaction **policy** (speculative, circuit breaker, restoration, remote route). Core is what the extension calls; the extension is what decides when.

## FILES

```
compaction/
├── index.ts                  # Selective barrel: branch-summarization, compaction, utils ONLY
├── compaction.ts             # 1367 LOC — token estimation, threshold decisions, cut-point selection,
│                             # generateSummary, prepareCompaction, compact orchestration
├── branch-summarization.ts   # Branch collection/preparation/generation for forked sessions
├── utils.ts                  # Conversation serialization + file-operation tracking
├── lifecycle.ts              # Compaction lifecycle state/coordinator (imported directly, not via barrel)
├── stream-watchdog.ts        # Idle + duration watchdogs over provider summary streams
└── warm-anchor.ts            # Warm-anchor validation for speculative results
```

## WHERE TO LOOK

| Task | File |
|---|---|
| Change token estimation or cut-point math | `compaction.ts` |
| Change the summarization system prompt | `compaction.ts` (`SUMMARIZATION_SYSTEM_PROMPT`) |
| Change default thresholds | `compaction.ts` (`DEFAULT_COMPACTION_SETTINGS`) |
| Fork/branch summary behavior | `branch-summarization.ts` |
| Detect a stalled summary stream | `stream-watchdog.ts` |
| Serialize conversation for a summary request | `utils.ts` |

## CONVENTIONS

- **The barrel is deliberately selective** (three files). `lifecycle.ts`, `stream-watchdog.ts`, and `warm-anchor.ts` are imported by path from `agent-session.ts` and tests — do not widen `index.ts` into a blanket subtree export.
- **Never cut at a tool result.** Cut-point selection must land on a message boundary that leaves no orphaned tool_use/tool_result pair; `extensions/builtin/tool-pair-guard/` and `compaction/repair-tool-pairs.ts` exist because violations are expensive.
- A defined preparation must never carry empty summarizable content — return undefined instead.
- Adaptive threshold and effective keep-recent-cap updates move together; splitting them desynchronizes admission.
- Provider streams must be returned/consumed under both idle and duration watchdogs; an unwatched stream can hang a turn indefinitely.
- Policy changes ship with policy tests in lock-step (`test/compaction*.test.ts`, `test/fixtures/compaction/`).

## ANTI-PATTERNS

- Adding policy (when to compact, retry, circuit-break) here instead of in the builtin extension — this directory answers "how", not "whether".
- Pinning summarization prose in tests. The prompt contains deliberate "Do NOT" directives that are machine-consumed prompt contracts; assert parsed structure, not sentences.
- Regenerating summaries without checking `warm-anchor.ts` staleness — a stale warm result applied after context moved silently drops turns.

## NOTES

- `compaction.ts` is the highest-behavioral-risk file in `core/`; changes here reach every provider path.
- Overflow detection lives outside this directory: `core/agent-session.ts` calls `isContextOverflow` from `packages/ai/src/utils/overflow.ts`, then drives blocking compaction through the extension.
