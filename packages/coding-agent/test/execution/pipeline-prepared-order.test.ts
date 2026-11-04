// S18b (R10.c), S36 (senpi#5728): the prepared pipeline gives a session the same event ORDER as the loop's removed
// scheduler, the session's own lifecycle events included, for a parallel batch and for session-wide sequential mode.
// Each expected sequence was recorded from that scheduler at the last commit that still had it (prepared matched it
// there); a sequential tool between parallel ones is covered by pipeline-prepared.test.ts.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryBatchStore } from "../../../agent/src/execution/prepared/memory-batch-store.ts";
import { createPreparedToolHost } from "../../../agent/src/execution/prepared/pipeline-prepared.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

const echo: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Echo the arguments back",
	parameters: Type.Object({}, { additionalProperties: true }),
	execute: async (_id, params) => ({ content: [{ type: "text", text: JSON.stringify(params) }], details: {} }),
};

function line(event: Harness["events"][number]): string[] {
	if (event.type === "session_lifecycle") {
		const activity = (event as { lifecycle: { activity?: { kind: string; toolCallId?: string } } }).lifecycle
			.activity;
		return [`lifecycle ${activity === undefined ? "none" : `${activity.kind} ${activity.toolCallId ?? ""}`.trim()}`];
	}
	if (event.type === "message_end" || event.type === "message_start") {
		const message = event.message as { role: string; toolCallId?: string };
		return [`${event.type} ${message.role}${message.toolCallId === undefined ? "" : ` ${message.toolCallId}`}`];
	}
	if (event.type === "entry_appended") return ["entry_appended"];
	if (event.type.startsWith("tool_execution_")) {
		const tool = event as { toolCallId: string };
		return [`${event.type} ${tool.toolCallId}`];
	}
	return [];
}

async function order(calls: readonly string[], sequential: boolean): Promise<string[]> {
	const harness = await createHarness({ tools: [echo] });
	harnesses.push(harness);
	if (sequential) harness.agent.toolExecution = "sequential";
	harness.agent.toolHost = createPreparedToolHost(harness.agent, openMemoryBatchStore);
	harness.setResponses([
		fauxAssistantMessage(
			calls.map((name, index) => ({ ...fauxToolCall(name, { n: index }), id: `call-${index}` })),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("go");
	return harness.events.flatMap(line);
}

const LEGACY_ORDERS: ReadonlyArray<readonly [string, readonly string[], boolean, readonly string[]]> = [
	[
		"one call",
		["echo"],
		false,
		[
			"lifecycle none",
			"message_start user",
			"message_end user",
			"lifecycle model",
			"message_start assistant",
			"lifecycle none",
			"message_end assistant",
			"lifecycle tool call-0",
			"tool_execution_start call-0",
			"lifecycle none",
			"tool_execution_end call-0",
			"message_start toolResult call-0",
			"message_end toolResult call-0",
			"lifecycle model",
			"message_start assistant",
			"lifecycle none",
			"message_end assistant",
			"lifecycle none",
		],
	],
	[
		"three parallel calls",
		["echo", "echo", "echo"],
		false,
		[
			"lifecycle none",
			"message_start user",
			"message_end user",
			"lifecycle model",
			"message_start assistant",
			"lifecycle none",
			"message_end assistant",
			"lifecycle tool call-0",
			"tool_execution_start call-0",
			"lifecycle tool call-0",
			"tool_execution_start call-1",
			"lifecycle tool call-0",
			"tool_execution_start call-2",
			"lifecycle tool call-1",
			"tool_execution_end call-0",
			"lifecycle tool call-2",
			"tool_execution_end call-1",
			"lifecycle none",
			"tool_execution_end call-2",
			"message_start toolResult call-0",
			"message_end toolResult call-0",
			"message_start toolResult call-1",
			"message_end toolResult call-1",
			"message_start toolResult call-2",
			"message_end toolResult call-2",
			"lifecycle model",
			"message_start assistant",
			"lifecycle none",
			"message_end assistant",
			"lifecycle none",
		],
	],
	[
		"session-wide sequential mode",
		["echo", "echo"],
		true,
		[
			"lifecycle none",
			"message_start user",
			"message_end user",
			"lifecycle model",
			"message_start assistant",
			"lifecycle none",
			"message_end assistant",
			"lifecycle tool call-0",
			"tool_execution_start call-0",
			"lifecycle none",
			"tool_execution_end call-0",
			"message_start toolResult call-0",
			"message_end toolResult call-0",
			"lifecycle tool call-1",
			"tool_execution_start call-1",
			"lifecycle none",
			"tool_execution_end call-1",
			"message_start toolResult call-1",
			"message_end toolResult call-1",
			"lifecycle model",
			"message_start assistant",
			"lifecycle none",
			"message_end assistant",
			"lifecycle none",
		],
	],
];

describe("the prepared pipeline keeps the removed scheduler's session event order (S18b, R10.c; S36)", () => {
	it.each(LEGACY_ORDERS)("%s", async (_label, calls, sequential, expected) => {
		expect(await order(calls, sequential)).toEqual(expected);
	});
});
