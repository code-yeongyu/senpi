# builtin/loop-guard

## OVERVIEW
Tool-loop detection domain (score 8): advisory similar/cyclic notices plus episode-scoped escalation for identical calls.

## WHERE TO LOOK

| Task | File |
|---|---|
| Wire execution, call, turn, and session events | `index.ts` |
| Canonical signatures and bounded history | `tracker.ts` |
| Identical/similar/cycle detection | `detectors.ts` |
| Notice admission and thresholds | `detectors.ts`, `policy.ts` |
| Blocking/hard-stop episode state | `escalation.ts` |
| Text similarity | `similarity.ts` |
| Model-facing notice construction | `notice.ts` |
| Transcript display | `renderer.ts` |

## CONVENTIONS

- `ToolCallTracker` observes tool-call records, not adjacent transcript messages; its history window is bounded.
- `NoticeGate` controls notice admission separately from detection.
- `IdenticalLoopEscalation` correlates execution attempts with `tool_call` via tool-call ID.
- Reaching the identical-notice threshold schedules blocking after that attempt; the triggering attempt is still allowed.
- A changed tool/argument signature resets the episode and its pending attempt map together.
- Similar and cyclic detections never enter the blocking episode.
- Hard-stop announcement is emitted once per episode even if additional identical calls arrive.
- Shared notice rendering supplies the semantic error tone and ASCII marker.

## ANTI-PATTERNS

- Blocking calls that never passed through `tool_execution_start` observation.
- Assuming tool-call adjacency matches transcript-message adjacency.
- Resetting only a hard-stop counter while retaining stale episode fingerprints.
- Turning similarity warnings into hard vetoes without changing the explicit escalation policy.
