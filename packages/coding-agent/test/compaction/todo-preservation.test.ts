import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	captureTodoSnapshot,
	findTodoEntries,
	restoreTodosIfMissing,
	type TodoEntry,
} from "../../src/core/extensions/builtin/compaction/todo-bridge.ts";
import type { TodoPhase } from "../../src/core/extensions/builtin/todotools/state.ts";
import {
	type CustomEntry,
	migrateSessionEntries,
	parseSessionEntries,
	type SessionEntry,
} from "../../src/core/session-manager.ts";

const TODO_SNAPSHOT_CUSTOM_TYPE = "compaction.todo-snapshot";

interface FutureTodoEntry extends TodoEntry {
	content: string;
	status: "pending" | "in_progress" | "completed";
}

interface FutureRestoreResult {
	applied: boolean;
	restoredTodos: FutureTodoEntry[];
}

interface AppendCall<T = unknown> {
	customType: string;
	data: T;
}

interface FakePi {
	appendCalls: AppendCall[];
	appendEntry: <T = unknown>(customType: string, data?: T) => void;
}

function createFakePi(): FakePi {
	const appendCalls: AppendCall[] = [];
	return {
		appendCalls,
		appendEntry<T>(customType: string, data?: T) {
			appendCalls.push({ customType, data: data as unknown });
		},
	};
}

type CaptureTodoSnapshotFn = (
	currentTodos: FutureTodoEntry[],
	pi: Pick<FakePi, "appendEntry">,
	branchId?: string,
) => void;
type RestoreTodosIfMissingFn = (
	snapshot: FutureTodoEntry[],
	currentTodos: FutureTodoEntry[],
	pi: Pick<FakePi, "appendEntry">,
) => FutureRestoreResult;
type FindTodoEntriesFn = (entries: SessionEntry[], options?: { branchId?: string }) => FutureTodoEntry[];

const captureTodoSnapshotFuture = captureTodoSnapshot as unknown as CaptureTodoSnapshotFn;
const restoreTodosIfMissingFuture = restoreTodosIfMissing as unknown as RestoreTodosIfMissingFn;
const findTodoEntriesFuture = findTodoEntries as unknown as FindTodoEntriesFn;

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

let todoFixtureEntries: SessionEntry[] = [];
let preCompactionTodos: FutureTodoEntry[] = [];
let postCompactionTodos: FutureTodoEntry[] = [];
const phasedTodos: TodoPhase[] = [
	{
		name: "Foundation",
		tasks: [
			{ content: "Keep content-keyed task", status: "completed" },
			{ content: "Restore active task", status: "in_progress" },
		],
	},
	{
		name: "Verification",
		tasks: [{ content: "Run deterministic checks", status: "pending" }],
	},
];

beforeAll(() => {
	const fixturePath = join(__dirname, "..", "fixtures", "compaction", "todo-preservation", "todos-then-compact.jsonl");
	const content = readFileSync(fixturePath, "utf-8");
	const entries = parseSessionEntries(content);
	migrateSessionEntries(entries);
	todoFixtureEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");

	const customTodoEntries = todoFixtureEntries.filter(
		(entry): entry is CustomEntry => entry.type === "custom" && entry.customType === "todo-list",
	);
	const todoListsFromFixture = customTodoEntries.map((entry) => (entry.data as { todos: FutureTodoEntry[] }).todos);
	preCompactionTodos = todoListsFromFixture[0] ?? [];
	postCompactionTodos = todoListsFromFixture[todoListsFromFixture.length - 1] ?? [];
});

describe("compaction todo preservation", () => {
	describe("Given a session with active todos sourced from the op-based todo builtin (4 todos, 1 completed, 1 in_progress)", () => {
		describe("When session_before_compact fires and captureTodoSnapshot persists via pi.appendEntry", () => {
			it("Then pi.appendEntry is called with 'compaction.todo-snapshot' carrying the full todo array", () => {
				const registration = registerFauxProvider();
				registrations.push(registration);
				expect(preCompactionTodos.length).toBe(4);

				const pi = createFakePi();
				captureTodoSnapshotFuture(preCompactionTodos, pi);

				const snapshotCall = pi.appendCalls.find((call) => call.customType === TODO_SNAPSHOT_CUSTOM_TYPE);
				expect(snapshotCall).toBeDefined();
				const data = snapshotCall?.data as { todos: FutureTodoEntry[] } | undefined;
				expect(data?.todos).toEqual(preCompactionTodos);
				expect(data?.todos[0].id).toBe("todo-1");
				expect(data?.todos[1].status).toBe("in_progress");
			});
		});

		describe("When a phased todo payload is captured", () => {
			it("Then the compaction snapshot carries phases without requiring generated IDs", () => {
				const pi = createFakePi();
				captureTodoSnapshot(phasedTodos, pi);

				const snapshotCall = pi.appendCalls.find((call) => call.customType === TODO_SNAPSHOT_CUSTOM_TYPE);
				const data = snapshotCall?.data as { todos: TodoPhase[] } | undefined;
				expect(data?.todos).toEqual(phasedTodos);
				expect(data?.todos[0]?.tasks[1]?.content).toBe("Restore active task");
			});
		});
	});

	describe("Given a todo snapshot was captured and the post-compaction current state has no todos", () => {
		describe("When session_compact completes and before_agent_start triggers restoreTodosIfMissing", () => {
			it("Then the snapshot is applied and the missing todos are restored verbatim", () => {
				const pi = createFakePi();
				const currentEmpty: FutureTodoEntry[] = [];

				const result = restoreTodosIfMissingFuture(preCompactionTodos, currentEmpty, pi);

				expect(result.applied).toBe(true);
				expect(result.restoredTodos).toEqual(preCompactionTodos);
				expect(result.restoredTodos.map((todo) => todo.id)).toEqual(["todo-1", "todo-2", "todo-3", "todo-4"]);
			});
		});

		describe("When a phased snapshot is restored into an empty phased state", () => {
			it("Then the phase payload is re-injected verbatim", () => {
				const pi = createFakePi();
				const currentEmpty: TodoPhase[] = [];
				const result = restoreTodosIfMissing(phasedTodos, currentEmpty, pi);

				expect(result.applied).toBe(true);
				expect(result.restoredTodos).toEqual(phasedTodos);
			});
		});
	});

	describe("Given the post-compaction current state already contains todos", () => {
		describe("When restoreTodosIfMissing runs against a non-empty current todo list", () => {
			it("Then the snapshot is NOT applied and current state wins", () => {
				const pi = createFakePi();

				const result = restoreTodosIfMissingFuture(preCompactionTodos, postCompactionTodos, pi);

				expect(result.applied).toBe(false);
				expect(result.restoredTodos).toEqual(postCompactionTodos);
			});
		});
	});

	describe("Given branch navigation through compaction with two branches each carrying distinct todos", () => {
		describe("When findTodoEntries runs with the active branch's branchId", () => {
			it("Then todos from the CORRECT branch are returned, never the parent or sibling branch's", () => {
				const branchAEntry: CustomEntry = {
					type: "custom",
					id: "branch-a-todos",
					parentId: "branch-a-root",
					timestamp: "2025-01-15T17:01:00.000Z",
					customType: "todo-list",
					data: {
						todos: [{ id: "branch-a-todo-1", content: "Branch A unique work", status: "pending" }],
					},
				};
				const branchBEntry: CustomEntry = {
					type: "custom",
					id: "branch-b-todos",
					parentId: "branch-b-root",
					timestamp: "2025-01-15T17:02:00.000Z",
					customType: "todo-list",
					data: {
						todos: [{ id: "branch-b-todo-1", content: "Branch B unique work", status: "in_progress" }],
					},
				};

				const restoredFromB = findTodoEntriesFuture([branchAEntry, branchBEntry], {
					branchId: "branch-b-root",
				});

				expect(restoredFromB.map((todo) => todo.id)).toEqual(["branch-b-todo-1"]);
				expect(restoredFromB.find((todo) => todo.id === "branch-a-todo-1")).toBeUndefined();
			});
		});

		describe("When a v2 senpi.todo-state entry is read", () => {
			it("Then content-keyed phase tasks are available to the compaction bridge", () => {
				const stateEntry: CustomEntry = {
					type: "custom",
					id: "state-phases",
					parentId: "phase-root",
					timestamp: "2025-01-15T17:03:00.000Z",
					customType: "senpi.todo-state",
					data: { schema: "v2", phases: phasedTodos },
				};

				const restored = findTodoEntriesFuture([stateEntry], { branchId: "phase-root" });

				expect(restored.map((todo) => todo.content)).toEqual([
					"Keep content-keyed task",
					"Restore active task",
					"Run deterministic checks",
				]);
				expect(restored.every((todo) => todo.id === undefined)).toBe(true);
			});
		});
	});

	describe("Given todo IDs that existed before compaction (todo-1 .. todo-4)", () => {
		describe("When a new todo-list custom entry is appended after compaction with the same IDs", () => {
			it("Then the post-compaction IDs match the snapshot IDs and continuity is preserved", () => {
				const snapshotIds = preCompactionTodos.map((todo) => todo.id);
				const postIds = postCompactionTodos.map((todo) => todo.id);

				expect(postIds).toEqual(snapshotIds);
				expect(snapshotIds).toEqual(["todo-1", "todo-2", "todo-3", "todo-4"]);

				const pi = createFakePi();
				captureTodoSnapshotFuture(preCompactionTodos, pi);
				const snapshotCall = pi.appendCalls.find((call) => call.customType === TODO_SNAPSHOT_CUSTOM_TYPE);
				const persistedIds = (snapshotCall?.data as { todos: FutureTodoEntry[] } | undefined)?.todos.map(
					(todo) => todo.id,
				);
				expect(persistedIds).toEqual(snapshotIds);
			});
		});
	});
});
