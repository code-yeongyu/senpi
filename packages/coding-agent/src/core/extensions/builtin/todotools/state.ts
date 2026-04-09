import stripAnsi from "strip-ansi";

export type TodoItem = {
	content: string;
	status: string;
	priority: string;
};

export type TodoWriteDetails = {
	todos: TodoItem[];
};

export type TodoStateEntry = {
	todos: TodoItem[];
};

type BranchEntry = { type: string; customType?: string; data?: unknown; message?: unknown };

export const TODO_STATE_ENTRY_TYPE = "sanepi.todo-state";

function countOpenTodos(todos: TodoItem[]): number {
	return todos.filter((todo) => todo.status !== "completed").length;
}

export function sanitizeTodoText(text: string): string {
	return stripAnsi(text)
		.replace(/[\r\n]+/g, " ")
		.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function getTodoMarker(status: string): string {
	if (status === "completed") return "[✓]";
	if (status === "in_progress") return "[•]";
	return "[ ]";
}

export function getTodoWidgetLines(todos: TodoItem[]): string[] | undefined {
	if (todos.length === 0 || !todos.some((todo) => todo.status !== "completed")) {
		return undefined;
	}
	return ["Todo", ...todos.map((todo) => `${getTodoMarker(todo.status)} ${sanitizeTodoText(todo.content)}`)];
}

export function getTodoResultLines(todos: TodoItem[]): string[] {
	return [
		`${countOpenTodos(todos)} todos`,
		...todos.map((todo) => `${getTodoMarker(todo.status)} ${sanitizeTodoText(todo.content)}`),
	];
}

export function isTodoItem(value: unknown): value is TodoItem {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const item = value as Record<string, unknown>;
	return typeof item.content === "string" && typeof item.status === "string" && typeof item.priority === "string";
}

export function isTodoItemArray(value: unknown): value is TodoItem[] {
	return Array.isArray(value) && value.every(isTodoItem);
}

export function getLatestTodosFromBranchEntries(entries: BranchEntry[]): TodoItem[] {
	let todos: TodoItem[] = [];

	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === TODO_STATE_ENTRY_TYPE) {
			const data = entry.data as TodoStateEntry | undefined;
			if (isTodoItemArray(data?.todos)) {
				todos = data.todos.map((todo) => ({ ...todo }));
			}
			continue;
		}

		if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) {
			continue;
		}

		const message = entry.message as { role?: string; toolName?: string; details?: unknown };
		if (message.role !== "toolResult" || message.toolName !== "todowrite") {
			continue;
		}

		const details = message.details as TodoWriteDetails | undefined;
		if (isTodoItemArray(details?.todos)) {
			todos = details.todos.map((todo) => ({ ...todo }));
		}
	}

	return todos;
}
