import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	clonePhases,
	getLatestPhasesFromBranchEntries,
	getTodoWidgetLines,
	type TodoPhase,
	type TodoToolDetails,
} from "../../src/core/extensions/builtin/todotools/state.ts";
import { registerTodoTool, TODO_PARAMS_SCHEMA } from "../../src/core/extensions/builtin/todotools/tools/todo.ts";
import { discoverAndLoadExtensions } from "../../src/core/extensions/loader.ts";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
	ToolRenderContext,
} from "../../src/core/extensions/types.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const TODO_EXTENSION_PATH = fileURLToPath(
	new URL("../../src/core/extensions/builtin/todotools/index.ts", import.meta.url),
);
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
type TodoParams = Static<typeof TODO_PARAMS_SCHEMA>;

beforeAll(() => initTheme("dark"));

async function createHarnessWithTodoExtension(): Promise<Harness> {
	const extensionsResult = await discoverAndLoadExtensions([TODO_EXTENSION_PATH], REPO_ROOT, REPO_ROOT);
	return createHarness({ resourceLoader: createTestResourceLoader({ extensionsResult }) });
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

async function captureTodoTool(initialPhases: TodoPhase[] = []) {
	let capturedTool: ToolDefinition<typeof TODO_PARAMS_SCHEMA> | undefined;
	let currentPhases = clonePhases(initialPhases);
	const mockPi = {
		registerTool(tool: ToolDefinition<typeof TODO_PARAMS_SCHEMA>) {
			capturedTool = tool;
		},
		appendEntry() {},
	} as Pick<ExtensionAPI, "registerTool" | "appendEntry"> as ExtensionAPI;
	registerTodoTool(mockPi, {
		getCurrentPhases: () => clonePhases(currentPhases),
		setCurrentPhases: (phases) => {
			currentPhases = clonePhases(phases);
		},
		syncWidget: () => {},
	});
	if (!capturedTool) throw new Error("Expected todo tool to be registered");
	return {
		tool: capturedTool,
		getCurrentPhases: () => clonePhases(currentPhases),
		context: { sessionManager: { getSessionFile: () => undefined } } as unknown as ExtensionContext,
	};
}

function schemaDescription(schema: unknown): string | undefined {
	if (typeof schema !== "object" || schema === null || !("description" in schema)) return undefined;
	return typeof schema.description === "string" ? schema.description : undefined;
}

function renderContext(args: TodoParams, isError = false): ToolRenderContext<unknown, TodoParams> {
	return {
		args,
		toolCallId: "todo-correction-render",
		invalidate: () => {},
		lastComponent: undefined,
		state: undefined,
		cwd: REPO_ROOT,
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError,
		spinnerFrame: undefined,
	};
}

describe("todo correction wiring", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("advertises explicit operation and exact-reference schema guidance without auto-correction", () => {
		expect(schemaDescription(TODO_PARAMS_SCHEMA.properties.op)).toBe(
			"Operation to perform. Required — always pass it explicitly.",
		);
		expect(schemaDescription(TODO_PARAMS_SCHEMA.properties.list)).toBe("Phased task list for init");
		expect(schemaDescription(TODO_PARAMS_SCHEMA.properties.task)).toBe(
			"Exact task text copied from the previous todo result",
		);
		expect(schemaDescription(TODO_PARAMS_SCHEMA.properties.phase)).toBe(
			"Exact phase name copied from the previous todo result",
		);
		expect(schemaDescription(TODO_PARAMS_SCHEMA.properties.items)).toBe("Task texts to append");
		expect(JSON.stringify(TODO_PARAMS_SCHEMA).toLowerCase()).not.toContain("auto-correct");
	});

	it("normalizes omitted init and append aliases through the agent loop", async () => {
		const harness = await createHarnessWithTodoExtension();
		harnesses.push(harness);
		harness.setResponses([
			...responsesForTodo({
				list: [
					{ phase: "Foundation", items: ["Survey code"] },
					{ phase: "Verification", items: ["Run checks"] },
				],
			}),
			...responsesForTodo({ op: "append", phase: "Foundation", append: ["Write tests"] }),
		]);

		await harness.session.prompt("initialize");
		const initResult = getLatestTodoResult(harness);
		const initDetails = initResult.details as TodoToolDetails;
		expect(initResult.isError).not.toBe(true);
		expect(getMessageText(initResult).startsWith('[auto-corrected] "op" was missing; interpreted as "init"')).toBe(
			true,
		);
		expect(initDetails.op).toBe("init");
		expect(initDetails.corrections).toHaveLength(1);
		expect(initDetails.phases).toEqual([
			{ name: "Foundation", tasks: [{ content: "Survey code", status: "in_progress" }] },
			{ name: "Verification", tasks: [{ content: "Run checks", status: "pending" }] },
		]);

		await harness.session.prompt("append");
		const appendResult = getLatestTodoResult(harness);
		expect(getMessageText(appendResult).startsWith('[auto-corrected] "append" was used as an items alias')).toBe(
			true,
		);
		expect((appendResult.details as TodoToolDetails).phases[0]?.tasks).toEqual([
			{ content: "Survey code", status: "in_progress" },
			{ content: "Write tests", status: "pending" },
		]);
	});

	it("throws unrecoverable errors through the loop while preserving the current state and rendered recovery text", async () => {
		const harness = await createHarnessWithTodoExtension();
		harnesses.push(harness);
		harness.setResponses([
			...responsesForTodo({ op: "init", items: ["Do not deploy API to production"] }),
			...responsesForTodo({ op: "done", task: "Deploy API to production" }),
		]);

		await harness.session.prompt("initialize");
		const currentPhases = getLatestPhasesFromBranchEntries(harness.sessionManager.getBranch());
		await harness.session.prompt("complete paraphrase");

		const result = getLatestTodoResult(harness);
		const text = getMessageText(result);
		expect(result.isError).toBe(true);
		expect(text).toContain('Task "Deploy API to production" not found');
		expect(text).toContain('Did you mean "Do not deploy API to production"?');
		expect(text).toContain("Remaining items (1):");
		expect(getLatestPhasesFromBranchEntries(harness.sessionManager.getBranch())).toEqual(currentPhases);

		const { tool } = await captureTodoTool();
		if (!tool.renderResult) throw new Error("Expected todo result renderer");
		const errorResult = {
			content: [{ type: "text" as const, text }],
			details: {},
		} as unknown as AgentToolResult<TodoToolDetails>;
		const rendered = stripAnsi(
			tool
				.renderResult(
					errorResult,
					{ expanded: false, isPartial: false },
					theme,
					renderContext({ op: "done", task: "Deploy API to production" }, true),
				)
				.render(160)
				.join("\n"),
		);
		expect(rendered).toContain('Task "Deploy API to production" not found');
	});

	it("throws normalization errors without changing the accessor state", async () => {
		const initialPhases: TodoPhase[] = [
			{ name: "Tasks", tasks: [{ content: "Stable task", status: "in_progress" }] },
		];
		const { tool, getCurrentPhases, context } = await captureTodoTool(initialPhases);
		if (!tool.execute) throw new Error("Expected todo execute");

		await expect(
			tool.execute("blank-target", { op: "done", task: " " } as TodoParams, undefined, undefined, context),
		).rejects.toThrow('Blank "task" — pass the exact task text, or omit the field entirely for a bulk operation.');
		expect(getCurrentPhases()).toEqual(initialPhases);
	});

	it("renders all corrected-init phases while the widget remains limited to the active phase", async () => {
		const { tool } = await captureTodoTool();
		if (!tool.renderResult) throw new Error("Expected todo result renderer");
		const phases: TodoPhase[] = [
			{ name: "Foundation", tasks: [{ content: "Survey code", status: "in_progress" }] },
			{ name: "Verification", tasks: [{ content: "Run checks", status: "pending" }] },
		];
		const result = {
			content: [{ type: "text" as const, text: "summary" }],
			details: { op: "init" as const, phases, storage: "memory" as const },
		} satisfies { content: { type: "text"; text: string }[]; details: TodoToolDetails };
		const args = {
			list: [
				{ phase: "Foundation", items: ["Survey code"] },
				{ phase: "Verification", items: ["Run checks"] },
			],
		} as TodoParams;

		const rendered = stripAnsi(
			tool
				.renderResult(result, { expanded: false, isPartial: false }, theme, renderContext(args))
				.render(160)
				.join("\n"),
		);
		expect(rendered).toContain("I. Foundation");
		expect(rendered).toContain("II. Verification");
		expect(rendered).toContain("[ ] Run checks");
		expect(getTodoWidgetLines(phases)).toEqual(["Todo", "Foundation", "[•] Survey code"]);
	});

	it("renders fuzzy-corrected drops when the raw task text no longer literally exists", async () => {
		const { tool } = await captureTodoTool();
		if (!tool.renderResult) throw new Error("Expected todo result renderer");
		const result = {
			content: [{ type: "text" as const, text: "summary" }],
			details: {
				op: "drop" as const,
				phases: [
					{ name: "Planning", tasks: [{ content: "Deploy API", status: "abandoned" as const }] },
					{ name: "Verification", tasks: [{ content: "Continue", status: "in_progress" as const }] },
				],
				storage: "memory" as const,
				corrections: [
					'[auto-matched] task " deploy api " -> "Deploy API" — pass the exact text from the previous todo result next time',
				],
			},
		} satisfies { content: { type: "text"; text: string }[]; details: TodoToolDetails };

		const rendered = stripAnsi(
			tool
				.renderResult(
					result,
					{ expanded: false, isPartial: false },
					theme,
					renderContext({ op: "drop", task: " deploy api " }),
				)
				.render(160)
				.join("\n"),
		);
		expect(rendered).toContain("I. Planning");
		expect(rendered).toContain("II. Verification");
		expect(rendered).toContain("[•] Continue");
	});
});
