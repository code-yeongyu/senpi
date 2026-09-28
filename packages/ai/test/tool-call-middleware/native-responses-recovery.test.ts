import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../../src/api/openai-responses-shared.ts";
import { wrapStreamWithModelRecovery } from "../../src/tool-call-middleware/index.ts";
import type { AssistantMessage, Model, Tool } from "../../src/types.ts";
import { AssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import { collectEvents } from "./invoke-recovery-stream-fixtures.ts";

const readTool: Tool = {
	name: "read",
	description: "Read a file",
	parameters: Type.Object({ path: Type.String() }),
};

function modelFor(id: string): Model<"openai-responses"> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider: "test-provider",
		baseUrl: "http://localhost",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

async function* parallelCalls(reverseEnds: boolean): AsyncIterable<ResponseStreamEvent> {
	const calls = [0, 1].map((index) => ({
		type: "function_call" as const,
		id: `fc_${index}`,
		call_id: `call_${index}`,
		name: "read",
		arguments: "",
	}));
	let sequence = 0;
	for (const [output_index, item] of calls.entries()) {
		yield { type: "response.output_item.added", output_index, item, sequence_number: sequence++ };
		yield {
			type: "response.function_call_arguments.delta",
			output_index,
			item_id: item.id,
			delta: `{"path":"file-${output_index}.txt"}`,
			sequence_number: sequence++,
		};
	}
	for (const output_index of reverseEnds ? [1, 0] : [0, 1]) {
		const item = calls[output_index];
		if (!item) throw new Error("Missing tool fixture");
		yield {
			type: "response.output_item.done",
			output_index,
			item: { ...item, arguments: `{"path":"file-${output_index}.txt"}` },
			sequence_number: sequence++,
		};
	}
}

describe("native Responses calls through model recovery", () => {
	// Regression for https://github.com/code-yeongyu/senpi/issues/2203.
	it.each([
		["kimi-k3", false],
		["kimi-k3", true],
		["claude-test", false],
		["claude-test", true],
	] as const)("preserves overlapping %s calls with reverseEnds=%s", async (id, reverseEnds) => {
		// given
		const model = modelFor(id);
		const output: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: 0,
		};
		const inner = new AssistantMessageEventStream();
		const recovered = wrapStreamWithModelRecovery(inner, model, [readTool]);
		const eventsPromise = collectEvents(recovered);

		// when
		inner.push({ type: "start", partial: output });
		await processResponsesStream(parallelCalls(reverseEnds), output, inner, model);
		output.stopReason = "toolUse";
		inner.push({ type: "done", reason: "toolUse", message: output });
		const events = await eventsPromise;
		const result = await recovered.result();

		// then
		expect(result.stopReason).toBe("toolUse");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([
			{ type: "toolCall", id: "call_0|fc_0", name: "read", arguments: { path: "file-0.txt" } },
			{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "file-1.txt" } },
		]);
		expect(
			events.flatMap((event) =>
				event.type === "toolcall_start" || event.type === "toolcall_end"
					? [{ type: event.type, index: event.contentIndex }]
					: [],
			),
		).toEqual([
			{ type: "toolcall_start", index: 0 },
			{ type: "toolcall_start", index: 1 },
			{ type: "toolcall_end", index: reverseEnds ? 1 : 0 },
			{ type: "toolcall_end", index: reverseEnds ? 0 : 1 },
		]);
		expect(events.filter((event) => event.type === "error")).toEqual([]);
		expect(events.filter((event) => event.type === "done")).toHaveLength(1);
	});
});
