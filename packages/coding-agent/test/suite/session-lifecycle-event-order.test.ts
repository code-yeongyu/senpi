// senpi#4360 (R10.c): a session_lifecycle event sits immediately before the session event that caused it, whatever the
// timing on either side. The lifecycle state updates synchronously when the agent emits; the session delivers the
// agent's events through its ordered queue, and the lifecycle event now rides that queue just ahead of its cause.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

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

const macrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const slowQueue: ExtensionFactory = (pi) => {
	pi.on("message_end", async () => {
		for (let turn = 0; turn < 5; turn++) await macrotask();
	});
};

function line(event: Harness["events"][number]): string[] {
	if (event.type === "session_lifecycle") {
		const activity = (event as { lifecycle: { activity?: { kind: string; outstanding?: number } } }).lifecycle
			.activity;
		return [
			`lifecycle ${activity === undefined ? "none" : `${activity.kind}${activity.outstanding ? ` ${activity.outstanding}` : ""}`}`,
		];
	}
	if (event.type === "message_start" || event.type === "message_end")
		return [`${event.type} ${(event.message as { role: string }).role}`];
	if (event.type === "tool_execution_start" || event.type === "tool_execution_end")
		return [`${event.type} ${(event as { toolCallId: string }).toolCallId}`];
	return [];
}

async function order(extensions: ExtensionFactory[]): Promise<string[]> {
	const harness = await createHarness({ tools: [echo], extensionFactories: extensions });
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage(
			[
				{ ...fauxToolCall("echo", { n: 0 }), id: "call-0" },
				{ ...fauxToolCall("echo", { n: 1 }), id: "call-1" },
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("go");
	return harness.events.flatMap(line).filter((entry) => !entry.startsWith("message_") || !entry.endsWith(" custom"));
}

describe("session_lifecycle events sit immediately before their cause (senpi#4360)", () => {
	it("pins the order of a two-call turn", async () => {
		const events = await order([]);
		const at = (entry: string, from = 0): number => events.indexOf(entry, from);

		expect(events[at("message_start assistant") - 1]).toBe("lifecycle model");
		expect(events[at("message_end assistant") - 1]).toBe("lifecycle none");
		expect(events[at("tool_execution_start call-0") - 1]).toBe("lifecycle tool 1");
		expect(events[at("tool_execution_start call-1") - 1]).toBe("lifecycle tool 2");
		expect(events[at("tool_execution_end call-0") - 1]).toBe("lifecycle tool 1");
		expect(events[at("tool_execution_end call-1") - 1]).toBe("lifecycle none");
	});

	it("keeps that order when the session's own queue drains slowly", async () => {
		expect(await order([slowQueue])).toEqual(await order([]));
	});
});
