import { expect, it } from "vitest";
import { wrapStreamWithToolCallMiddleware } from "../../src/tool-call-middleware/stream-wrapper.ts";
import {
	collectEvents,
	createAssistantMessage,
	createScriptedInnerStream,
	createScriptedProtocol,
	weatherTool,
} from "./stream-wrapper-fixtures.ts";

export function registerStreamWrapperFinalizationCases(): void {
	it("finalizes parser flags from a terminal flush", async () => {
		const partial = createAssistantMessage([]);
		let finishCalls = 0;
		const protocol = createScriptedProtocol(
			() => [],
			() => {
				finishCalls += 1;
				return [
					{ type: "toolcall_start", index: 0, id: "flagged-tool", name: "get_weather" },
					{
						type: "toolcall_end",
						index: 0,
						id: "flagged-tool",
						name: "get_weather",
						arguments: {},
						incomplete: true,
						errorMessage: "Tool call was truncated mid-arguments",
					},
				];
			},
		);
		const innerStream = createScriptedInnerStream(
			[
				{ type: "start", partial },
				{ type: "text_start", contentIndex: 0, partial },
				{ type: "text_delta", contentIndex: 0, delta: "partial call", partial },
			],
			{ type: "done", reason: "stop", message: createAssistantMessage([], "stop") },
		);

		const outerStream = wrapStreamWithToolCallMiddleware(innerStream, protocol, [weatherTool]);
		const events = await collectEvents(outerStream);
		const result = await outerStream.result();

		expect(finishCalls).toBe(1);
		expect(events).toContainEqual(expect.objectContaining({ type: "toolcall_end" }));
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{
				type: "toolCall",
				id: "flagged-tool",
				name: "get_weather",
				arguments: {},
				incomplete: true,
				errorMessage: "Tool call was truncated mid-arguments",
			},
		]);
	});

	it("flushes each pending text block exactly once when done omits text_end", async () => {
		const partial = createAssistantMessage([]);
		let finishCalls = 0;
		const protocol = createScriptedProtocol(
			() => [],
			() => {
				const index = finishCalls;
				finishCalls += 1;
				return [
					{ type: "toolcall_start", index, id: `tool-${index}`, name: "get_weather" },
					{
						type: "toolcall_end",
						index,
						id: `tool-${index}`,
						name: "get_weather",
						arguments: { city: index === 0 ? "Seoul" : "Tokyo" },
					},
				];
			},
		);
		const innerStream = createScriptedInnerStream(
			[
				{ type: "start", partial },
				{ type: "text_start", contentIndex: 0, partial },
				{ type: "text_delta", contentIndex: 0, delta: "first", partial },
				{ type: "text_end", contentIndex: 0, content: "first", partial },
				{ type: "text_start", contentIndex: 1, partial },
				{ type: "text_delta", contentIndex: 1, delta: "second", partial },
			],
			{ type: "done", reason: "stop", message: createAssistantMessage([], "stop") },
		);

		const outerStream = wrapStreamWithToolCallMiddleware(innerStream, protocol, [weatherTool]);
		const events = await collectEvents(outerStream);
		const result = await outerStream.result();

		expect(finishCalls).toBe(2);
		expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(2);
		expect(result.content).toEqual([
			expect.objectContaining({ type: "toolCall", id: "tool-0", arguments: { city: "Seoul" } }),
			expect.objectContaining({ type: "toolCall", id: "tool-1", arguments: { city: "Tokyo" } }),
		]);
	});
}

export function registerStreamWrapperStopReasonCase(): void {
	it("changes length to toolUse only when a finalized tool call was emitted", async () => {
		const partial = createAssistantMessage([]);
		const recoveredProtocol = createScriptedProtocol(
			() => [
				{ type: "toolcall_start", index: 0, id: "recovered-tool", name: "get_weather" },
				{
					type: "toolcall_end",
					index: 0,
					id: "recovered-tool",
					name: "get_weather",
					arguments: { city: "Seoul" },
				},
			],
			() => [],
		);
		const recoveredInnerStream = createScriptedInnerStream(
			[
				{ type: "start", partial },
				{ type: "text_start", contentIndex: 0, partial },
				{ type: "text_delta", contentIndex: 0, delta: "complete call", partial },
			],
			{ type: "done", reason: "length", message: createAssistantMessage([], "length") },
		);

		const recoveredOuterStream = wrapStreamWithToolCallMiddleware(recoveredInnerStream, recoveredProtocol, [
			weatherTool,
		]);
		await collectEvents(recoveredOuterStream);
		expect((await recoveredOuterStream.result()).stopReason).toBe("toolUse");

		const noToolPartial = createAssistantMessage([]);
		const noToolOuterStream = wrapStreamWithToolCallMiddleware(
			createScriptedInnerStream(
				[
					{ type: "start", partial: noToolPartial },
					{ type: "text_start", contentIndex: 0, partial: noToolPartial },
					{ type: "text_delta", contentIndex: 0, delta: "ordinary text", partial: noToolPartial },
				],
				{ type: "done", reason: "length", message: createAssistantMessage([], "length") },
			),
			createScriptedProtocol(
				() => [],
				() => [],
			),
			[weatherTool],
		);
		await collectEvents(noToolOuterStream);
		expect((await noToolOuterStream.result()).stopReason).toBe("length");
	});
}
