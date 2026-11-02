import { type AssistantMessage, type Model, normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamProxy } from "../src/proxy.ts";

// senpi#5300: `message_tool_arguments_reset` replaces a tool call's raw arguments, so the next delta at offset 0
// carrying the whole prefix rebuilds them instead of appending a second copy.

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

const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function run(events: unknown[]): Promise<AssistantMessage> {
	const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(body)),
	);
	return streamProxy(model, normalizeContext({ messages: [] }), {
		authToken: "test-token",
		proxyUrl: "https://proxy.example.test",
	}).result();
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("streamProxy message_tool_arguments_reset", () => {
	it("a cut's empty reset makes the offset-0 delta replace the raw arguments, not double them", async () => {
		const message = await run([
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call", toolName: "read" },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"a' },
			{ type: "message_tool_arguments_reset", contentIndex: 0, rawArgumentPrefix: "", parsedThrough: 0 },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"a.ts"}' },
			{ type: "toolcall_end", contentIndex: 0 },
			{ type: "done", reason: "toolUse", usage },
		]);

		expect(message.content).toEqual([{ type: "toolCall", id: "call", name: "read", arguments: { path: "a.ts" } }]);
	});

	it("a reset carrying a raw prefix seeds the arguments the next delta extends", async () => {
		const message = await run([
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call", toolName: "read" },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"stale' },
			{ type: "message_tool_arguments_reset", contentIndex: 0, rawArgumentPrefix: '{"path":"b', parsedThrough: 10 },
			{ type: "toolcall_delta", contentIndex: 0, delta: '.ts"}' },
			{ type: "toolcall_end", contentIndex: 0 },
			{ type: "done", reason: "toolUse", usage },
		]);

		expect(message.content).toEqual([{ type: "toolCall", id: "call", name: "read", arguments: { path: "b.ts" } }]);
	});
});
