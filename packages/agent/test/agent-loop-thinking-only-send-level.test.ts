import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentLoopConfig, AgentMessage, StreamFn } from "../src/types.ts";

// omo#12316: thinking-off carried over to a model whose ladder has no `off` is sent at that model's lowest level.

function model(thinkingLevelMap: Model<"anthropic-messages">["thinkingLevelMap"]): Model<"anthropic-messages"> {
	return {
		id: "thinking-model",
		name: "thinking-model",
		api: "anthropic-messages",
		provider: "test",
		baseUrl: "https://example.invalid",
		reasoning: true,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

const reply: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "ok" }],
	api: "anthropic-messages",
	provider: "test",
	model: "thinking-model",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 0,
};

async function sentLevel(target: Model<"anthropic-messages">, reasoning: AgentLoopConfig["reasoning"]) {
	const sent: Array<string | undefined> = [];
	const streamFn: StreamFn = (_model, _context, options) => {
		sent.push(options?.reasoning);
		const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
			(event) => event.type === "done" || event.type === "error",
			(event) => (event.type === "done" ? event.message : reply),
		);
		queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: reply }));
		return stream;
	};
	const config: AgentLoopConfig = {
		model: target,
		...(reasoning ? { reasoning } : {}),
		convertToLlm: (messages: AgentMessage[]) => messages.filter((m): m is Message => m.role === "user"),
	};
	const messages = await agentLoop(
		[{ role: "user", content: "hi", timestamp: 0 }],
		{ messages: [], tools: [] },
		config,
		undefined,
		streamFn,
	).result();
	const last = messages.at(-1);
	return { sent, recorded: last?.role === "assistant" ? last.thinkingLevel : undefined };
}

describe("send-time thinking level (omo#12316)", () => {
	it.each([
		["off vetoed, low is the floor", { off: null, minimal: null, low: "low", medium: null, high: "high" }, "low"],
		["off and low vetoed", { off: null, minimal: null, low: null }, "medium"],
		["off supported", { off: "none" }, undefined],
		["no map", undefined, undefined],
	] as const)("thinking-off on a model with %s is sent as %s", async (_label, map, expected) => {
		const { sent, recorded } = await sentLevel(model(map), undefined);
		expect(sent).toEqual([expected]);
		expect(recorded).toBe(expected ?? "off");
	});

	it("an explicit level is never changed", async () => {
		const { sent } = await sentLevel(model({ off: null }), "high");
		expect(sent).toEqual(["high"]);
	});
});
