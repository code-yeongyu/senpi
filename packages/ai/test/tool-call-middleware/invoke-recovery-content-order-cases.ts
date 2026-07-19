import { expect, it } from "vitest";
import { wrapStreamWithInvokeRecovery } from "../../src/index.ts";
import type { AssistantMessageEvent, Tool } from "../../src/types.ts";
import { AssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import { collectEvents, createAssistantMessage } from "./invoke-recovery-stream-fixtures.ts";

function indexedEvents(events: readonly AssistantMessageEvent[]) {
	return events.flatMap((event) => ("contentIndex" in event ? [event.contentIndex] : []));
}

function expectInvalidContentOrder(events: readonly AssistantMessageEvent[]): void {
	expect(events.filter((event) => event.type === "error")).toHaveLength(1);
	expect(events.filter((event) => event.type === "done")).toEqual([]);
	expect(events.filter((event) => event.type.startsWith("toolcall_"))).toEqual([]);
	const terminal = events.find((event) => event.type === "error");
	expect(terminal).toMatchObject({
		type: "error",
		reason: "error",
		error: {
			stopReason: "error",
			errorMessage: "Invalid assistant content event order",
			diagnostics: [
				{
					type: "text_tool_call_recovery_invalid_content_event",
					timestamp: expect.any(Number),
					details: { protocol: "antml", status: "invalid_content_event_order" },
				},
			],
		},
	});
}

export function registerInvokeRecoveryContentOrderCases(tool: Tool): void {
	it("fails closed without losing text on overlapping text starts", async () => {
		const inner = new AssistantMessageEventStream();
		const partial = createAssistantMessage([]);
		const wrapped = wrapStreamWithInvokeRecovery(inner, [tool]);
		inner.push({ type: "start", partial: structuredClone(partial) });
		partial.content.push({ type: "text", text: "", textSignature: "overlap-signature" });
		inner.push({ type: "text_start", contentIndex: 0, partial: structuredClone(partial) });
		partial.content[0] = { type: "text", text: "<inv", textSignature: "overlap-signature" };
		inner.push({ type: "text_delta", contentIndex: 0, delta: "<inv", partial: structuredClone(partial) });
		partial.content.push({ type: "text", text: "" });
		inner.push({ type: "text_start", contentIndex: 1, partial: structuredClone(partial) });
		inner.push({ type: "text_end", contentIndex: 1, content: "", partial: structuredClone(partial) });
		inner.push({ type: "done", reason: "stop", message: structuredClone(partial) });

		const events = await collectEvents(wrapped);
		const result = await wrapped.result();
		expectInvalidContentOrder(events);
		expect(result.content).toEqual([{ type: "text", text: "<inv", textSignature: "overlap-signature" }]);
		expect(result.content.map((block) => (block.type === "text" ? block.text : "")).join("")).toBe("<inv");
	});

	it("fails closed before emitting regressive content indices", async () => {
		const inner = new AssistantMessageEventStream();
		const partial = createAssistantMessage([]);
		const wrapped = wrapStreamWithInvokeRecovery(inner, [tool]);
		inner.push({ type: "start", partial: structuredClone(partial) });
		partial.content.push({ type: "thinking", thinking: "" });
		inner.push({ type: "thinking_start", contentIndex: 0, partial: structuredClone(partial) });
		partial.content[0] = { type: "thinking", thinking: "thought" };
		inner.push({ type: "thinking_delta", contentIndex: 0, delta: "thought", partial: structuredClone(partial) });
		inner.push({ type: "thinking_end", contentIndex: 0, content: "thought", partial: structuredClone(partial) });
		partial.content.push({ type: "text", text: "" });
		inner.push({ type: "text_start", contentIndex: 1, partial: structuredClone(partial) });
		partial.content[1] = { type: "text", text: "later" };
		inner.push({ type: "text_delta", contentIndex: 1, delta: "later", partial: structuredClone(partial) });
		partial.content[0] = { type: "thinking", thinking: "thought-regressive" };
		inner.push({ type: "thinking_delta", contentIndex: 0, delta: "-regressive", partial: structuredClone(partial) });
		inner.push({
			type: "thinking_end",
			contentIndex: 0,
			content: "thought-regressive",
			partial: structuredClone(partial),
		});
		inner.push({ type: "text_end", contentIndex: 1, content: "later", partial: structuredClone(partial) });
		inner.push({ type: "done", reason: "stop", message: structuredClone(partial) });

		const events = await collectEvents(wrapped);
		const result = await wrapped.result();
		expectInvalidContentOrder(events);
		expect(indexedEvents(events)).toEqual([0, 0, 0, 1, 1, 1]);
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "thought" },
			{ type: "text", text: "later" },
		]);
	});
}
