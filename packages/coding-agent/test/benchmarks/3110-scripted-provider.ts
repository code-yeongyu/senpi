// senpi#3110 benchmark provider, loaded into the host with `-e`: each run makes `BENCH_TOOLS_PER_RUN` `read`
// calls, then answers with text, so a run stays active the way a working task child does. No call log is kept.
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";

const TOOLS_PER_RUN = Number(process.env.BENCH_TOOLS_PER_RUN ?? "20");
const LATENCY_MS = Number(process.env.BENCH_LATENCY_MS ?? "200");
const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantTurnsSinceUser(context: TranscriptContext): number {
	let count = 0;
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const role = context.messages[index]?.role;
		if (role === "user") break;
		if (role === "assistant") count++;
	}
	return count;
}

function reply(model: Model<string>, context: TranscriptContext): AssistantMessage {
	const base = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, usage: USAGE };
	if (assistantTurnsSinceUser(context) < TOOLS_PER_RUN) {
		const id = `bench-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const call = { type: "toolCall" as const, id, name: "read", arguments: { path: "README.md" } };
		return { ...base, content: [call], stopReason: "toolUse", timestamp: Date.now() };
	}
	return { ...base, content: [{ type: "text", text: "run done" }], stopReason: "stop", timestamp: Date.now() };
}

async function run(
	stream: AssistantMessageEventStream,
	model: Model<string>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) {
	await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
	const message = reply(model, context);
	if (options?.signal?.aborted) {
		const aborted: AssistantMessage = { ...message, content: [], stopReason: "aborted", errorMessage: "aborted" };
		stream.push({ type: "error", reason: "aborted", error: aborted });
		stream.end(aborted);
		return;
	}
	stream.push({ type: "start", partial: { ...message, content: [] } });
	stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
	stream.end(message);
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("bench3110", {
		name: "bench3110",
		baseUrl: "http://localhost:0",
		apiKey: "bench-key",
		api: "bench3110",
		streamSimple: (model, context, options) => {
			const stream = createAssistantMessageEventStream();
			void run(stream, model, context, options);
			return stream;
		},
		models: [
			{
				id: "m1",
				name: "bench3110",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 32_000,
			},
		],
	});
}
