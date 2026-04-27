export interface TodoEntry {
	id: string;
	text: string;
}

export function findTodoEntries(): TodoEntry[] {
	return [];
}

export function captureTodoSnapshot(): TodoEntry[] {
	return [];
}

export function restoreTodosIfMissing(_todos: TodoEntry[]): void {}
