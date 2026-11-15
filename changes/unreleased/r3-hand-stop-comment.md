<!-- changes-log: packages/coding-agent/src/modes/rpc/changes.md -->
## 2026-11-15 - The agent_end parser's held-Stop comment names the wake route (senpi#5898)

### What changed

- `packages/coding-agent/src/modes/rpc/loop-hook-lifecycle-events.ts`: comment only, in #6797 (`ea6be43049`). The `agent_end` parser's comment says a held Stop's writes reach the loop as durable wakes through the hand's outbox (H3, #6767), no longer that they ride the session's next reply. No behavior change and no user-facing entry.

### Why

- #6770 review L1 at `60559aec15`: the comment predated #6767's wake outbox. #6797 review L1: that comment change had no fragment once `6797.md` was removed.

### Why an extension could not handle it

- The comment documents the loopless runtime's own loop-hook parser.

### Expected merge conflict zones

- LOW: the `agent_end` parser comment in `loop-hook-lifecycle-events.ts`.
