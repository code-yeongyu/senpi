# src/harness/tools

Built-in tool library (bash, edit, edit-diff, write, read, image) for the harness, re-exported by coding-agent as `create*Tool` and `create*ToolDefinition`. All factories are generic over `ExecutionToolContext`.

Earned its own file: distinct domain plus external centrality (score 11: `index.ts` barrel, 57 tool-factory references in coding-agent).

## WHERE TO LOOK

| Task | File |
|---|---|
| Shell execution, capture, timeout/abort | `bash.ts` (`createBashTool`, `BashToolDetails`, `BashExecution`) |
| Edit application and diff algorithms | `edit.ts`, `edit-diff.ts` |
| File write/read | `write.ts`, `read.ts` |
| Serialized filesystem mutations | `file-mutation-queue.ts` (`withFileMutationQueue`) |
| Path resolution helpers | `path-utils.ts` |
| Tool context contract | `tool-context.ts` (`ExecutionToolContext`, `PostMutateHook`) |
| Post-write hook execution | `post-mutate.ts` (`runPostMutate`, `appendPostMutateNote`) |
| Image attachment encoding | `image.ts` |
| Public surface | `index.ts` (factories + types) |

## CONVENTIONS

- All filesystem mutation goes through `withFileMutationQueue(env, path, fn)`; tools never write via env APIs directly.
- Paths resolve through `path-utils.ts` helpers against the context root.
- Tools throw on failure so the agent reports the error; failure text is never returned as successful result content. The one deliberate exception is `postMutate`: the write it follows has already landed, so a rejecting hook becomes an appended warning note instead of discarding a committed mutation.
- The optional `context.postMutate` hook runs inside the same `withFileMutationQueue` slot as the write it follows; `edit` recomputes its diff metadata from disk whenever the hook may have touched the file (reported `changed`, or rejected after a partial rewrite).
- Replay semantics are declared where consumed as `HarnessTool` (`replay?: "never" | "safe"`, defined in `agent-harness.ts`), not inferred from the tool.
- A new tool ships as a factory plus exported input/details types in `index.ts`.

## ANTI-PATTERNS

- Bypassing the mutation queue for writes.
- Returning failure text as tool result content instead of throwing.
- Adding a tool without its matching exported types in `index.ts`.
