// S18b (brain/hand split, R10.c projection): the prepared pipeline (batch coordinator + prepared executor behind the
// ToolHost seam) gives a session exactly the events and tool results today's scheduler gives, and its receipt says
// `prepared` for every call. Each case runs the same faux turn on both pipelines and compares them.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createPreparedToolHost } from "../../src/core/execution/pipeline-prepared.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

const echo: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Echo the arguments back, reporting one update first",
	parameters: Type.Object({}, { additionalProperties: true }),
	execute: async (_id, params, _signal, onUpdate) => {
		await onUpdate?.({ content: [{ type: "text", text: "working" }], details: {} });
		return { content: [{ type: "text", text: JSON.stringify(params) }], details: {} };
	},
};

const serial: AgentTool = {
	...echo,
	name: "serial",
	label: "Serial",
	executionMode: "sequential",
};

const blockNamed =
	(name: string): ExtensionFactory =>
	(pi) => {
		pi.on("tool_call", (event) => (event.toolName === name ? { block: true, reason: `no ${name}` } : undefined));
	};

type Call = readonly [name: string, args: JsonObject];

async function turn(pipeline: "legacy" | "prepared", calls: readonly Call[], extensions: ExtensionFactory[] = []) {
	const harness = await createHarness({ tools: [echo, serial], extensionFactories: extensions });
	harnesses.push(harness);
	const receipts: string[] = [];
	harness.agent.onExecutionPipeline = (witness) => {
		receipts.push(`${witness.pipeline}:${witness.toolCallId}`);
	};
	if (pipeline === "prepared") harness.agent.toolHost = createPreparedToolHost(harness.agent);
	harness.setResponses([
		fauxAssistantMessage(
			calls.map(([name, args], index) => ({ ...fauxToolCall(name, args), id: `call-${index}` })),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("go");
	const events = harness.events.flatMap((event) => {
		if (event.type.startsWith("tool_execution_")) {
			const tool = event as { toolCallId: string; toolName: string; isError?: boolean };
			return [`${event.type} ${tool.toolCallId} ${tool.toolName}${tool.isError ? " error" : ""}`];
		}
		if ((event.type === "message_start" || event.type === "message_end") && "message" in event) {
			const message = event.message as { role: string; toolCallId?: string };
			return message.role === "toolResult" ? [`${event.type} toolResult ${message.toolCallId}`] : [];
		}
		return [];
	});
	const results = harness.session.messages.flatMap((message) =>
		message.role === "toolResult"
			? [
					{
						id: message.toolCallId,
						name: message.toolName,
						isError: message.isError,
						content: message.content,
					},
				]
			: [],
	);
	return { events, results, receipts };
}

async function same(calls: readonly Call[], extensions: ExtensionFactory[] = []) {
	const legacy = await turn("legacy", calls, extensions);
	const prepared = await turn("prepared", calls, extensions);
	expect(prepared.events).toEqual(legacy.events);
	expect(prepared.results).toEqual(legacy.results);
	return { legacy, prepared };
}

const ofCall = (events: readonly string[], id: string): string[] =>
	events.filter((line) => line.split(" ").includes(id));
const kind = (events: readonly string[], prefix: string): string[] => events.filter((line) => line.startsWith(prefix));

/**
 * Equal up to the interleaving of events of calls that run concurrently, which today's scheduler itself leaves to
 * promise scheduling: the same starts in source order, each call's own events in the same order, the same result
 * messages in source order and the same results.
 */
async function samePerCall(calls: readonly Call[], extensions: ExtensionFactory[] = []) {
	const legacy = await turn("legacy", calls, extensions);
	const prepared = await turn("prepared", calls, extensions);
	for (const prefix of ["tool_execution_start", "message_"])
		expect(kind(prepared.events, prefix)).toEqual(kind(legacy.events, prefix));
	for (const index of calls.keys())
		expect(ofCall(prepared.events, `call-${index}`)).toEqual(ofCall(legacy.events, `call-${index}`));
	expect(prepared.results).toEqual(legacy.results);
}

describe("the prepared pipeline equals today's scheduler (S18b)", () => {
	it("runs a parallel batch with its updates, ends and results in today's order", async () => {
		const { prepared } = await same([
			["echo", { n: 1 }],
			["echo", { n: 2 }],
		]);

		expect(prepared.events.filter((line) => line.startsWith("tool_execution_update"))).toHaveLength(2);
	});

	it("runs a sequential tool between parallel ones as today", async () => {
		await same([
			["echo", { n: 1 }],
			["serial", { n: 2 }],
			["echo", { n: 3 }],
		]);
	});

	it("answers a blocked call and an unknown tool as today, and still runs the rest", async () => {
		await samePerCall(
			[
				["serial", { n: 1 }],
				["missing", {}],
				["echo", { n: 3 }],
			],
			[blockNamed("serial")],
		);
	});

	it("writes one prepared receipt per call, and the legacy scheduler a legacy one", async () => {
		const { legacy, prepared } = await same([
			["echo", { n: 1 }],
			["echo", { n: 2 }],
		]);

		expect(legacy.receipts).toEqual(["legacy:call-0", "legacy:call-1"]);
		expect(prepared.receipts).toEqual(["prepared:call-0", "prepared:call-1"]);
	});
});
