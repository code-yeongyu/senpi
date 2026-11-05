// S39 (brain/hand split, F37): todo is a loop-side tool. todotools declares its halves with `runs` (#5474): the tool
// and every handler that reads the session belong to the loop, so a hand's generation registers none of its loop
// handlers, and the loop half takes a todo result that ran outside this process as the session's list. A fused
// session is unchanged. The split session that already holds a list is closed by the per-call routing of #5641.
import { createLoopToolHost, createSplitToolHost, loopSideToolNames } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import todotoolsExtension from "../../src/core/extensions/builtin/todotools/index.ts";
import type { TodoPhase, TodoToolDetails } from "../../src/core/extensions/builtin/todotools/state.ts";
import { loadExtensions } from "../../src/core/extensions/loader.ts";
import type { Extension, ExtensionSide } from "../../src/core/extensions/types.ts";
import { createHarness, createTestUiContext, type Harness } from "../suite/harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

const LOOP_EVENTS = [
	"agent_end",
	"before_agent_start",
	"before_provider_request",
	"message_end",
	"session_abort",
	"session_shutdown",
	"session_start",
	"session_tree",
];

async function loadTodotools(side: ExtensionSide | undefined): Promise<Extension> {
	const result = await loadExtensions(["<todotools>"], process.cwd(), undefined, undefined, {
		...(side === undefined ? {} : { side }),
		factoryResolver: () => todotoolsExtension,
	});
	expect(result.errors).toEqual([]);
	const [extension] = result.extensions;
	if (extension === undefined) throw new Error("todotools did not load");
	return extension;
}

const events = (extension: Extension): string[] => [...extension.handlers.keys()].sort();

async function todoHarness(setWidget?: (key: string) => void): Promise<Harness> {
	const harness = await createHarness({ extensionFactories: [todotoolsExtension] });
	harnesses.push(harness);
	if (setWidget !== undefined)
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ setWidget: (key: string) => setWidget(key) }),
			mode: "tui",
		});
	return harness;
}

function todoResult(toolCallId: string, phases: TodoPhase[]): ToolResultMessage {
	const details: TodoToolDetails = { op: "init", phases, storage: "memory" };
	return {
		role: "toolResult",
		toolCallId,
		toolName: "todo",
		content: [{ type: "text", text: "Ask: elsewhere" }],
		details,
		isError: false,
		timestamp: Date.now(),
	};
}

async function viewPhases(harness: Harness): Promise<TodoPhase[]> {
	const tool = harness.session.getRegisteredTool("todo");
	if (tool === undefined) throw new Error("no todo tool");
	const result = await tool.execute("view-1", { op: "view" }, undefined, undefined);
	return (result.details as TodoToolDetails).phases;
}

describe("todo on a split session (S39)", () => {
	it("declares the todo tool loop-side", async () => {
		const extension = await loadTodotools(undefined);

		expect(extension.tools.get("todo")?.definition.runs).toBe("brain");
	});

	it("a hand's generation registers none of todotools' loop handlers; the loop and a fused session register them all", async () => {
		const hand = await loadTodotools("hand");
		const brain = await loadTodotools("brain");
		const fused = await loadTodotools(undefined);

		expect(events(hand)).toEqual([]);
		expect(events(brain)).toEqual(LOOP_EVENTS);
		expect(events(fused)).toEqual(LOOP_EVENTS);
		expect([...hand.tools.keys()]).toEqual([...fused.tools.keys()]);
	});

	it("the loop half takes a todo result that ran outside this process as the session's list", async () => {
		const harness = await todoHarness();
		const phases: TodoPhase[] = [
			{ name: "Elsewhere", tasks: [{ content: "made on the hand", status: "in_progress" }] },
		];

		await harness
			.getExtensionRunner()
			.emitMessageEnd({ type: "message_end", message: todoResult("remote-1", phases) });

		expect(await viewPhases(harness)).toEqual(phases);
	});

	it("a fused session's batch of todo calls renders each list once and ends on the newest, as today", async () => {
		const renders: string[] = [];
		const harness = await todoHarness((key) => renders.push(key));
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("todo", { op: "init", list: [{ phase: "Setup", items: ["one task", "two task"] }] }),
					fauxToolCall("todo", { op: "done", task: "one task" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("ok"),
		]);

		await harness.session.prompt("plan it");

		expect(renders.filter((key) => key === "todo-sidebar")).toHaveLength(3);
		expect(await viewPhases(harness)).toEqual([
			{
				name: "Setup",
				tasks: [
					{ content: "one task", status: "completed" },
					{ content: "two task", status: "in_progress" },
				],
			},
		]);
	});

	it("a split session with an existing list runs todo start and done on the brain, as a fused session does", async () => {
		const run = async (split: boolean) => {
			const renders: string[] = [];
			const handCalls: string[] = [];
			const harness = await todoHarness((key) => renders.push(key));
			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("todo", { op: "init", list: [{ phase: "Setup", items: ["one task", "two task"] }] })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("planned"),
				fauxAssistantMessage(
					[
						fauxToolCall("todo", { op: "done", task: "one task" }),
						fauxToolCall("todo", { op: "start", task: "two task" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("ok"),
			]);
			await harness.session.prompt("plan it");
			if (split) {
				const session = harness.session;
				const loopSide = loopSideToolNames(
					session.getAllTools().flatMap((tool) => session.getToolDefinition(tool.name) ?? []),
				);
				harness.agent.toolHost = createSplitToolHost({
					loopSide: (name) => loopSide.has(name),
					loop: createLoopToolHost(harness.agent),
					hand: {
						execute: async (call) => {
							handCalls.push(...call.calls.map((raw) => raw.name));
							return { messages: [], terminate: false };
						},
					},
				});
			}
			await harness.session.prompt("work on it");
			const results = harness.session.messages.flatMap((message) =>
				message.role === "toolResult" ? [message.content] : [],
			);
			return { phases: await viewPhases(harness), results, renders, handCalls };
		};

		const fused = await run(false);
		const split = await run(true);

		expect(split.handCalls).toEqual([]);
		expect(split.phases).toEqual(fused.phases);
		expect(split.phases).toEqual([
			{
				name: "Setup",
				tasks: [
					{ content: "one task", status: "completed" },
					{ content: "two task", status: "in_progress" },
				],
			},
		]);
		expect(split.results).toEqual(fused.results);
		expect(split.renders).toEqual(fused.renders);
	});

	it("the loop half ignores a result of another tool that carries a todo list", async () => {
		const harness = await todoHarness();
		const foreign = {
			...todoResult("other-1", [{ name: "Other", tasks: [{ content: "x", status: "pending" }] }]),
			toolName: "todowrite",
		};

		await harness.getExtensionRunner().emitMessageEnd({ type: "message_end", message: foreign });

		expect(await viewPhases(harness)).toEqual([]);
	});

	it("a fused session's own todo result renders its widget once, as today", async () => {
		const renders: string[] = [];
		const harness = await todoHarness((key) => renders.push(key));
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("todo", { op: "init", list: [{ phase: "Setup", items: ["one task"] }] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ok"),
		]);

		await harness.session.prompt("plan it");

		expect(renders.filter((key) => key === "todo-sidebar")).toHaveLength(2);
		expect(await viewPhases(harness)).toEqual([
			{ name: "Setup", tasks: [{ content: "one task", status: "in_progress" }] },
		]);
	});
});
