# changes.md — compaction

## Branch Summarization Routes Through Compaction Hook (2026-04-27)

### What changed

- `branch-summarization.ts`: `generateBranchSummary()` now emits `session_before_compact` with `reason: "branch"` before the default branch prompt path when an extension runner is provided.
- `branch-summarization.ts`: Branch entries are converted into an equivalent `CompactionPreparation` object for extensions.
- `branch-summarization.ts`: Extension `{ compaction: CompactionResult }` responses override the branch summary; `{ cancel: true }` aborts branch summarization.

### Why

- Branch summary was a separate route with a different prompt and no Critical Context section, causing the 9 inconsistencies the user listed.
- Routing through `session_before_compact` lets the builtin extension provide one canonical 9-section prompt across all 6 routes.
- The existing `BRANCH_SUMMARY_PROMPT` remains the fallback when no extension overrides.

### Why extension system couldn't handle this

The branch summarization path did not emit a compaction event before building its default prompt. Extensions can only replace branch summary content after this seam exists in core.

### Modified upstream files

- `branch-summarization.ts` — emits `session_before_compact` for branch summaries and accepts extension-provided compaction summaries.

### Expected merge conflict zones

- LOW: `branch-summarization.ts` is rarely touched upstream. If upstream changes branch summary preparation, keep the hook emission before default prompt construction and update the `CompactionPreparation` mapping to match the new data flow.

### Migration notes

If upstream changes branch summary preparation or adds new branch summary data sources, keep the `session_before_compact` hook emission before default prompt construction and update the `CompactionPreparation` mapping to match the new data flow. The `BRANCH_SUMMARY_PROMPT` fallback must remain intact for sessions without the compaction extension.
