import { sanitizeTodoText, type TodoItem } from "../state.js";

function isIncompleteTodo(todo: TodoItem): boolean {
	return todo.status !== "completed" && todo.status !== "cancelled";
}

export const CONTINUATION_DIRECTIVE = `[SYSTEM DIRECTIVE: SANEPI - TODO CONTINUATION]

Incomplete tasks remain in your todo list. Continue working on the next pending task.

- FIRST: Continue the first actionable remaining task now. If an in-progress task is already done, verify it and mark it completed before moving on
- Proceed without asking for permission
- Mark each task complete immediately when finished
- Do not stop until all tasks are done
- Do not reply with refusal, deferral, or a summary-only response
- If a task is already complete, no longer needed, or blocked, verify that and update the todo list to a terminal state instead of leaving it pending
- If you believe all work is already complete, the system is questioning your completion claim. Critically re-examine each todo item from a skeptical perspective, verify the work was actually done correctly, and update the todo list accordingly.`;

export function countIncomplete(todos: TodoItem[]): number {
	return todos.filter(isIncompleteTodo).length;
}

export function buildContinuationPrompt(todos: TodoItem[]): string {
	if (todos.length === 0) {
		return "";
	}

	const completedCount = todos.filter((todo) => todo.status === "completed").length;
	const remainingTodos = todos.filter(isIncompleteTodo);
	const activeTotal = completedCount + remainingTodos.length;
	const remainingLines = remainingTodos
		.map((todo) => `- [${todo.status}] ${sanitizeTodoText(todo.content)}`)
		.join("\n");

	return `${CONTINUATION_DIRECTIVE}

[Status: ${completedCount}/${activeTotal} completed, ${remainingTodos.length} remaining]

Remaining tasks:
${remainingLines}
`;
}
