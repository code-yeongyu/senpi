import type { CustomEntry, SessionEntry } from "../../../session-manager.ts";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import type { TodoPhase } from "../todotools/state.ts";

const TODO_SNAPSHOT_CUSTOM_TYPE = "compaction.todo-snapshot";
const TODO_SNAPSHOT_SCHEMA = "senpi.compaction.todo-snapshot.v1";
const TODO_STATE_ENTRY_TYPE = "senpi.todo-state";

export interface TodoEntry {
	id?: string;
	content?: string;
	text?: string;
	status?: "pending" | "in_progress" | "completed" | "abandoned" | "cancelled";
}

export type TodoSnapshotItems = TodoEntry[] | TodoPhase[];

export interface TodoSnapshotPayload {
	schema: typeof TODO_SNAPSHOT_SCHEMA;
	todos: TodoSnapshotItems | SessionEntry[];
	capturedAt: number;
}

interface AppendEntryTarget {
	appendEntry<T = unknown>(customType: string, data?: T): void;
}

interface SendMessageTarget extends AppendEntryTarget {
	sendMessage<T = unknown>(
		message: { customType: string; content: string; display: boolean; details?: T },
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;
}

export interface RestoreResult<T extends TodoSnapshotItems = TodoSnapshotItems> {
	applied: boolean;
	restoredTodos: T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTodoStatus(value: unknown): value is TodoEntry["status"] {
	return (
		value === undefined ||
		value === "pending" ||
		value === "in_progress" ||
		value === "completed" ||
		value === "abandoned" ||
		value === "cancelled"
	);
}

function isTodoEntry(value: unknown): value is TodoEntry {
	if (!isRecord(value)) return false;
	const hasId = typeof value.id === "string";
	const hasContent = typeof value.content === "string" || typeof value.text === "string";
	return (hasId || hasContent) && isTodoStatus(value.status);
}

function isTodoPhase(value: unknown): value is TodoPhase {
	if (!isRecord(value) || typeof value.name !== "string" || !Array.isArray(value.tasks)) return false;
	return value.tasks.every(isTodoEntry);
}

function isCustomTodoEntry(entry: SessionEntry): entry is CustomEntry {
	return (
		entry.type === "custom" &&
		(entry.customType.startsWith("todowrite") || entry.customType === TODO_STATE_ENTRY_TYPE)
	);
}

function isLegacyTodoListEntry(entry: SessionEntry): entry is CustomEntry {
	return entry.type === "custom" && entry.customType === "todo-list";
}

function readTodosFromEntry(entry: CustomEntry): TodoEntry[] {
	const data = entry.data;
	if (!isRecord(data)) return [];
	if (Array.isArray(data.todos)) return data.todos.filter(isTodoEntry);
	if (Array.isArray(data.phases)) {
		return data.phases.filter(isTodoPhase).flatMap((phase) => phase.tasks);
	}
	return [];
}

function findLatestTodoSnapshot(ctx: ExtensionContext): TodoSnapshotPayload | null {
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== TODO_SNAPSHOT_CUSTOM_TYPE) continue;
		const data = entry.data;
		if (isRecord(data) && data.schema === TODO_SNAPSHOT_SCHEMA && Array.isArray(data.todos)) {
			return data as unknown as TodoSnapshotPayload;
		}
	}
	return null;
}

export function findTodoEntries(ctx: ExtensionContext): SessionEntry[];
export function findTodoEntries(entries: SessionEntry[], options?: { branchId?: string }): TodoEntry[];
export function findTodoEntries(
	ctxOrEntries: ExtensionContext | SessionEntry[],
	options?: { branchId?: string },
): SessionEntry[] | TodoEntry[] {
	if (Array.isArray(ctxOrEntries)) {
		return ctxOrEntries
			.filter((entry) => isLegacyTodoListEntry(entry) || isCustomTodoEntry(entry))
			.filter((entry) => options?.branchId === undefined || entry.parentId === options.branchId)
			.flatMap(readTodosFromEntry);
	}

	return ctxOrEntries.sessionManager.getEntries().filter(isCustomTodoEntry);
}

export function createTodoSnapshot(ctx: ExtensionContext): TodoSnapshotPayload {
	return {
		schema: TODO_SNAPSHOT_SCHEMA,
		todos: findTodoEntries(ctx),
		capturedAt: Date.now(),
	};
}

export function persistTodoSnapshot(pi: AppendEntryTarget, snapshot: TodoSnapshotPayload): void {
	pi.appendEntry(TODO_SNAPSHOT_CUSTOM_TYPE, snapshot);
}

export function captureTodoSnapshot(pi: ExtensionAPI, ctx: ExtensionContext): void;
export function captureTodoSnapshot(currentTodos: TodoSnapshotItems, pi: AppendEntryTarget, branchId?: string): void;
export function captureTodoSnapshot(
	piOrTodos: ExtensionAPI | TodoSnapshotItems,
	ctxOrPi: ExtensionContext | AppendEntryTarget,
	_branchId?: string,
): void {
	if (Array.isArray(piOrTodos)) {
		const pi = ctxOrPi as AppendEntryTarget;
		persistTodoSnapshot(pi, {
			schema: TODO_SNAPSHOT_SCHEMA,
			todos: piOrTodos,
			capturedAt: Date.now(),
		});
		return;
	}

	persistTodoSnapshot(piOrTodos, createTodoSnapshot(ctxOrPi as ExtensionContext));
}

export function restoreTodosIfMissing(pi: ExtensionAPI, ctx: ExtensionContext): void;
export function restoreTodosIfMissing<T extends TodoSnapshotItems>(
	snapshot: T,
	currentTodos: T,
	pi: AppendEntryTarget,
): RestoreResult<T>;
export function restoreTodosIfMissing(
	piOrSnapshot: ExtensionAPI | TodoSnapshotItems,
	ctxOrCurrentTodos: ExtensionContext | TodoSnapshotItems,
	_pi?: AppendEntryTarget,
): undefined | RestoreResult {
	if (Array.isArray(piOrSnapshot) && Array.isArray(ctxOrCurrentTodos)) {
		if (ctxOrCurrentTodos.length > 0) {
			return { applied: false, restoredTodos: ctxOrCurrentTodos };
		}
		return { applied: piOrSnapshot.length > 0, restoredTodos: piOrSnapshot };
	}

	const pi = piOrSnapshot as SendMessageTarget;
	const ctx = ctxOrCurrentTodos as ExtensionContext;
	if (findTodoEntries(ctx).length > 0) return;

	const snapshot = findLatestTodoSnapshot(ctx);
	if (!snapshot || snapshot.todos.length === 0) return;

	pi.sendMessage(
		{
			customType: "compaction.todo-restore-request",
			content: `Restore missing todo tasks from snapshot: ${JSON.stringify(snapshot.todos)}`,
			display: false,
			details: snapshot,
		},
		{ triggerTurn: true, deliverAs: "nextTurn" },
	);
}
