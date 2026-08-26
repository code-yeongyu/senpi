import { describe, expect, it } from "vitest";
import {
	createTodoSnapshot,
	restoreTodosIfMissing,
	type TodoSnapshotPayload,
} from "../../src/core/extensions/builtin/compaction/todo-bridge.ts";
import type { TodoPhase } from "../../src/core/extensions/builtin/todotools/state.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/index.ts";
import type { CustomEntry, SessionEntry } from "../../src/core/session-manager.ts";

const TODO_SNAPSHOT_CUSTOM_TYPE = "compaction.todo-snapshot";
const TODO_SNAPSHOT_SCHEMA = "senpi.compaction.todo-snapshot.v1";

interface RestoreMessage {
	customType: string;
	content: string;
	display: boolean;
	details?: TodoSnapshotPayload;
}

function createStateEntry(index: number, phases: TodoPhase[]): CustomEntry {
	return {
		type: "custom",
		id: `todo-state-${index}`,
		parentId: index === 0 ? null : `todo-state-${index - 1}`,
		timestamp: new Date(Date.UTC(2026, 7, 25, 0, index)).toISOString(),
		customType: "senpi.todo-state",
		data: { schema: "v2", phases },
	};
}

function createSnapshotEntry(todos: unknown[]): CustomEntry {
	return {
		type: "custom",
		id: "todo-snapshot",
		parentId: null,
		timestamp: "2026-08-25T02:00:00.000Z",
		customType: TODO_SNAPSHOT_CUSTOM_TYPE,
		data: {
			schema: TODO_SNAPSHOT_SCHEMA,
			todos,
			capturedAt: Date.UTC(2026, 7, 25, 2),
		},
	};
}

function createContext(entries: SessionEntry[], branchEntries: SessionEntry[]): ExtensionContext {
	return {
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => branchEntries,
		} as ExtensionContext["sessionManager"],
	} as ExtensionContext;
}

function createRestoreApi(messages: RestoreMessage[]): ExtensionAPI {
	return {
		sendMessage(message: RestoreMessage) {
			messages.push(message);
		},
	} as ExtensionAPI;
}

function containsHistoryEnvelope(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsHistoryEnvelope);
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return "customType" in record || Object.values(record).some(containsHistoryEnvelope);
}

describe("compaction todo bridge current-state snapshots", () => {
	const latestPhases: TodoPhase[] = [
		{
			name: "Repair",
			tasks: [{ content: "Ship bounded snapshot", status: "in_progress" }],
		},
	];
	const historicalEntries = Array.from({ length: 80 }, (_, index) =>
		createStateEntry(
			index,
			index === 79
				? latestPhases
				: [
						{
							name: `History ${index}`,
							tasks: [{ content: `Superseded task ${index}`, status: "completed" }],
						},
					],
		),
	);

	describe("Given eighty historical todo-state entries on the active branch", () => {
		it("Then createTodoSnapshot captures only the latest current phases", () => {
			const ctx = createContext(historicalEntries, historicalEntries);

			const snapshot = createTodoSnapshot(ctx);

			expect(snapshot.todos).toEqual(latestPhases);
			expect(containsHistoryEnvelope(snapshot.todos)).toBe(false);
			expect(JSON.stringify(snapshot.todos).length).toBe(JSON.stringify(latestPhases).length);
		});
	});

	describe("Given stale todo history outside an active branch with no current todos", () => {
		it("Then stale entries do not suppress restoration from a bounded snapshot", () => {
			const snapshotEntry = createSnapshotEntry(latestPhases);
			const messages: RestoreMessage[] = [];
			const ctx = createContext([...historicalEntries, snapshotEntry], [snapshotEntry]);

			restoreTodosIfMissing(createRestoreApi(messages), ctx);

			expect(messages).toHaveLength(1);
			expect(messages[0]?.details?.todos).toEqual(latestPhases);
			expect(containsHistoryEnvelope(messages[0]?.details?.todos)).toBe(false);
		});
	});

	describe("Given a legacy snapshot containing raw historical session entries", () => {
		it("Then restore normalizes it to the latest phases before reinjection", () => {
			const legacySnapshotEntry = createSnapshotEntry(historicalEntries);
			const messages: RestoreMessage[] = [];
			const ctx = createContext([legacySnapshotEntry], [legacySnapshotEntry]);

			restoreTodosIfMissing(createRestoreApi(messages), ctx);

			expect(messages).toHaveLength(1);
			expect(messages[0]?.details?.todos).toEqual(latestPhases);
			expect(containsHistoryEnvelope(messages[0]?.details?.todos)).toBe(false);
			expect(messages[0]?.content).not.toContain("senpi.todo-state");
		});
	});
});
