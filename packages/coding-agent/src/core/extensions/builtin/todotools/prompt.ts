// Adapted from oh-my-pi's todo prompt (MIT License).
// Copyright (c) 2025 Mario Zechner
// Copyright (c) 2025-2026 Can Bölük
// https://github.com/can1357/oh-my-pi

export const TODO_TOOL_DESCRIPTION = `**Tasks referenced by verbatim content string, NEVER an auto-generated ID — no "task-1"/"task-N" exists. Pass the content text in the task field.**

On each completion the earliest still-open task (in phase order) auto-promotes to in_progress.
Completing tasks out of phase order can move this pointer **back** to an earlier phase — expected; completed tasks are never reverted.

## Operations

| op | Required fields | Effect |
|---|---|---|
| init | list: [{phase, items: string[]}] | Initialize full list (replaces existing) |
| init | items: string[] | Flattened single-phase init |
| start | task | Mark in progress |
| done | task or phase | Mark completed |
| drop | task or phase | Mark abandoned |
| rm | task or phase (optional) | Remove task or phase; omit both to clear |
| append | phase?, items: string[] | Append tasks to phase; lazily creates phase |
| view | — | Read-only: echo list |

Example: {"op":"init","list":[{"phase":"Setup","items":["Survey code","Write tests"]}]}

## Anatomy
- **Task content**: 5–10 words; what, not how. Unique identifier.
- **Phase name**: short noun phrase (e.g. Foundation, Auth, Verification). Unique identifier. NEVER prefix 1., A), Phase 1:.

## Rules
- Mark tasks done immediately after finishing, then re-check the list against the newest user message. Complete phases in order.
- NEVER make a todo call your turn's only tool call — batch it with the real work: init with the first reads/edits, each done/start with the next action. Solo todo turns waste a round trip.
- Blocked? append a task to the active phase, or drop.
- Keep task/phase strings stable once introduced. done/start/drop take the task's EXACT text — copy it verbatim from the latest todo result; when it is lost, view echoes the list.

## When to create a list
- Task requires 3+ distinct steps
- User explicitly requests one
- User provides a set of tasks
- New instructions arrive mid-task — reconcile before acting: keep what they don't conflict with, amend what they contradict, append what they add; replace only on explicit redirect

<critical>
User hands you a multi-step plan — phased todo, numbered/bulleted checklist, or "N bugs/items/tasks":
- You MUST init the list with EVERY item as its own task before working.
- Enumerate all; NEVER summarize into fewer tasks, sample "the important ones", drop items, or track the rest from memory.
</critical>`;

export const TASK_MANAGEMENT_SECTION = `
<Task_Management>
## Todo Management

Use the todo tool for multi-step work; its description carries the operations, anatomy, and rules. Mark each item done the moment it finishes and reconcile the list against the newest user message before ending a turn.

## Evidence
- File edit: inspect the changed files and diagnostics.
- Build command: require exit code 0.
- Test run: require passing output, or state the pre-existing failure.
</Task_Management>
`;
