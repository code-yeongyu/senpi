# core/tools/renderers changes

## Align grep rendering with the engine contract (2026-09-14)

### What changed

- `bash.ts`, `edit.ts`, `grep.ts`, `read.ts`, and `write.ts` render the built-in tool results; the grep renderer emits the engine-backed structured footer and grouped match format for Cursor and model-facing calls.

### Why

- Cursor and model-facing grep calls must share the new engine-backed output contract.

### Why an extension could not handle it

- Built-in renderer behavior is package code and cannot be changed by an extension.

### Expected merge conflict zones

- `packages/coding-agent/src/core/tools/renderers/*.ts`
