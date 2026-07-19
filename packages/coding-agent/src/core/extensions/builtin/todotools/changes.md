# todotools Fork Tracker

## 2026-07-19 - Port oh-my-pi's phased todo tool

### Source

- Upstream repository: [oh-my-pi](https://github.com/can1357/oh-my-pi)
- Source files: `packages/coding-agent/src/tools/todo.ts` and
  `packages/coding-agent/src/prompts/tools/todo.md`
- Port source commit: `9fd6e97113f5ed3a847e66d346970efdf8afcad9`
- Upstream version: `v17.0.5`
- License: MIT; attribution is recorded in the source headers and the
  repository `NOTICE.md`.

### What was ported

- Phased task state with content-keyed operations: `init`, `start`, `done`,
  `drop`, `rm`, `append`, and `view`.
- Earliest-open-task auto-promotion, worked-ahead summary text, duplicate and
  missing-target validation, and atomic mutation failure semantics.
- The operation-oriented prompt anatomy and critical enumerate-every-item
  contract.

### Senpi adaptations

- Translated the upstream schema to TypeBox and registered it through senpi's
  extension API.
- Preserved the historical `todowrite` builtin id and `todo-sidebar` widget
  key while registering only the new `todo` model-facing tool.
- Replaced frame/live-subagent rendering with senpi's static `ToolDefinition`
  renderer: roman phase headers, collapsed untouched closed phases,
  strikethrough completed rows, and the phase-aware sidebar widget.
- Kept `senpi.todo-state` and added v2 phased persistence plus migration from
  legacy flat `todos` payloads and `cancelled` status.
- Extended the compaction bridge to recognize the new state entry and
  content-keyed phase tasks.

### Expected merge conflict zones

- HIGH: `state.ts`, `tools/todo.ts`, and the prompt when syncing a newer
  oh-my-pi todo implementation.
- MEDIUM: `index.ts`, compaction bridge, and todo tests because senpi owns
  extension lifecycle and session compatibility.
