# builtin/todotools

## OVERVIEW
Phased task-state domain (score 8): the `todo` tool, `/todo`, Markdown interchange, and session-backed sidebar share one state model.

## WHERE TO LOOK

| Task | File |
|---|---|
| Lifecycle restoration and native todo mirroring | `index.ts` |
| Public state API | `state.ts` |
| Schema and operation entry types | `todo-types.ts` |
| Mutate phases/tasks | `todo-operations.ts`, `normalize.ts` |
| Resolve task/phase targets | `todo-resolution.ts`, `todo-query.ts` |
| Restore branch entries | `todo-storage.ts` |
| Tool schema, execution, rendering | `tools/todo.ts` |
| Slash-command parsing and actions | `commands.ts`, `fuzzy-match.ts` |
| `TODO.md` import/export | `markdown.ts` |
| Native Cursor todo conversion | `native-todo-mirror.ts` |
| Sidebar model and component | `todo-widget.ts`, `todo-widget-component.ts` |
| Result text and prompt contract | `todo-format.ts`, `prompt.ts` |

## CONVENTIONS

- Exact task-content strings are identifiers; phases use stable short names rather than generated IDs.
- Statuses are `pending`, `in_progress`, `completed`, and `abandoned`.
- State access clones phases; mutable UI state is not handed directly to consumers.
- Restore from the current branch on both session start and session-tree changes.
- Persist full snapshots as `senpi.todo-state` with schema `v2`; operation/replay helpers live behind the state barrel.
- Cursor-native assistant `todo` calls without an `op` are mirrored into phases, persisted, and shown in the widget.
- Completion transitions are supplied separately to sidebar rendering, not inferred from display strings.

## ANTI-PATTERNS

- Renaming task text after introduction or adding numeric phase prefixes that change identity.
- Collapsing or dropping user checklist items during Markdown import or normalization.
- Treating a native todo snapshot as an op-based tool call.
- Reading one implementation module to reconstruct state when the public `state.ts` API already owns that operation.
