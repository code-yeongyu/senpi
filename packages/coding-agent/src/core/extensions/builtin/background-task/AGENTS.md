# builtin/background-task

Builtin extension #1 (loaded first). Adds the `task`, `background_output`, and `background_cancel` tools — senpi's sub-agent runtime. Spawns detached subprocesses, persists state via custom session entries, restores tasks on session reload, renders a "background tasks" widget, and turns sub-agent completion into desktop notifications. **Not in upstream pi.**

## FILES

```
background-task/
├── index.ts          # Extension entry — registers tools, widget, custom session entries, restoration hooks
├── manager.ts        # In-memory task registry; lifecycle (pending → running → completed/failed/cancelled)
├── spawner.ts        # Spawns sub-agent subprocesses (detached), wires stdio piping
├── task-tool.ts      # `task` tool definition + execute()
├── output-tool.ts    # `background_output` tool — fetch full stdout/result by task ID
├── cancel-tool.ts    # `background_cancel` tool — terminate one or all (force) tasks
├── notification.ts   # OS desktop notification on task completion
└── types.ts          # Task, TaskState, BackgroundTaskMessage (custom session entry shape)
```

## WHERE TO LOOK

| Task | File |
|------|------|
| Change sub-agent spawn semantics | `spawner.ts` |
| Add task lifecycle state | `types.ts` `TaskState` + `manager.ts` |
| Modify task tool args | `task-tool.ts` (TypeBox schema) |
| Tune restoration behavior on reload | `index.ts` `session_start` handler |
| Disable / customize desktop notifications | `notification.ts` |

## TASK LIFECYCLE

1. `task(agent_type, prompt, run_in_background)` → spawner forks subprocess with `AGENT_TYPE=<type>` env.
2. Manager assigns `bg_<short-hash>` task ID, writes a `BackgroundTaskMessage` custom session entry.
3. Subprocess streams stdout via pipe; manager updates entry on completion.
4. On `session_start` (reload), index.ts replays `BackgroundTaskMessage` entries to rebuild registry.
5. On task completion: notification + (if widget mounted) re-render of background-tasks widget.

## CONVENTIONS

- **Spawn detached** — must survive parent session crashes; reattachment via PID + manifest file under `~/.senpi/agent/tasks/`.
- **Custom session entries** — sub-agent state is persisted in the JSONL session via a custom message type (NOT regular `toolResult`). Survives forks and rebases.
- **`AGENT_TYPE` env var** is the contract consumed by the external `pi-agent-system` extension when installed.
- **`run_in_background=false` is synchronous** — `task-tool.ts` awaits completion (with 30-min idle timeout reset on activity).
- **Cancel never `--force`-kills by default** — use `background_cancel(all=true)` only for orchestrator teardown; prefer per-task `taskId`.

## ANTI-PATTERNS

- Calling `background_cancel(all=true)` from a sub-agent — orchestrator-only.
- Polling `background_output` while a task is still `running` — wait for the `<system-reminder>` completion event.
- Adding new task state without extending `BackgroundTaskMessage` — breaks reload restoration.
- Spawning sub-agents from inside `core/` (bypassing this extension) — defeats persistence + notification.

## NOTES

- This extension MUST register before `permission-system`; external agent-profile extensions read `AGENT_TYPE` from spawned subprocesses.
- Sub-agent stdout is rendered through `core/agent-session.ts` event bus; the widget reads from `manager.ts`'s observable.
- The `task_id` returned to the parent is the same one used by `background_output` and `background_cancel`.
