// Real-surface regression for the padded-rm dead-end observed in senpi session
// 019fabf3 (2026-07-29, apitopia workspace, gpt-5.6-sol): the model emitted
// {"op":"rm","list":[],"task":"","phase":"","items":[]} - every schema field
// present, strings blank - and the tool threw 'Blank "task"' back twice.
// These tests drive the registered todo tool execute (real normalization,
// applyParams, and result rendering) end to end.

import type { Static } from "typebox";
import { describe, expect, it } from "vitest";
import {
	clonePhases,
	type TodoPhase,
	type TodoToolDetails,
} from "../../src/core/extensions/builtin/todotools/state.ts";
import { registerTodoTool, type TODO_PARAMS_SCHEMA } from "../../src/core/extensions/builtin/todotools/tools/todo.ts";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	ToolDefinition,
} from "../../src/core/extensions/types.ts";

type TodoParams = Static<typeof TODO_PARAMS_SCHEMA>;
type RegisteredTodoTool = ToolDefinition<typeof TODO_PARAMS_SCHEMA, TodoToolDetails, unknown>;

function captureTodoTool(initialPhases: readonly TodoPhase[]) {
	let capturedTool: RegisteredTodoTool | undefined;
	let currentPhases = clonePhases(initialPhases);
	let appendCalls = 0;
	const pi = {
		registerTool(tool: RegisteredTodoTool) {
			capturedTool = tool;
		},
		appendEntry() {
			appendCalls += 1;
		},
	} as Pick<ExtensionAPI, "registerTool" | "appendEntry"> as ExtensionAPI;
	registerTodoTool(pi, {
		getCurrentPhases: () => clonePhases(currentPhases),
		setCurrentPhases: (phases) => {
			currentPhases = clonePhases(phases);
		},
		getCurrentAsk: () => undefined,
		setCurrentAsk: () => {},
		syncWidget: () => {},
	});
	if (!capturedTool) throw new Error("Expected todo tool to be registered");

	return {
		tool: capturedTool,
		getCurrentPhases: () => clonePhases(currentPhases),
		getAppendCalls: () => appendCalls,
		context: { sessionManager: { getSessionFile: () => undefined } } as unknown as ExtensionContext,
	};
}

async function executeTodo(
	tool: RegisteredTodoTool,
	rawArgs: Record<string, unknown>,
	context: ExtensionContext,
): Promise<AgentToolResult<TodoToolDetails>> {
	if (!tool.execute) throw new Error("Expected todo execute");
	return tool.execute(
		"todo-rm-blank-bulk-clear",
		rawArgs as TodoParams,
		undefined,
		undefined,
		context as ExtensionToolContext,
	);
}

async function executeError(
	tool: RegisteredTodoTool,
	rawArgs: Record<string, unknown>,
	context: ExtensionContext,
): Promise<Error> {
	try {
		await executeTodo(tool, rawArgs, context);
	} catch (error) {
		if (error instanceof Error) return error;
		throw error;
	}
	throw new Error("Expected todo execute to throw");
}

function resultText(result: AgentToolResult<TodoToolDetails>): string {
	return result.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}

const seeded: TodoPhase[] = [
	{
		name: "Setup",
		tasks: [
			{ content: "Seed task one", status: "in_progress" },
			{ content: "Seed task two", status: "pending" },
		],
	},
];

describe("todo rm both-blank bulk clear through registered execute", () => {
	it("bulk-clears the padded rm payload instead of throwing the blank-target error", async () => {
		const captured = captureTodoTool(seeded);
		const result = await executeTodo(
			captured.tool,
			{ op: "rm", list: [], task: "", phase: "", items: [] },
			captured.context,
		);
		const text = resultText(result);

		expect(result.details.op).toBe("rm");
		expect(text).toContain("[auto-corrected]");
		expect(text).toContain("bulk clear");
		expect(text).not.toContain('Blank "task"');
		expect(text).not.toContain("Seed task one");
		expect(captured.getCurrentPhases()).toEqual([{ name: "Setup", tasks: [] }]);
		expect(captured.getAppendCalls()).toBe(1);
	});

	it("still throws the blank-target error for done with both targets blank", async () => {
		const captured = captureTodoTool(seeded);
		const error = await executeError(captured.tool, { op: "done", task: "", phase: "" }, captured.context);

		expect(error.message).toContain('Blank "task"');
		expect(captured.getCurrentPhases()).toEqual(seeded);
		expect(captured.getAppendCalls()).toBe(0);
	});
});
