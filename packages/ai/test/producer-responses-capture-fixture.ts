import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

export const raw = '{ "value": "\\uD83D\\uDE00", "quote": "\\\\\\"𝄞" }';
function output(): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		content: [],
		stopReason: "pending",
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
export async function responses(seed = "", reset = false) {
	const stream = new AssistantMessageEventStream();
	const message = output();
	const item = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "echo", arguments: seed };
	const frames = [
		{ type: "response.output_item.added", output_index: 0, item },
		...[raw.slice(seed.length, 20), "", raw.slice(20)].map((delta) => ({
			type: "response.function_call_arguments.delta",
			output_index: 0,
			delta,
		})),
		...(reset
			? [{ type: "response.function_call_arguments.done", output_index: 0, arguments: '{ "reset": true }' }]
			: []),
		{
			type: "response.output_item.done",
			output_index: 0,
			item: { ...item, arguments: reset ? '{ "reset": true }' : raw },
		},
		{ type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [] } },
	] as ResponseStreamEvent[];
	await processResponsesStream(
		(async function* () {
			yield* frames;
		})(),
		message,
		stream,
		getModel("openai", "gpt-5") as Model<"openai-responses">,
	);
	stream.push({ type: "done", reason: "toolUse", message });
	stream.end(message);
	return stream;
}
