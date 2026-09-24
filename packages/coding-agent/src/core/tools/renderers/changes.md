# core/tools/renderers changes

## Export the compact read classification for the exploration group, senpi#2060 (2026-09-23)

### What changed

- `read.ts`: `getCompactReadClassification` and the `ReadRenderArgs` type are exported. The renderer's own use and its per-call memoization are unchanged.

### Why

- The interactive exploration projection needs the same `skill` / `memory` verdict the collapsed card uses, so a skill load or memory recall is not folded into the `Explored` cell.

### Why an extension could not handle it

- The classification order (`SKILL.md`, registered classifiers, docs, resource) lives in this renderer; an extension can add a classifier but cannot read the combined verdict.

### Expected merge conflict zones

- The `getCompactReadClassification` declaration in `read.ts`.

## Align grep rendering with the engine contract (2026-09-14)

### What changed

- `bash.ts`, `edit.ts`, `grep.ts`, `read.ts`, and `write.ts` render the built-in tool results; the grep renderer emits the engine-backed structured footer and grouped match format for Cursor and model-facing calls.

### Why

- Cursor and model-facing grep calls must share the new engine-backed output contract.

### Why an extension could not handle it

- Built-in renderer behavior is package code and cannot be changed by an extension.

### Expected merge conflict zones

- `packages/coding-agent/src/core/tools/renderers/*.ts`


## 2026-09-23 — Remove renderer-owned tool notice lines

### What changed

`packages/coding-agent/src/core/tools/renderers/read.ts`, `packages/coding-agent/src/core/tools/renderers/grep.ts`, `packages/coding-agent/src/core/tools/renderers/bash.ts`: Remove read truncation and oversized-line warnings, grep truncation/statistics headers, and bash full-output warnings. Remove bash footer text matching; structured audience metadata controls visibility.

### Why

The TUI must not reconstruct a notice that the producer deliberately marks model-only.

### Why an extension could not handle it

Built-in renderers own these detail-derived lines and run independently of extension-added text parts.

### Expected merge conflict zones

Read, grep, and bash result formatting; ordinary collapse hints remain.

- Covered production paths: `packages/coding-agent/src/core/tools/renderers/read.ts`, `packages/coding-agent/src/core/tools/renderers/grep.ts`, `packages/coding-agent/src/core/tools/renderers/bash.ts`.
