import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAndLoadExtensions } from "../../src/core/extensions/loader.js";
import type { ExtensionAPI, ToolDefinition } from "../../src/core/extensions/types.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { assistantMsg, createTestResourceLoader, userMsg } from "../utilities.js";
import { createHarness, getAssistantTexts, type Harness } from "./harness.js";

const TODOWRITE_EXTENSION_PATH = fileURLToPath(
	new URL("../../src/core/extensions/builtin/todotools/index.ts", import.meta.url),
);
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

async function createHarnessWithTodoExtension(): Promise<Harness> {
	const extensionsResult = await discoverAndLoadExtensions([TODOWRITE_EXTENSION_PATH], REPO_ROOT, REPO_ROOT);
	return createHarness({ resourceLoader: createTestResourceLoader({ extensionsResult }) });
}

async function loadTodoExtensionModule() {
	return import(TODOWRITE_EXTENSION_PATH);
}

async function captureTodoWriteToolDefinition() {
	const { registerTodoWriteTool } = await import("../../src/core/extensions/builtin/todotools/tools/todowrite.js");
	let capturedTool: ToolDefinition | undefined;

	const mockPi = {
		registerTool(tool: ToolDefinition) {
			capturedTool = tool;
		},
		appendEntry() {},
	} as Pick<ExtensionAPI, "registerTool" | "appendEntry"> as ExtensionAPI;

	registerTodoWriteTool(mockPi, {
		getCurrentTodos: () => [],
		setCurrentTodos: () => {},
		syncWidget: () => {},
	});

	if (!capturedTool) {
		throw new Error("Expected todowrite tool to be registered");
	}

	return capturedTool;
}

function getLatestToolResult(harness: Harness, toolName: "todowrite" | "todoread") {
	const results = harness.session.messages.filter(
		(message) => message.role === "toolResult" && message.toolName === toolName,
	);
	const latest = results[results.length - 1];
	if (!latest || latest.role !== "toolResult") {
		throw new Error(`Expected a ${toolName} tool result`);
	}
	return latest;
}

describe("todowrite extension", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("stores the complete todo list and returns JSON output", async () => {
		// given
		const harness = await createHarnessWithTodoExtension();
		harnesses.push(harness);
		const todos = [
			{ content: "Inspect auth flow", status: "in_progress", priority: "high" },
			{ content: "Run regression tests", status: "pending", priority: "medium" },
		];
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("todowrite", { todos })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		// when
		await harness.session.prompt("start work");

		// then
		const result = getLatestToolResult(harness, "todowrite");
		expect(result.details).toEqual({ todos });
		expect(result.content).toEqual([
			{
				type: "text",
				text: JSON.stringify(todos, null, 2),
			},
		]);
		expect(getAssistantTexts(harness)).toContain("done");
	});

	it("replaces the entire todo list instead of merging entries", async () => {
		// given
		const harness = await createHarnessWithTodoExtension();
		harnesses.push(harness);
		const firstTodos = [
			{ content: "Initial task", status: "in_progress", priority: "high" },
			{ content: "Old task", status: "pending", priority: "low" },
		];
		const secondTodos = [{ content: "Replacement task", status: "pending", priority: "medium" }];
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("todowrite", { todos: firstTodos })], { stopReason: "toolUse" }),
			fauxAssistantMessage("first pass done"),
			fauxAssistantMessage([fauxToolCall("todowrite", { todos: secondTodos })], { stopReason: "toolUse" }),
			fauxAssistantMessage("second pass done"),
		]);

		// when
		await harness.session.prompt("first pass");
		await harness.session.prompt("second pass");

		// then
		const result = getLatestToolResult(harness, "todowrite");
		expect(result.details).toEqual({ todos: secondTodos });
		expect(result.content).toEqual([
			{
				type: "text",
				text: JSON.stringify(secondTodos, null, 2),
			},
		]);
	});

	it("rejects replacing the todo list with an empty array", async () => {
		// given
		const harness = await createHarnessWithTodoExtension();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("todowrite", { todos: [] })], { stopReason: "toolUse" }),
			fauxAssistantMessage("validation failed"),
		]);

		// when
		await harness.session.prompt("clear todos");

		// then
		const result = getLatestToolResult(harness, "todowrite");
		expect(result.isError).toBe(true);
		const text = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("\n");
		expect(text).toContain('Validation failed for tool "todowrite"');
		expect(text).toContain("must NOT have fewer than 1 items");
	});

	it("reads the latest todos through the agent-facing todoread tool", async () => {
		// given
		const harness = await createHarnessWithTodoExtension();
		harnesses.push(harness);
		const todos = [
			{ content: "Inspect session flow", status: "in_progress", priority: "high" },
			{ content: "Document behavior", status: "cancelled", priority: "low" },
		];
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("todowrite", { todos })], { stopReason: "toolUse" }),
			fauxAssistantMessage("saved"),
			fauxAssistantMessage([fauxToolCall("todoread", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("read"),
		]);

		// when
		await harness.session.prompt("save todos");
		await harness.session.prompt("read todos");

		// then
		const result = getLatestToolResult(harness, "todoread");
		expect(result.details).toEqual({ todos });
		expect(result.content).toEqual([
			{
				type: "text",
				text: JSON.stringify(todos, null, 2),
			},
		]);
	});

	it("builds sidebar widget lines from the current todo state", async () => {
		// given
		const { getTodoResultLines, getTodoWidgetLines } = await loadTodoExtensionModule();
		const todos = [
			{ content: "Active task", status: "in_progress", priority: "high" },
			{ content: "Done task", status: "completed", priority: "low" },
			{ content: "Queued task", status: "pending", priority: "medium" },
		];

		// when
		const lines = getTodoWidgetLines(todos);

		// then
		expect(lines).toEqual(["Todo", "[•] Active task", "[✓] Done task", "[ ] Queued task"]);
		expect(getTodoResultLines(todos)).toEqual(["2 todos", "[•] Active task", "[✓] Done task", "[ ] Queued task"]);
	});

	it("sanitizes todo widget output before rendering", async () => {
		// given
		const { getTodoWidgetLines } = await loadTodoExtensionModule();
		const todos = [{ content: "Unsafe\u001b[31m text\nnext line", status: "pending", priority: "high" }];

		// when
		const lines = getTodoWidgetLines(todos);

		// then
		expect(lines).toEqual(["Todo", "[ ] Unsafe text next line"]);
	});

	it("registers workflow-first prompt guidance for all tasks", async () => {
		// given
		const tool = await captureTodoWriteToolDefinition();

		// then
		expect(tool.promptSnippet).toContain("MANDATORY for ALL tasks");
		expect(tool.promptSnippet).toContain("EXPLORE -> DEFINE -> PLAN -> TODO -> EXECUTE");
		expect(tool.promptGuidelines).toContain(
			"Create todos for EVERY task. No 'trivial task' exemptions. Follow EXPLORE -> DEFINE -> PLAN -> TODO -> EXECUTE workflow always.",
		);
	});

	it("reconstructs todo state from branch-specific custom entries", async () => {
		// given
		const { TODO_STATE_ENTRY_TYPE, getLatestTodosFromBranchEntries } = await loadTodoExtensionModule();
		const sessionManager = SessionManager.inMemory();
		const rootId = sessionManager.appendMessage(userMsg("root"));
		sessionManager.appendCustomEntry(TODO_STATE_ENTRY_TYPE, {
			todos: [{ content: "Root todo", status: "pending", priority: "medium" }],
		});
		const branchPointId = sessionManager.appendMessage(assistantMsg("branch point"));
		sessionManager.appendCustomEntry(TODO_STATE_ENTRY_TYPE, {
			todos: [{ content: "Mainline todo", status: "completed", priority: "low" }],
		});
		sessionManager.branch(branchPointId);
		sessionManager.appendMessage(userMsg("branch work"));
		sessionManager.appendCustomEntry(TODO_STATE_ENTRY_TYPE, {
			todos: [{ content: "Branch todo", status: "in_progress", priority: "high" }],
		});

		// when
		const branchTodos = getLatestTodosFromBranchEntries(sessionManager.getBranch());
		const rootTodos = getLatestTodosFromBranchEntries(sessionManager.getBranch(rootId));

		// then
		expect(branchTodos).toEqual([{ content: "Branch todo", status: "in_progress", priority: "high" }]);
		expect(rootTodos).toEqual([]);
	});
});
