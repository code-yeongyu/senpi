import { type AssistantMessage, lazyStream, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { getAssistantCapture, pushAssistantProgress } from "../../ai/src/utils/assistant-capture.ts";
import { AssistantMessageEventStream } from "../../ai/src/utils/event-stream.ts";
import { Agent } from "../src/agent.ts";
import { createInternalAgentChannel, type OrderedAgentRecord } from "../src/internal-events.ts";
import type { AgentEvent } from "../src/types.ts";

const model: Model<"anthropic-messages"> = {
	id: "fixture",
	name: "fixture",
	api: "anthropic-messages",
	provider: "fixture",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function message(): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		timestamp: 1,
		stopReason: "pending",
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

describe("internal agent channel #4272", () => {
	it("delivers native-only progress through lazy forwarding before any following public event", async () => {
		const seen = Promise.withResolvers<void>();
		const source = new AssistantMessageEventStream({ captureBlocks: true });
		const partial = message();
		const records: OrderedAgentRecord[] = [];
		const publicEvents: AgentEvent[] = [];
		const internalChannel = createInternalAgentChannel();
		const agent = new Agent({
			internalChannel,
			initialState: { model },
			streamFn: () => lazyStream(model, async () => source),
		});
		const unsubscribe = internalChannel.subscribe((record) => {
			records.push(record);
			if ("progress" in record && record.progress.type === "message_block_state" && record.progress.phase === "end")
				seen.resolve();
		});
		agent.subscribe((event) => {
			publicEvents.push(event);
		});
		const running = agent.prompt("fixture");
		try {
			source.push({ type: "start", partial });
			const block = { type: "providerNative" as const, subtype: "fixture", raw: { value: 1 } };
			partial.content.push(block);
			pushAssistantProgress(source, { type: "message_block_state", contentIndex: 0, phase: "insert", block });
			block.raw.value = 2;
			pushAssistantProgress(source, { type: "message_block_state", contentIndex: 0, phase: "end", block });
			await seen.promise;
			expect(records.filter((record) => "progress" in record).map((record) => record.progress)).toEqual([
				{ type: "message_block_state", contentIndex: 0, phase: "insert", block: { ...block, raw: { value: 1 } } },
				{ type: "message_block_state", contentIndex: 0, phase: "end", block },
			]);
			expect(publicEvents.filter((event) => event.type === "message_update")).toEqual([]);
			const start = publicEvents.find(
				(event) => event.type === "message_start" && event.message.role === "assistant",
			);
			if (!start) throw new Error("no assistant message_start reached the public listener");
			expect(getAssistantCapture(start)?.message?.content).toEqual([]);
			expect(records.map((record) => record.sequence)).toEqual(records.map((_, index) => index + 1));
			expect(JSON.stringify(publicEvents)).not.toContain("message_block_state");
			expect(getAssistantCapture(start)?.message).not.toHaveProperty("messageId");
			expect(getAssistantCapture(start)?.message).not.toHaveProperty("turnId");
			expect(getAssistantCapture(start)?.message).not.toHaveProperty("runtimeItemKey");
		} finally {
			partial.stopReason = "stop";
			source.push({ type: "done", reason: "stop", message: partial });
			source.end(partial);
			await running;
			unsubscribe();
		}
	});

	it("stops delivering to a removed internal listener while a kept one still receives", async () => {
		const source = new AssistantMessageEventStream();
		const partial = message();
		source.push({ type: "done", reason: "stop", message: partial });
		const internalChannel = createInternalAgentChannel();
		const agent = new Agent({ internalChannel, initialState: { model }, streamFn: () => source });
		const removed = vi.fn();
		const kept = vi.fn();
		internalChannel.subscribe(removed)();
		const unsubscribe = internalChannel.subscribe(kept);
		await agent.prompt("fixture");
		unsubscribe();
		expect(kept).toHaveBeenCalled();
		expect(removed).not.toHaveBeenCalled();
	});

	it("orders agent thinking timing after the event it amends", async () => {
		const source = new AssistantMessageEventStream({ captureBlocks: true });
		const internalChannel = createInternalAgentChannel();
		const agent = new Agent({ internalChannel, initialState: { model }, streamFn: () => source });
		const records: OrderedAgentRecord[] = [];
		const unsubscribe = internalChannel.subscribe((record) => {
			records.push(record);
		});
		const partial = message();
		source.push({ type: "start", partial });
		partial.content.push({ type: "thinking", thinking: "" });
		source.push({ type: "thinking_start", contentIndex: 0, partial });
		source.push({ type: "thinking_end", contentIndex: 0, content: "", partial });
		partial.stopReason = "stop";
		source.push({ type: "done", reason: "stop", message: partial });
		source.end(partial);
		await agent.prompt("fixture");
		unsubscribe();
		// The provider captured each block before the agent stamped its timing, so the metadata must follow it.
		const order = records.flatMap((record) => {
			if ("progress" in record)
				return [
					Object.keys(record.progress)
						.filter((key) => key.endsWith("At"))
						.join("+"),
				];
			return record.event.type === "message_update" ? [record.event.assistantMessageEvent.type] : [];
		});
		expect(order).toEqual(["thinking_start", "startedAt", "thinking_end", "startedAt+endedAt"]);
	});

	// #4272: progress records are not provider liveness; the idle bound measures silence between public events as before.
	it("does not let internal progress extend the provider idle bound", async () => {
		vi.useFakeTimers();
		const source = new AssistantMessageEventStream({ captureBlocks: true });
		const internalChannel = createInternalAgentChannel();
		const agent = new Agent({ internalChannel, initialState: { model }, streamFn: () => source, timeoutMs: 100 });
		const ends: AgentEvent[] = [];
		agent.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") ends.push(event);
		});
		const progress: OrderedAgentRecord[] = [];
		const unsubscribe = internalChannel.subscribe((record) => {
			if ("progress" in record) progress.push(record);
		});
		const running = agent.prompt("fixture");
		try {
			source.push({ type: "start", partial: message() });
			for (let step = 0; step < 3; step++) {
				await vi.advanceTimersByTimeAsync(40);
				pushAssistantProgress(source, {
					type: "message_block_metadata",
					contentIndex: 0,
					thinkingSignatureDelta: "x",
				});
			}
			expect(progress).toHaveLength(2);
			expect(ends).toMatchObject([
				{ message: { stopReason: "error", errorMessage: "Idle timeout waiting for provider stream after 100ms" } },
			]);
		} finally {
			source.push({ type: "done", reason: "stop", message: message() });
			await vi.runAllTimersAsync();
			await running;
			unsubscribe();
			vi.useRealTimers();
		}
	});
});
