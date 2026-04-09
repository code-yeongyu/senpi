import type { TodoItem } from "../state.js";

function isIncompleteTodo(todo: TodoItem): boolean {
	return todo.status !== "completed" && todo.status !== "cancelled";
}

export const CONTINUATION_DIRECTIVE = `[SYSTEM DIRECTIVE: SANEPI - TODO CONTINUATION]

Incomplete tasks remain in your todo list. Continue working on the next pending task.

- Proceed without asking for permission
- Mark each task complete when finished
- Do not stop until all tasks are done
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
	const remainingLines = remainingTodos.map((todo) => `- [${todo.status}] ${todo.content}`).join("\n");

	return `${CONTINUATION_DIRECTIVE}

[Status: ${completedCount}/${todos.length} completed, ${remainingTodos.length} remaining]

Remaining tasks:
${remainingLines}
`;
}
