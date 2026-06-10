# Per-Feature Compaction Test Fixtures

This directory contains **per-feature** compaction fixtures, each targeting a specific subsystem of the compaction engine. Unlike shared monolithic fixtures (e.g., `large-session.jsonl`), these files isolate individual behavioral contracts so that test failures pinpoint exactly which subsystem regressed.

## Why Per-Feature Instead of Shared?

Shared fixtures suffer from "spooky action at a distance": a change to one subsystem can cause a seemingly unrelated test to fail because the shared fixture exercises multiple code paths simultaneously. When `large-session.jsonl` breaks, you do not know whether the root cause is adaptive threshold logic, circuit breaker counting, or tool truncation heuristics. Debugging becomes a guessing game.

Per-feature fixtures establish a **behavioral contract** between each subsystem and its tests. Each fixture is minimal, contains only the entry types relevant to its feature, and uses synthetic data with fake IDs and timestamps. No real API keys, PII, or production session IDs are included. This makes tests deterministic, fast, and self-documenting.

## Fixture Inventory

| # | Directory | File | Purpose | Entries |
|---|-----------|------|---------|---------|
| 1 | `adaptive-threshold/` | `16k-near-threshold.jsonl` | Context near 16k limit, triggers proactive compaction | 7 |
| 2 | `per-turn-cap/` | `four-back-to-back-compactions.jsonl` | Four compactions in one turn, tests rate limiting | 11 |
| 3 | `circuit-breaker/` | `three-failures-then-success.jsonl` | Three failed compactions then recovery | 11 |
| 4 | `pre-prune/` | `oversized-with-pairs.jsonl` | Interleaved tool_call/tool_result with large content | 20 |
| 5 | `tool-truncation/` | `large-bash-output.jsonl` | Bash output exceeding token limits | 7 |
| 6 | `tool-pair-repair/` | `orphan-tool-result.jsonl` | Tool result without matching tool call | 6 |
| 7 | `prompt-sections/` | `full-context.jsonl` | Rich session with todos, agent state, delegated sessions | 17 |
| 8 | `agent-checkpoint/` | `multi-agent-state.jsonl` | Model changes and thinking level changes | 11 |
| 9 | `todo-preservation/` | `todos-then-compact.jsonl` | Todo entries preserved across compaction | 12 |
| 10 | `degradation-monitor/` | `post-compact-three-no-text.jsonl` | Assistant messages with only tool calls after compaction | 13 |
| 11 | `extension-hooks/` | `manual-with-custom-instructions.jsonl` | Extension-driven compaction with custom instructions | 12 |

## Validation

Every fixture round-trips through `parseSessionEntries` and `migrateSessionEntries` from `packages/coding-agent/src/core/session-manager.ts`. All fixtures use v1 format (no id/parentId) so migration adds tree structure automatically. No fixture exceeds 100 entries; context-size scenarios achieve scale via large content rather than entry count.
