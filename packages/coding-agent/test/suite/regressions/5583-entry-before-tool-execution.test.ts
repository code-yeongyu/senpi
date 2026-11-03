import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#5583: RPC clients (the desktop session timeline, omo-desktop-app#5693) attribute a call's
// tool_execution_* records by assuming the call's assistant entry was published before them.
const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

const progressTool: AgentTool = {
	name: "progress",
	label: "Progress",
	description: "Report one progress update, then finish",
	parameters: Type.Object({}),
	execute: async (_toolCallId, _params, _signal, onUpdate) => {
		onUpdate?.({ content: [{ type: "text", text: "half" }], details: {} });
		return { content: [{ type: "text", text: "done" }], details: {} };
	},
};

function callRecordTypesInOrder(events: readonly AgentSessionEvent[], toolCallId: string): string[] {
	return events.flatMap((event) => {
		if (event.type === "entry_appended") {
			const message = event.entry.type === "message" ? event.entry.message : undefined;
			const holdsCall =
				message?.role === "assistant" &&
				message.content.some((block) => block.type === "toolCall" && block.id === toolCallId);
			return holdsCall ? ["entry_appended"] : [];
		}
		if (
			(event.type === "tool_execution_start" ||
				event.type === "tool_execution_update" ||
				event.type === "tool_execution_end") &&
			event.toolCallId === toolCallId
		) {
			return [event.type];
		}
		return [];
	});
}

it("publishes a tool call's assistant entry before the call's tool_execution records", async () => {
	// Given an RPC-mode session whose model calls a tool that reports progress.
	const h = await createHarness({ tools: [progressTool] });
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	h.setResponses([
		fauxAssistantMessage(fauxToolCall("progress", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("finished"),
	]);

	// When the turn runs the call.
	await h.session.prompt("go");

	// Then the stream carries the call's entry first, then its start, update and end.
	const [toolCallId] = h.eventsOfType("tool_execution_start").map((event) => event.toolCallId);
	expect(toolCallId).toBeDefined();
	expect(callRecordTypesInOrder(h.events, toolCallId ?? "")).toEqual([
		"entry_appended",
		"tool_execution_start",
		"tool_execution_update",
		"tool_execution_end",
	]);
});
