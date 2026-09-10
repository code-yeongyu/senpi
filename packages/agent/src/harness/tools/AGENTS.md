# src/harness/tools

Context-injected bash/edit/read/write factories plus diff and image helpers, exported through the agent-core barrel. These are separate from coding-agent's cwd-bound `create*Tool`/`create*ToolDefinition` implementations.

Earned its own file: distinct execution-tool domain (score 8: `index.ts` boundary, code ratio, symbol/export density; similarly named coding-agent factories are not reference evidence).

## WHERE TO LOOK

| Task | File |
|---|---|
| Shell execution, capture, timeout/abort | `bash.ts` (`createBashTool`, `BashToolDetails`, `BashExecution`) |
| Edit application and diff algorithms | `edit.ts`, `edit-diff.ts` |
| File write/read | `write.ts`, `read.ts` |
| Serialized filesystem mutations | `file-mutation-queue.ts` (`withFileMutationQueue`) |
| Path resolution helpers | `path-utils.ts` |
| Tool context contract | `tool-context.ts` (`ExecutionToolContext`, `PostMutateContext`, `PostMutateHook`) |
| Post-write hook execution | `post-mutate.ts` (`runPostMutate`, `appendPostMutateNote`) |
| Image attachment encoding | `image.ts` |
| Public surface | `index.ts` (factories + types) |

## CONVENTIONS

- Factories return `AgentHarnessTool<TContext>`; `execute` receives `{ env, postMutate }` in its fifth argument rather than capturing a cwd at construction.
- Edit/write mutations call env APIs inside `withFileMutationQueue(env, path, fn)`. Slots are keyed by environment identity and canonical path, so aliases serialize while different files can proceed independently.
- Paths resolve through `path-utils.ts` helpers against the context root.
- Tools throw on failure so the agent reports the error; failure text is never returned as successful result content. The one deliberate exception is `postMutate`: the write it follows has already landed, so a rejecting hook becomes an appended warning note instead of discarding a committed mutation.
- The optional `context.postMutate` hook runs inside the same `withFileMutationQueue` slot as the write it follows; `edit` recomputes its diff metadata from disk whenever the hook may have touched the file (reported `changed`, or rejected after a partial rewrite).
- `edit` matches the entire `edits[]` batch against the original normalized content, rejects overlaps, and preserves BOM/line endings. `prepareArguments` accepts legacy or stringified input, but the public schema remains `{ path, edits }`.
- A new tool ships as a factory plus exported input/details types in `index.ts`.

## ANTI-PATTERNS

- Bypassing the mutation queue for writes.
- Returning failure text as tool result content instead of throwing.
- Adding a tool without its matching exported types in `index.ts`.
- Copying coding-agent factory signatures here or treating same-named tool implementations as interchangeable.
