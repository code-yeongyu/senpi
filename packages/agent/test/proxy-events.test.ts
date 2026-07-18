import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamProxy } from "../src/proxy.ts";

const model: Model<"openai-responses"> = {
	id: "proxy-test",
	name: "Proxy test",
	api: "openai-responses",
	provider: "test",
	baseUrl: "https://provider.example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
};

const context: Context = { messages: [] };

const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function streamSse(events: unknown[]): ReadableStream<Uint8Array> {
	const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(body));
			controller.close();
		},
	});
}

async function streamEvents(events: unknown[]): Promise<AssistantMessage> {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(streamSse(events))),
	);
	return streamProxy(model, context, {
		authToken: "test-token",
		proxyUrl: "https://proxy.example.test",
	}).result();
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("streamProxy toolcall_end", () => {
	it("preserves a flagged final tool call payload", async () => {
		const message = await streamEvents([
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "started-id", toolName: "get_weather" },
			{
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: {
					type: "toolCall",
					id: "final-id",
					name: "get_weather",
					arguments: {},
					incomplete: true,
					errorMessage: "Tool call was truncated mid-arguments",
				},
			},
			{ type: "done", reason: "toolUse", usage },
		]);

		expect(message.content).toEqual([
			{
				type: "toolCall",
				id: "final-id",
				name: "get_weather",
				arguments: {},
				incomplete: true,
				errorMessage: "Tool call was truncated mid-arguments",
			},
		]);
		expect(message.content[0]).not.toHaveProperty("partialJson");
	});

	it("legacy payloads reconstruct arguments from deltas", async () => {
		const message = await streamEvents([
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "legacy-id", toolName: "get_weather" },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"city":"Seoul"}' },
			{ type: "toolcall_end", contentIndex: 0 },
			{ type: "done", reason: "toolUse", usage },
		]);

		expect(message.content).toEqual([
			{ type: "toolCall", id: "legacy-id", name: "get_weather", arguments: { city: "Seoul" } },
		]);
	});

	it("legacy payloads without deltas degrade to empty arguments without an incomplete flag", async () => {
		const message = await streamEvents([
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "legacy-id", toolName: "get_weather" },
			{ type: "toolcall_end", contentIndex: 0 },
			{ type: "done", reason: "toolUse", usage },
		]);

		expect(message.content).toEqual([{ type: "toolCall", id: "legacy-id", name: "get_weather", arguments: {} }]);
		expect(message.content[0]).not.toHaveProperty("incomplete");
	});
});
