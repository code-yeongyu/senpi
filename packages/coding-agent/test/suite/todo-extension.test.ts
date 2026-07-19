import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	getLatestPhasesFromBranchEntries,
	getTodoWidgetLines,
	TODO_STATE_ENTRY_TYPE,
	type TodoPhase,
} from "../../src/core/extensions/builtin/todotools/state.ts";
import {
	phaseRomanNumeral,
	registerTodoTool,
	TODO_PARAMS_SCHEMA,
} from "../../src/core/extensions/builtin/todotools/tools/todo.ts";
import { discoverAndLoadExtensions } from "../../src/core/extensions/loader.ts";
import type { ExtensionAPI, ToolDefinition, ToolRenderContext } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createTestResourceLoader, userMsg } from "../utilities.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

const TODO_EXTENSION_PATH = fileURLToPath(
	new URL("../../src/core/extensions/builtin/todotools/index.ts", import.meta.url),
);
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
type TodoParams = Static<typeof TODO_PARAMS_SCHEMA>;

beforeAll(() => initTheme("dark"));

async function createHarnessWithTodoExtension(options: { persistSession?: boolean } = {}): Promise<Harness> {
	const extensionsResult = await discoverAndLoadExtensions([TODO_EXTENSION_PATH], REPO_ROOT, REPO_ROOT);
	return createHarness({
		persistSession: options.persistSession,
		resourceLoader: createTestResourceLoader({ extensionsResult }),
	});
}

function getLatestTodoResult(harness: Harness) {
	const results = harness.session.messages.filter(
		(message) => message.role === "toolResult" && message.toolName === "todo",
	);
	const result = results[results.length - 1];
	if (result?.role !== "toolResult") throw new Error("Expected a todo tool result");
	return result;
}

function responsesForTodo(params: Record<string, unknown>, finalText = "done") {
	return [
		fauxAssistantMessage([fauxToolCall("todo", params)], { stopReason: "toolUse" }),
		fauxAssistantMessage(finalText),
	];
}

function phasesFromResult(result: { details?: unknown }): TodoPhase[] {
	const details = result.details;
	if (typeof details !== "object" || details === null || !("phases" in details) || !Array.isArray(details.phases)) {
		throw new Error("Expected phased todo details");
	}
	return details.phases as TodoPhase[];
}

async function captureTodoTool(): Promise<ToolDefinition<typeof TODO_PARAMS_SCHEMA>> {
	let capturedTool: ToolDefinition<typeof TODO_PARAMS_SCHEMA> | undefined;
	const mockPi = {
		registerTool(tool: ToolDefinition<typeof TODO_PARAMS_SCHEMA>) {
			capturedTool = tool;
		},
		appendEntry() {},
	} as Pick<ExtensionAPI, "registerTool" | "appendEntry"> as ExtensionAPI;

	registerTodoTool(mockPi, {
		getCurrentPhases: () => [],
		setCurrentPhases: () => {},
		syncWidget: () => {},
	});
	if (!capturedTool) throw new Error("Expected todo tool to be registered");
	return capturedTool;
}

describe("todo extension", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("initializes multi-phase and flattened lists with automatic promotion", async () => {
		// Given a fresh session and a phased init request
		const harness = await createHarnessWithTodoExtension();
		harnesses.push(harness);
		harness.setResponses(
			responsesForTodo({
				op: "init",
				list: [
					{ phase: "Foundation", items: ["Scaffold workspace", "Wire entrypoint"] },
					{ phase: "Verification", items: ["Run focused tests"] },
				],
			}),
		);

		// When the agent applies the init operation
		await harness.session.prompt("initialize the plan");

		// Then the earliest task is active and the v2 state entry is persisted
		const result = getLatestTodoResult(harness);
		expect(phasesFromResult(result)).toEqual([
			{
				name: "Foundation",
				tasks: [
					{ content: "Scaffold workspace", status: "in_progress" },
					{ content: "Wire entrypoint", status: "pending" },
				],
			},
			{ name: "Verification", tasks: [{ content: "Run focused tests", status: "pending" }] },
		]);
		expect(getAssistantTexts(harness)).toContain("done");
		const stateEntry = harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "custom" && entry.customType === TODO_STATE_ENTRY_TYPE);
		expect(stateEntry?.type === "custom" ? stateEntry.data : undefined).toEqual({
			schema: "v2",
			phases: phasesFromResult(result),
		});

		// When a flat init is applied afterwards
		harness.setResponses(responsesForTodo({ op: "init", items: ["Single phase task"] }));
		await harness.session.prompt("replace with one phase");

		// Then the compatibility shape becomes the Tasks phase
		expect(phasesFromResult(getLatestTodoResult(harness))).toEqual([
			{ name: "Tasks", tasks: [{ content: "Single phase task", status: "in_progress" }] },
		]);
	});

	it("start demotes the previous active task", async () => {
		// Given two pending tasks
		const harness = await createHarnessWithTodoExtension();
		harnesses.push(harness);
		harness.setResponses([
			...responsesForTodo({ op: "init", items: ["First task", "Second task"] }),
			...responsesForTodo({ op: "start", task: "Second task" }),
		]);

		// When the second task is started
		await harness.session.prompt("initialize");
		await harness.session.prompt("switch task");

		// Then only the requested task is in progress
		expect(phasesFromResult(getLatestTodoResult(harness))).toEqual([
			{
				name: "Tasks",
				tasks: [
					{ content: "First task", status: "pending" },
					{ content: "Second task", status: "in_progress" },
				],
			},
		]);
	});

	it("done supports task and phase targets and promotes the earliest open task", async () => {
		// Given work completed out of phase order
		const harness = await createHarnessWithTodoExtension();
		harnesses.push(harness);
		harness.setResponses([
			...responsesForTodo({
				op: "init",
				list: [
					{ phase: "Foundation", items: ["Build core", "Add edge cases"] },
					{ phase: "Verification", items: ["Run tests", "Write docs"] },
				],
			}),
			...responsesForTodo({ op: "done", phase: "Verification" }),
			...responsesForTodo({ op: "done", task: "Build core" }),
		]);

		// When the later phase and then the first task are completed
		await harness.session.prompt("init");
		await harness.session.prompt("complete verification");
		const afterPhase = phasesFromResult(getLatestTodoResult(harness));
		await harness.session.prompt("complete core");

		// Then promotion moves backward to Foundation, then advances within it
		expect(afterPhase).toEqual([
			{
				name: "Foundation",
				tasks: [
					{ content: "Build core", status: "in_progress" },
					{ content: "Add edge cases", status: "pending" },
				],
			},
			{
				name: "Verification",
				tasks: [
					{ content: "Run tests", status: "completed" },
					{ content: "Write docs", status: "completed" },
				],
			},
		]);
		expect(phasesFromResult(getLatestTodoResult(harness))[0]?.tasks).toEqual([
			{ content: "Build core", status: "completed" },
			{ content: "Add edge cases", status: "in_progress" },
		]);
	});

	it("drop marks tasks abandoned and append lazily creates a phase", async () => {
		// Given one active task
		const harness = await createHarnessWithTodoExtension();
		harnesses.push(harness);
		harness.setResponses([
			...responsesForTodo({ op: "init", items: ["Blocked work"] }),
			...responsesForTodo({ op: "drop", task: "Blocked work" }),
			...responsesForTodo({ op: "append", phase: "Follow-up", items: ["New work"] }),
		]);

		// When the task is abandoned and a missing phase receives a task
		await harness.session.prompt("init");
		await harness.session.prompt("drop");
		await harness.session.prompt("append");

		// Then the abandoned status is retained and the new task is promoted
		expect(phasesFromResult(getLatestTodoResult(harness))).toEqual([
			{ name: "Tasks", tasks: [{ content: "Blocked work", status: "abandoned" }] },
			{ name: "Follow-up", tasks: [{ content: "New work", status: "in_progress" }] },
		]);
	});

	it("rm removes a task, a phase's tasks, and all tasks", async () => {
		// Given two phases with distinct tasks
		const harness = await createHarnessWithTodoExtension();
		harnesses.push(harness);
		harness.setResponses([
			...responsesForTodo({
				op: "init",
				list: [
					{ phase: "One", items: ["Keep", "Remove me"] },
					{ phase: "Two", items: ["Clear phase"] },
				],
			}),
			...responsesForTodo({ op: "rm", task: "Remove me" }),
			...responsesForTodo({ op: "rm", phase: "Two" }),
			...responsesForTodo({ op: "rm" }),
		]);

		// When each rm target is applied
		await harness.session.prompt("init");
		await harness.session.prompt("remove task");
		expect(phasesFromResult(getLatestTodoResult(harness))[0]?.tasks).toEqual([
			{ content: "Keep", status: "in_progress" },
		]);
		await harness.session.prompt("clear phase");
		await harness.session.prompt("clear all");

		// Then all phase containers remain but contain no tasks
		expect(phasesFromResult(getLatestTodoResult(harness))).toEqual([
			{ name: "One", tasks: [] },
			{ name: "Two", tasks: [] },
		]);
	});

	it("view is read-only and does not write a session entry", async () => {
		// Given an initialized list
		const harness = await createHarnessWithTodoExtension();
		harnesses.push(harness);
		harness.setResponses([
			...responsesForTodo({ op: "init", items: ["Inspect state"] }),
			...responsesForTodo({ op: "view" }),
		]);

		// When the list is viewed
		await harness.session.prompt("init");
		const entriesBeforeView = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === TODO_STATE_ENTRY_TYPE).length;
		await harness.session.prompt("view");

		// Then state is echoed without another persisted snapshot
		const result = getLatestTodoResult(harness);
		expect(result.isError).not.toBe(true);
		expect(phasesFromResult(result)).toEqual([
			{ name: "Tasks", tasks: [{ content: "Inspect state", status: "in_progress" }] },
		]);
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === TODO_STATE_ENTRY_TYPE),
		).toHaveLength(entriesBeforeView);
	});

	it.each([
		{ op: "done", task: "Unknown task" },
		{ op: "done", phase: "Unknown phase" },
	])("rejects $op targets atomically", async (params) => {
		// Given a persisted list and a target that cannot resolve
		const harness = await createHarnessWithTodoExtension();
		harnesses.push(harness);
		harness.setResponses([...responsesForTodo({ op: "init", items: ["Stable task"] }), ...responsesForTodo(params)]);

		// When the invalid operation runs
		await harness.session.prompt("init");
		const stateEntriesBeforeFailure = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === TODO_STATE_ENTRY_TYPE).length;
		await harness.session.prompt("invalid update");

		// Then the result is an error and both memory and session state stay unchanged
		const result = getLatestTodoResult(harness);
		expect(result.content.some((content) => content.type === "text" && content.text.includes("Errors:"))).toBe(true);
		expect(phasesFromResult(result)).toEqual([
			{ name: "Tasks", tasks: [{ content: "Stable task", status: "in_progress" }] },
		]);
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === TODO_STATE_ENTRY_TYPE),
		).toHaveLength(stateEntriesBeforeFailure);
	});

	it("rejects an init containing an empty phase atomically", async () => {
		// Given a valid persisted list
		const harness = await createHarnessWithTodoExtension();
		harnesses.push(harness);
		harness.setResponses([
			...responsesForTodo({ op: "init", items: ["Keep me"] }),
			...responsesForTodo({
				op: "init",
				list: [
					{ phase: "Filled", items: ["New task"] },
					{ phase: "Empty", items: [] },
				],
			}),
			...responsesForTodo({ op: "view" }),
		]);

		// When an init carrying an empty nested phase is applied
		await harness.session.prompt("init");
		const stateEntriesBefore = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === TODO_STATE_ENTRY_TYPE).length;
		await harness.session.prompt("invalid init");
		const failedResult = getLatestTodoResult(harness);

		// Then the batch is rejected wholesale and nothing new is persisted
		expect(failedResult.isError).toBe(true);
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === TODO_STATE_ENTRY_TYPE),
		).toHaveLength(stateEntriesBefore);

		// And the previous list is fully intact
		await harness.session.prompt("view");
		expect(phasesFromResult(getLatestTodoResult(harness))).toEqual([
			{ name: "Tasks", tasks: [{ content: "Keep me", status: "in_progress" }] },
		]);
	});

	it("moves the in_progress pointer back to an earlier phase after out-of-order completion", async () => {
		// Given two phases where the later phase's task was started out of order
		const harness = await createHarnessWithTodoExtension();
		harnesses.push(harness);
		harness.setResponses([
			...responsesForTodo({
				op: "init",
				list: [
					{ phase: "Foundation", items: ["Lay groundwork", "Wire modules"] },
					{ phase: "Verification", items: ["Run suite"] },
				],
			}),
			...responsesForTodo({ op: "start", task: "Run suite" }),
			...responsesForTodo({ op: "done", task: "Run suite" }),
		]);

		// When the out-of-order task completes
		await harness.session.prompt("init");
		await harness.session.prompt("start later phase");
		await harness.session.prompt("finish later phase");

		// Then the pointer auto-promotes BACK to the earliest open task in phase 1
		expect(phasesFromResult(getLatestTodoResult(harness))).toEqual([
			{
				name: "Foundation",
				tasks: [
					{ content: "Lay groundwork", status: "in_progress" },
					{ content: "Wire modules", status: "pending" },
				],
			},
			{ name: "Verification", tasks: [{ content: "Run suite", status: "completed" }] },
		]);
	});

	it("view performs no normalization and no write even on invalid persisted state", async () => {
		// Given persisted state that illegally carries two in_progress tasks
		const invalidPhases: TodoPhase[] = [
			{
				name: "Tasks",
				tasks: [
					{ content: "First", status: "in_progress" },
					{ content: "Second", status: "in_progress" },
				],
			},
		];
		const setCalls: TodoPhase[][] = [];
		let appendCalls = 0;
		let capturedTool: ToolDefinition<typeof TODO_PARAMS_SCHEMA> | undefined;
		const mockPi = {
			registerTool(tool: ToolDefinition<typeof TODO_PARAMS_SCHEMA>) {
				capturedTool = tool;
			},
			appendEntry() {
				appendCalls += 1;
			},
		} as Pick<ExtensionAPI, "registerTool" | "appendEntry"> as ExtensionAPI;
		registerTodoTool(mockPi, {
			getCurrentPhases: () => invalidPhases,
			setCurrentPhases: (phases) => {
				setCalls.push(phases);
			},
			syncWidget: () => {},
		});
		if (!capturedTool?.execute) throw new Error("Expected todo tool with execute");
		const ctx = { sessionManager: { getSessionFile: () => undefined } } as unknown as Parameters<
			NonNullable<ToolDefinition<typeof TODO_PARAMS_SCHEMA>["execute"]>
		>[4];

		// When view runs against the invalid state
		const result = await capturedTool.execute("view-call", { op: "view" }, undefined as never, undefined, ctx);

		// Then both in_progress rows are echoed untouched and nothing is written
		const details = result.details as { phases?: TodoPhase[] } | undefined;
		expect(details?.phases).toEqual(invalidPhases);
		expect(setCalls).toHaveLength(0);
		expect(appendCalls).toBe(0);
	});

	it("round-trips phased state through session entries", async () => {
		// Given a file-backed session
		const harness = await createHarnessWithTodoExtension({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses(responsesForTodo({ op: "init", list: [{ phase: "Persisted", items: ["Reload me"] }] }));

		// When the todo state is written
		await harness.session.prompt("persist");

		// Then the branch scanner reconstructs the same phases
		expect(getLatestPhasesFromBranchEntries(harness.sessionManager.getBranch())).toEqual([
			{ name: "Persisted", tasks: [{ content: "Reload me", status: "in_progress" }] },
		]);
		expect(harness.sessionManager.getSessionFile()).toBeDefined();
	});

	it("preserves legacy todos with non-canonical statuses as pending", () => {
		// Given a legacy flat entry carrying a status outside the v2 allowlist
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(userMsg("legacy"));
		sessionManager.appendCustomEntry(TODO_STATE_ENTRY_TYPE, {
			todos: [
				{ content: "Old blocked", status: "blocked", priority: "high" },
				{ content: "Old done", status: "completed", priority: "low" },
			],
		});

		// When the branch state is read
		const phases = getLatestPhasesFromBranchEntries(sessionManager.getBranch());

		// Then the unknown status survives migration as open (pending) work
		expect(phases).toEqual([
			{
				name: "Tasks",
				tasks: [
					{ content: "Old blocked", status: "pending" },
					{ content: "Old done", status: "completed" },
				],
			},
		]);
	});

	it("migrates legacy flat todos and cancelled status", () => {
		// Given a legacy flat state entry
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(userMsg("legacy"));
		sessionManager.appendCustomEntry(TODO_STATE_ENTRY_TYPE, {
			todos: [
				{ content: "Old completed", status: "completed", priority: "high" },
				{ content: "Old cancelled", status: "cancelled", priority: "low" },
			],
		});

		// When the branch state is read
		const phases = getLatestPhasesFromBranchEntries(sessionManager.getBranch());

		// Then the old list is represented as one v2-compatible phase
		expect(phases).toEqual([
			{
				name: "Tasks",
				tasks: [
					{ content: "Old completed", status: "completed" },
					{ content: "Old cancelled", status: "abandoned" },
				],
			},
		]);
	});

	it("builds a phase-aware sidebar and roman numerals", () => {
		// Given an active phase and a closed successor
		const phases: TodoPhase[] = [
			{
				name: "Foundation",
				tasks: [
					{ content: "Active task", status: "in_progress" },
					{ content: "Queued task", status: "pending" },
				],
			},
			{ name: "Auth", tasks: [{ content: "Done task", status: "completed" }] },
		];

		// When the sidebar is built
		const lines = getTodoWidgetLines(phases);

		// Then only the active phase is shown and numbering is stable
		expect(lines).toEqual(["Todo", "Foundation", "[•] Active task", "[ ] Queued task"]);
		expect(phaseRomanNumeral(1)).toBe("I");
		expect(phaseRomanNumeral(4)).toBe("IV");
		expect(phaseRomanNumeral(42)).toBe("XLII");
		expect(
			getTodoWidgetLines([{ name: "Done", tasks: [{ content: "Closed", status: "completed" }] }]),
		).toBeUndefined();
	});

	it("renders compact calls and a static phase tree with collapsed closed phases", async () => {
		const tool = await captureTodoTool();
		if (!tool.renderCall || !tool.renderResult) throw new Error("Expected todo renderers");

		const args: TodoParams = {
			op: "done",
			task: "Build core",
		};
		const context: ToolRenderContext<unknown, TodoParams> = {
			args,
			toolCallId: "todo-render",
			invalidate: () => {},
			lastComponent: undefined,
			state: undefined,
			cwd: REPO_ROOT,
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			expanded: false,
			showImages: false,
			isError: false,
		};
		const callText = stripAnsi(tool.renderCall(args, theme, context).render(160).join("\n"));
		expect(callText).toContain("todo done: Build core");

		const phases: TodoPhase[] = [
			{
				name: "Foundation",
				tasks: [
					{ content: "Build core", status: "completed" },
					{ content: "Wire entrypoint", status: "completed" },
				],
			},
			{ name: "Auth", tasks: [{ content: "Configure auth", status: "completed" }] },
			{ name: "Verification", tasks: [{ content: "Run checks", status: "pending" }] },
		];
		const resultComponent = tool.renderResult(
			{
				content: [{ type: "text", text: "summary" }],
				details: {
					op: "done",
					phases,
					storage: "memory",
					completedTasks: [{ phase: "Foundation", content: "Build core" }],
				},
			},
			{ expanded: false, isPartial: false },
			theme,
			context,
		);
		const rendered = stripAnsi(resultComponent.render(160).join("\n"));

		expect(rendered).toContain("I. Foundation");
		expect(rendered).toContain("[✓] Build core");
		expect(rendered).toContain("II. Auth — 1/1 done");
		expect(rendered).toContain("III. Verification");
		expect(rendered).toContain("[ ] Run checks");
	});

	it("registers exactly one todo tool with the op schema", async () => {
		// Given the builtin registration helper
		const tool = await captureTodoTool();

		// Then the old pair is replaced by one named tool
		expect(tool.name).toBe("todo");
		expect(tool.parameters).toBe(TODO_PARAMS_SCHEMA);
		expect(tool.description).toContain("auto-promotes");
	});
});
