import {
	assistantRecords,
	getAssistantCapture,
	isAssistantProgress,
	normalizeContext,
	subscribeAssistantCapture,
	type AssistantMessage,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pushAssistantProgress } from "../../ai/src/utils/assistant-capture.ts";
import { AssistantMessageEventStream } from "../../ai/src/utils/event-stream.ts";
import { withEmptyAssistantRecovery } from "../src/empty-assistant-recovery.ts";
import { Agent } from "../src/agent.ts";
import { subscribeInternalAgent, type OrderedAgentRecord } from "../src/internal-events.ts";

const model: Model<"openai-completions"> = {
	id: "fixture",
	name: "fixture",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: { toolCallFormat: "kimi-xtml" },
};
function attempt(text: string) {
	const stream = new AssistantMessageEventStream({ captureBlocks: true });
	const message: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: 1,
		content: [],
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const start = { type: "start" as const, partial: message };
	stream.push(start);
	message.content.push({ type: "thinking", thinking: "" });
	stream.push({ type: "thinking_start", contentIndex: 0, partial: message });
	pushAssistantProgress(stream, {
		type: "message_block_metadata",
		contentIndex: 0,
		thinkingSignatureDelta: "discard-me",
	});
	stream.push({ type: "thinking_end", contentIndex: 0, content: "", partial: message });
	if (text) {
		message.content.push({ type: "text", text: "" });
		stream.push({ type: "text_start", contentIndex: 1, partial: message });
		message.content[1] = { type: "text", text };
		stream.push({ type: "text_delta", contentIndex: 1, delta: text, partial: message });
		stream.push({ type: "text_end", contentIndex: 1, content: text, partial: message });
	}
	stream.push({ type: "done", reason: "stop", message });
	return { stream, start };
}

let releaseCapture = () => {};
beforeEach(() => {
	releaseCapture = subscribeAssistantCapture();
});
afterEach(() => releaseCapture());

describe("discarded attempt capture isolation #4272", () => {
	it("drops every carrier and control from discarded and forwarded attempts", async () => {
		const first = attempt("");
		const second = attempt("kept");
		expect(getAssistantCapture(first.start)?.message?.content).toEqual([]);
		let calls = 0;
		const create = withEmptyAssistantRecovery(model, () => (++calls === 1 ? first.stream : second.stream));
		const wrapped = await create(model, normalizeContext({ messages: [] }), {});
		const records = [];
		for await (const record of assistantRecords(wrapped)) records.push(record);
		expect(calls).toBe(2);
		expect(records.filter(isAssistantProgress)).toEqual([]);
		expect(records.map(getAssistantCapture).every((capture) => capture === undefined)).toBe(true);
		expect(getAssistantCapture(first.start)).toBeUndefined();
		expect(getAssistantCapture(second.start)).toBeUndefined();
	});

	it("does not recreate timing controls in the agent after a downgraded attempt", async () => {
		let calls = 0;
		const agent = new Agent({ initialState: { model }, streamFn: () => attempt(++calls === 1 ? "" : "kept").stream });
		const records: OrderedAgentRecord[] = [];
		const unsubscribe = subscribeInternalAgent(agent, (record) => {
			records.push(record);
		});
		try {
			await agent.prompt("fixture");
			expect(calls).toBe(2);
			expect(records.filter((record) => "progress" in record)).toEqual([]);
			expect(
				records
					.filter((record) => "event" in record)
					.every((record) => getAssistantCapture(record.event) === undefined),
			).toBe(true);
		} finally {
			unsubscribe();
		}
	});
});
