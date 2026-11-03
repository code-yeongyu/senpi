import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { handleClientInput } from "../../../src/modes/rpc/client-input-handler.ts";
import { subscribeSessionRecords } from "../../../src/modes/rpc/session-record-stream.ts";
import { createHarness } from "../harness.ts";

// senpi#5583: RPC clients (the desktop session timeline, omo-desktop-app#5693) attribute a call's
// tool_execution_* records by assuming the call's assistant entry was published before them. This reads the
// RPC records from subscribeSessionRecords, the projection every host connection and terminal endpoint
// streams, for input admitted with a clientMessageId so the projection's client-correlation path is live.
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
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

const TOOL_EXECUTION_TYPES = new Set(["tool_execution_start", "tool_execution_update", "tool_execution_end"]);

function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
}

function entryHoldsCall(record: object, toolCallId: string): boolean {
	const message = field(field(record, "entry"), "message");
	const content = field(message, "content");
	return (
		field(message, "role") === "assistant" &&
		Array.isArray(content) &&
		content.some((block) => field(block, "type") === "toolCall" && field(block, "id") === toolCallId)
	);
}

function callRecordTypesInOrder(records: readonly object[], toolCallId: string): unknown[] {
	return records.flatMap((record) => {
		const type = field(record, "type");
		if (type === "entry_appended") return entryHoldsCall(record, toolCallId) ? [type] : [];
		return typeof type === "string" && TOOL_EXECUTION_TYPES.has(type) && field(record, "toolCallId") === toolCallId
			? [type]
			: [];
	});
}

it("streams a tool call's assistant entry before the call's tool_execution records on the RPC record projection", async () => {
	// Given an RPC-mode session streamed through the record projection, whose model calls a tool that reports progress.
	const h = await createHarness({ tools: [progressTool] });
	cleanups.push(() => h.cleanup());
	await h.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	h.setResponses([
		fauxAssistantMessage(fauxToolCall("progress", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("finished"),
	]);
	const records: object[] = [];
	cleanups.push(subscribeSessionRecords(h.session, (record) => records.push(record)));
	const io = { output: () => {}, promptCalls: new Set<Promise<unknown>>() };

	// When a client prompt with a clientMessageId runs the call.
	await handleClientInput(h.session, { id: "p1", type: "prompt", message: "go", clientMessageId: "order-1" }, io);
	await Promise.all([...io.promptCalls]);
	await h.session.waitForIdle();

	// Then the projected records carry the call's entry first, then its start, update and end, all correlated.
	const toolCallId = field(
		records.find((record) => field(record, "type") === "tool_execution_start"),
		"toolCallId",
	);
	expect(typeof toolCallId).toBe("string");
	const callId = String(toolCallId);
	expect(callRecordTypesInOrder(records, callId)).toEqual([
		"entry_appended",
		"tool_execution_start",
		"tool_execution_update",
		"tool_execution_end",
	]);
	const callRecords = records.filter(
		(record) => entryHoldsCall(record, callId) || field(record, "toolCallId") === callId,
	);
	expect(callRecords.map((record) => field(record, "clientMessageId"))).toEqual([
		"order-1",
		"order-1",
		"order-1",
		"order-1",
	]);
});
