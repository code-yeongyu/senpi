// Fixture provenance: .omo/plans/todo-tool-correction.fixtures.json
// SHA-256: 5d12183155fcbe8ecb7df5d24a0eb72cc07c58c15de7d876a39f2e04b91dd9b4

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Tool, validateToolArguments } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { describe, expect, it } from "vitest";
import {
	clonePhases,
	DEFAULT_INIT_PHASE,
	type TodoPhase,
	type TodoToolDetails,
} from "../../src/core/extensions/builtin/todotools/state.ts";
import { registerTodoTool, TODO_PARAMS_SCHEMA } from "../../src/core/extensions/builtin/todotools/tools/todo.ts";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "../../src/core/extensions/types.ts";

type TodoParams = Static<typeof TODO_PARAMS_SCHEMA>;
type RegisteredTodoTool = ToolDefinition<typeof TODO_PARAMS_SCHEMA, TodoToolDetails, unknown>;

type FixtureListEntry = {
	phase: string;
	items: string[];
};

type FixtureRawArgs = Record<string, unknown> & {
	op?: string;
	task?: string;
	phase?: string;
	list?: FixtureListEntry[];
	items?: string[];
	append?: string[];
};

type TodoFixture = {
	id: string;
	source_model: string;
	raw_args: FixtureRawArgs;
	starting_state: TodoPhase[] | null;
	starting_state_reconstructed: boolean;
	expected_behavior_after_fix: string;
};

type FixtureDocument = {
	fixtures: TodoFixture[];
};

const fixturePath = join(process.cwd(), "test/fixtures/todo-arg-correction.fixtures.json");
const fixtureDocument = JSON.parse(readFileSync(fixturePath, "utf8")) as FixtureDocument;
const fixtures = fixtureDocument.fixtures;
const validationTool = {
	name: "todo",
	description: "Todo fixture validation tool",
	parameters: TODO_PARAMS_SCHEMA,
} satisfies Tool;

const inferredListFixtureIds = new Set(["fx04", "fx06", "fx07", "fx09", "fx10", "fx11", "fx13", "fx15"]);
const inferredItemsFixtureIds = new Set(["fx02", "fx08", "fx14"]);
const notFoundFixtureIds = new Set(["fx01", "fx03", "fx16"]);

function expectedInitializedPhases(rawArgs: FixtureRawArgs): TodoPhase[] {
	const list = rawArgs.list ?? (rawArgs.items ? [{ phase: DEFAULT_INIT_PHASE, items: rawArgs.items }] : undefined);
	if (!list) throw new Error("Expected an init fixture list or items payload");

	const phases: TodoPhase[] = [];
	const phasesByName = new Map<string, TodoPhase>();
	const seenTasks = new Set<string>();
	for (const entry of list) {
		let phase = phasesByName.get(entry.phase);
		if (!phase) {
			phase = { name: entry.phase, tasks: [] };
			phasesByName.set(entry.phase, phase);
			phases.push(phase);
		}
		for (const content of entry.items) {
			if (seenTasks.has(content)) continue;
			seenTasks.add(content);
			phase.tasks.push({ content, status: "pending" });
		}
	}

	const firstTask = phases.flatMap((phase) => phase.tasks)[0];
	if (firstTask) firstTask.status = "in_progress";
	return phases;
}

function expectedAliasedAppendState(initialPhases: readonly TodoPhase[], rawArgs: FixtureRawArgs): TodoPhase[] {
	const items = rawArgs.append;
	const phaseName = rawArgs.phase;
	if (!items || !phaseName) throw new Error("Expected an append-alias fixture payload");

	const phases = clonePhases(initialPhases);
	const phase = phases.find((candidate) => candidate.name === phaseName);
	if (!phase) throw new Error(`Expected initial phase "${phaseName}"`);
	phase.tasks.push(...items.map((content) => ({ content, status: "pending" as const })));
	return phases;
}

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
	rawArgs: FixtureRawArgs,
	context: ExtensionContext,
): Promise<AgentToolResult<TodoToolDetails>> {
	if (!tool.execute) throw new Error("Expected todo execute");
	return tool.execute("todo-arg-correction", rawArgs as TodoParams, undefined, undefined, context);
}

async function executeError(
	tool: RegisteredTodoTool,
	rawArgs: FixtureRawArgs,
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

function requiredTask(rawArgs: FixtureRawArgs): string {
	if (typeof rawArgs.task !== "string") throw new Error("Expected fixture task text");
	return rawArgs.task;
}

describe("todo argument correction fixture replay", () => {
	it("loads all 17 tracked observed-failure fixtures", () => {
		expect(fixtures).toHaveLength(17);
		expect(fixtures.map((fixture) => fixture.id)).toEqual([
			"fx01",
			"fx02",
			"fx03",
			"fx04",
			"fx05",
			"fx06",
			"fx07",
			"fx08",
			"fx09",
			"fx10",
			"fx11",
			"fx12",
			"fx13",
			"fx14",
			"fx15",
			"fx16",
			"fx17",
		]);
	});

	it.each(fixtures)("replays $id from $source_model through registered todo execute", async (fixture) => {
		if (inferredListFixtureIds.has(fixture.id)) {
			const captured = captureTodoTool([]);
			const result = await executeTodo(captured.tool, fixture.raw_args, captured.context);
			const text = resultText(result);

			expect(result.details.op).toBe("init");
			expect(text).toContain(
				'[auto-corrected] "op" was missing; interpreted as "init" because "list" was provided.',
			);
			expect(text).toContain('Always pass op explicitly: {"op":"init","list":[...]}');
			expect(captured.getCurrentPhases()).toEqual(expectedInitializedPhases(fixture.raw_args));
			expect(captured.getAppendCalls()).toBe(1);
			return;
		}

		if (inferredItemsFixtureIds.has(fixture.id)) {
			const captured = captureTodoTool([]);
			const result = await executeTodo(captured.tool, fixture.raw_args, captured.context);
			const text = resultText(result);

			expect(result.details.op).toBe("init");
			expect(text).toContain(
				'[auto-corrected] "op" was missing; interpreted as "init" because "items" was provided to an empty todo list.',
			);
			expect(text).toContain('Always pass op explicitly: {"op":"init","items":[...]}');
			expect(captured.getCurrentPhases()).toEqual(expectedInitializedPhases(fixture.raw_args));
			expect(captured.getAppendCalls()).toBe(1);
			return;
		}

		if (fixture.id === "fx12") {
			if (!fixture.starting_state) throw new Error("Expected fx12 starting state");
			const captured = captureTodoTool(fixture.starting_state);
			const result = await executeTodo(captured.tool, fixture.raw_args, captured.context);
			const text = resultText(result);

			expect(result.details.op).toBe("append");
			expect(text).toContain('[auto-corrected] "append" was used as an items alias and folded into "items".');
			expect(captured.getCurrentPhases()).toEqual(
				expectedAliasedAppendState(fixture.starting_state, fixture.raw_args),
			);
			expect(captured.getCurrentPhases()[0]?.tasks).toHaveLength(7);
			expect(captured.getAppendCalls()).toBe(1);
			return;
		}

		if (fixture.id === "fx17") {
			const captured = captureTodoTool([]);
			const result = await executeTodo(captured.tool, fixture.raw_args, captured.context);

			expect(result.details.op).toBe("init");
			expect(resultText(result)).toContain('[auto-corrected] merged duplicate phase "Dockerfile" in init list');
			expect(captured.getCurrentPhases()).toEqual(expectedInitializedPhases(fixture.raw_args));
			expect(captured.getAppendCalls()).toBe(1);
			return;
		}

		if (notFoundFixtureIds.has(fixture.id)) {
			if (!fixture.starting_state) throw new Error(`Expected ${fixture.id} starting state`);
			const captured = captureTodoTool(fixture.starting_state);
			const error = await executeError(captured.tool, fixture.raw_args, captured.context);

			expect(error.message).toContain(`Task "${requiredTask(fixture.raw_args)}" not found`);
			expect(error.message).toContain("Did you mean");
			if (fixture.id === "fx03") expect(error.message).not.toContain("[auto-corrected]");
			expect(captured.getCurrentPhases()).toEqual(fixture.starting_state);
			expect(captured.getAppendCalls()).toBe(0);
			return;
		}

		if (fixture.id === "fx05") {
			const captured = captureTodoTool([]);

			expect(() =>
				validateToolArguments(validationTool, {
					type: "toolCall",
					id: fixture.id,
					name: "todo",
					arguments: fixture.raw_args,
				}),
			).toThrow("op: must be equal to constant");
			expect(captured.getCurrentPhases()).toEqual([]);
			expect(captured.getAppendCalls()).toBe(0);
			return;
		}

		throw new Error(`Unhandled fixture ${fixture.id}`);
	});

	it("preserves task-N errors through registered todo execute", async () => {
		const initialPhases: TodoPhase[] = [
			{ name: "Tasks", tasks: [{ content: "Build release", status: "in_progress" }] },
		];
		const captured = captureTodoTool(initialPhases);
		const error = await executeError(captured.tool, { op: "done", task: "task-12" }, captured.context);

		expect(error.message).toContain(
			'Task "task-12" not found. Tasks are referenced by content, not by IDs — pass the task\'s full text from the previous result.',
		);
		expect(captured.getCurrentPhases()).toEqual(initialPhases);
		expect(captured.getAppendCalls()).toBe(0);
	});
});
