import type { TodoPhase, TodoStatus } from "./todo-types.ts";

const STATUSES = new Set<TodoStatus>(["pending", "in_progress", "completed", "abandoned"]);
const DEFAULT_PHASE_NAME = "Tasks";

export function phasesFromCursorTodos(todos: unknown): TodoPhase[] | undefined {
	if (!Array.isArray(todos)) {
		return undefined;
	}
	const tasks = [];
	for (const item of todos) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const raw = item as { content?: unknown; status?: unknown };
		const content = typeof raw.content === "string" ? raw.content.trim() : "";
		if (!content) {
			continue;
		}
		const status = STATUSES.has(raw.status as TodoStatus) ? (raw.status as TodoStatus) : "pending";
		tasks.push({ content, status });
	}
	return tasks.length > 0 ? [{ name: DEFAULT_PHASE_NAME, tasks }] : [];
}
