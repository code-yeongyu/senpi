# Backlog

## P2 — 2026-07-30

**Goal policy docs: precise `paused` semantics for terminal failures and recovery**

- Goal policy docs should more precisely use `paused` for terminal failures (vs. other failure modes).
- Describe blocked-goal reactivation accurately in context of policy constraints.
- Document legacy `lastStartedAt` / `max(stored, derived)` recovery pattern and migration path.
- **Reason:** non-blocking documentation precision; candidate code/tests P0/P1 are green.
- **Context:** goal continuation safety tests and related policy refinement; follows AGENTS review protocol for documentation-only precision items.
