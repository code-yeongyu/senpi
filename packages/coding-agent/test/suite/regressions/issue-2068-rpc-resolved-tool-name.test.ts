import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { toJsonEvent } from "../../../src/modes/json-event.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function toolCallUpdates(calledName: string) {
	const harness = await createHarness();
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall(calledName, { path: "missing.txt" }, { id: "call_2068" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("read it");
	const updates = harness.eventsOfType("message_update");
	const of = (type: AssistantMessageEvent["type"]) =>
		updates.filter((event) => event.assistantMessageEvent.type === type);
	return {
		starts: of("toolcall_start"),
		ends: of("toolcall_end"),
		deltas: of("toolcall_delta"),
		texts: of("text_delta"),
	};
}

// #2068: RPC clients title a streaming call by the tool it will run, before tool_execution_start.
describe("toolcall_start and toolcall_end name the tool a call resolves to", () => {
	it("reports read for a gateway-namespaced mcp__686f__Read call, on the session event and the wire", async () => {
		const { starts, ends, deltas, texts } = await toolCallUpdates("mcp__686f__Read");

		expect(starts.map((event) => event.resolvedToolName)).toEqual(["read"]);
		expect(ends.map((event) => event.resolvedToolName)).toEqual(["read"]);
		for (const event of [...deltas, ...texts]) expect(event).not.toHaveProperty("resolvedToolName");
		const [start] = starts;
		if (start === undefined) throw new Error("expected a toolcall_start");
		expect(toJsonEvent(start)).toMatchObject({
			assistantMessageEvent: { type: "toolcall_start", id: "call_2068", toolName: "mcp__686f__Read" },
			resolvedToolName: "read",
		});
	});

	it("reports the requested name for an exact call and for a name nothing resolves", async () => {
		const exact = await toolCallUpdates("read");
		const unknown = await toolCallUpdates("mcp__686f__NoSuchTool");

		expect([...exact.starts, ...exact.ends].map((event) => event.resolvedToolName)).toEqual(["read", "read"]);
		expect([...unknown.starts, ...unknown.ends].map((event) => event.resolvedToolName)).toEqual([
			"mcp__686f__NoSuchTool",
			"mcp__686f__NoSuchTool",
		]);
	});
});
