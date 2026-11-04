// S18b (R10.c): the prepared pipeline gives a session the same event ORDER as today's scheduler, the session's own
// lifecycle events included. The session observes `tool_execution_start` synchronously and delivers its message
// events through a queue, so a pipeline that starts a batch later than the scheduler does moves the first tool
// activity past the assistant message_end (the EQ regression this pins).
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createPreparedToolHost } from "../../src/core/execution/pipeline-prepared.ts";
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
const serial: AgentTool = { ...echo, name: "serial", label: "Serial", executionMode: "sequential" };

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

async function order(
	pipeline: "legacy" | "prepared",
	calls: readonly string[],
	sequential: boolean,
): Promise<string[]> {
	const harness = await createHarness({ tools: [echo, serial] });
	harnesses.push(harness);
	if (sequential) harness.agent.toolExecution = "sequential";
	if (pipeline === "prepared") harness.agent.toolHost = createPreparedToolHost(harness.agent);
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

describe("the prepared pipeline keeps today's session event order (S18b, R10.c)", () => {
	it.each([
		["one call", ["echo"], false],
		["three parallel calls", ["echo", "echo", "echo"], false],
		["a sequential call between parallel ones", ["echo", "serial", "echo"], false],
		["session-wide sequential mode", ["echo", "echo"], true],
	] as const)("%s", async (_label, calls, sequential) => {
		const legacy = await order("legacy", calls, sequential);

		expect(legacy).toContain("lifecycle tool call-0");
		expect(await order("prepared", calls, sequential)).toEqual(legacy);
	});
});
