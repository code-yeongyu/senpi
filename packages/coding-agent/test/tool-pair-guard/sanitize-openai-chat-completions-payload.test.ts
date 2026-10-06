import { type Context, type Model, normalizeContext } from "@earendil-works/pi-ai";
import { stream as streamMistral } from "@earendil-works/pi-ai/api/mistral-conversations";
import { describe, expect, it } from "vitest";
import { sanitizeOpenAIChatCompletionsPayload } from "../../src/core/extensions/builtin/tool-pair-guard/sanitize-openai-chat-completions-payload.ts";

describe("sanitizeOpenAIChatCompletionsPayload", () => {
	it.each(["paired", "orphan", "assistant-after-orphan"])("repairs %s native history on wire", async (history) => {
		const model: Model<"mistral-conversations"> = {
			id: "mistral-large-4",
			name: "Mistral Large 4",
			api: "mistral-conversations",
			provider: "mistral",
			baseUrl: "https://api.mistral.ai",
			reasoning: false,
			input: ["text"],
			contextWindow: 524288,
			maxTokens: 128,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "Read a file.", timestamp: 1 },
				{
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: [{ type: "toolCall", id: "123456789", name: "read", arguments: {} }],
					stopReason: "toolUse",
					timestamp: 2,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
				{
					role: "toolResult",
					toolCallId: "123456789",
					toolName: "read",
					content: [{ type: "text", text: "real output" }],
					isError: false,
					timestamp: 3,
				},
			],
		};
		if (history === "orphan") context.messages.splice(1, 1);
		if (history === "assistant-after-orphan") {
			const assistant = context.messages[1];
			if (assistant.role !== "assistant") throw new Error("Expected assistant fixture");
			assistant.content = [{ type: "text", text: "Earlier final answer" }];
			assistant.stopReason = "stop";
		}
		const original = structuredClone(context);
		const result = await streamMistral(model, normalizeContext(context), {
			apiKey: "test",
			onPayload: sanitizeOpenAIChatCompletionsPayload,
			fetch: async (_input, init) => {
				const wire = JSON.parse(String(init?.body));
				if (history === "orphan") {
					expect(wire.messages.map((message: { role: string }) => message.role)).toEqual(["user"]);
				} else if (history === "assistant-after-orphan") {
					expect(wire.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant"]);
					expect(wire.messages.at(-1)).toMatchObject({
						role: "assistant",
						prefix: true,
						content: [{ type: "text", text: "Earlier final answer" }],
					});
				} else {
					expect(wire.messages.at(-1)).toMatchObject({
						role: "tool",
						tool_call_id: "123456789",
						content: [{ type: "text", text: "real output" }],
					});
					expect(wire.messages[1].tool_calls[0].id).toBe("123456789");
				}
				return new Response(
					'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "OK" }]);
		expect(context).toEqual(original);
	});

	it("preserves native Mistral tool calls and their real responses before wire conversion", () => {
		const payload = {
			messages: [
				{ role: "user", content: "Read a file." },
				{
					role: "assistant",
					toolCalls: [{ id: "123456789", type: "function", function: { name: "read", arguments: "{}" } }],
				},
				{ role: "tool", toolCallId: "123456789", content: [{ type: "text", text: "real output" }] },
			],
		};
		const original = structuredClone(payload);
		expect(sanitizeOpenAIChatCompletionsPayload(payload)).toBe(payload);
		expect(payload).toEqual(original);
	});

	it("drops orphan native responses without mutating caller input", () => {
		const payload = {
			messages: [{ role: "tool", toolCallId: "123456789", content: "output" }],
		};
		expect(sanitizeOpenAIChatCompletionsPayload(payload)).toEqual({ messages: [] });
		expect(payload.messages).toHaveLength(1);
	});

	it("fills missing native parallel results in the same field format before a user message", () => {
		const assistant = {
			role: "assistant",
			toolCalls: [
				{ id: "123456789", type: "function", function: { name: "read", arguments: "{}" } },
				{ id: "987654321", type: "function", function: { name: "read", arguments: "{}" } },
			],
		};
		const actualResult = { role: "tool", toolCallId: "123456789", content: "real output" };
		const user = { role: "user", content: "Continue." };
		const payload = { messages: [assistant, actualResult, user] };
		expect(sanitizeOpenAIChatCompletionsPayload(payload)).toEqual({
			messages: [
				assistant,
				actualResult,
				{
					role: "tool",
					toolCallId: "987654321",
					content: "Tool output unavailable (interrupted before result)",
				},
				user,
			],
		});
		expect(payload.messages).toHaveLength(3);
	});

	it("drops duplicate native results while retaining the genuine first response", () => {
		const assistant = {
			role: "assistant",
			toolCalls: [{ id: "123456789", type: "function", function: { name: "read", arguments: "{}" } }],
		};
		const first = { role: "tool", toolCallId: "123456789", content: "real output" };
		const duplicate = { ...first, content: "duplicate" };
		expect(sanitizeOpenAIChatCompletionsPayload({ messages: [assistant, first, duplicate] })).toEqual({
			messages: [assistant, first],
		});
	});

	it("returns same reference for payload without messages", () => {
		const payload = {};
		expect(sanitizeOpenAIChatCompletionsPayload(payload)).toBe(payload);
	});

	it("returns same reference for non-object payloads", () => {
		expect(sanitizeOpenAIChatCompletionsPayload(null)).toBeNull();
		expect(sanitizeOpenAIChatCompletionsPayload("text")).toBe("text");
		expect(sanitizeOpenAIChatCompletionsPayload(42)).toBe(42);
	});

	it("returns same reference when all tool pairs are valid", () => {
		const payload = {
			messages: [
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: "{}" } }],
				},
				{ role: "tool", tool_call_id: "call-1", content: "ok" },
			],
		};

		expect(sanitizeOpenAIChatCompletionsPayload(payload)).toBe(payload);
	});

	it("removes a single orphan tool message", () => {
		const payload = {
			messages: [{ role: "tool", tool_call_id: "missing", content: "bad" }],
		};

		const result = sanitizeOpenAIChatCompletionsPayload(payload) as { messages: unknown[] };

		expect(result).not.toBe(payload);
		expect(result.messages).toHaveLength(0);
	});

	it("removes orphan tool messages and synthesizes missing paired output", () => {
		const payload = {
			messages: [
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: "{}" } }],
				},
				{ role: "tool", tool_call_id: "orphan", content: "bad" },
			],
		};

		const result = sanitizeOpenAIChatCompletionsPayload(payload) as {
			messages: Array<{ role: string; tool_call_id?: string; content?: string }>;
		};

		expect(result.messages).toHaveLength(2);
		expect(result.messages[0]?.role).toBe("assistant");
		expect(result.messages[1]).toEqual({
			role: "tool",
			tool_call_id: "call-1",
			content: "Tool output unavailable (interrupted before result)",
		});
	});

	it("keeps paired tool message and removes orphan from same conversation", () => {
		const payload = {
			messages: [
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: "{}" } }],
				},
				{ role: "tool", tool_call_id: "call-1", content: "ok" },
				{ role: "tool", tool_call_id: "call-2", content: "orphan" },
			],
		};

		const result = sanitizeOpenAIChatCompletionsPayload(payload) as { messages: Array<{ role: string }> };

		expect(result.messages).toHaveLength(2);
		expect(result.messages[1]?.role).toBe("tool");
	});

	it("inserts synthetic tool messages for assistant tool calls missing results", () => {
		const payload = {
			messages: [
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{ id: "call-1", type: "function", function: { name: "bash", arguments: "{}" } },
						{ id: "call-2", type: "function", function: { name: "ls", arguments: "{}" } },
					],
				},
				{ role: "tool", tool_call_id: "call-1", content: "ok" },
			],
		};

		const result = sanitizeOpenAIChatCompletionsPayload(payload) as {
			messages: Array<{ role: string; tool_call_id?: string; content?: string }>;
		};

		expect(result.messages).toEqual([
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{ id: "call-1", type: "function", function: { name: "bash", arguments: "{}" } },
					{ id: "call-2", type: "function", function: { name: "ls", arguments: "{}" } },
				],
			},
			{ role: "tool", tool_call_id: "call-1", content: "ok" },
			{
				role: "tool",
				tool_call_id: "call-2",
				content: "Tool output unavailable (interrupted before result)",
			},
		]);
	});

	it("inserts synthetic tool messages before the transcript advances", () => {
		const payload = {
			messages: [
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: "{}" } }],
				},
				{ role: "user", content: "hello" },
			],
		};

		const result = sanitizeOpenAIChatCompletionsPayload(payload) as { messages: Array<{ role: string }> };

		expect(result.messages).toEqual([
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: "{}" } }],
			},
			{
				role: "tool",
				tool_call_id: "call-1",
				content: "Tool output unavailable (interrupted before result)",
			},
			{ role: "user", content: "hello" },
		]);
	});

	it("removes duplicate tool messages for the same tool call", () => {
		const payload = {
			messages: [
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: "{}" } }],
				},
				{ role: "tool", tool_call_id: "call-1", content: "ok" },
				{ role: "tool", tool_call_id: "call-1", content: "duplicate" },
			],
		};

		const result = sanitizeOpenAIChatCompletionsPayload(payload) as {
			messages: Array<{ role: string; content?: string }>;
		};

		expect(result.messages).toHaveLength(2);
		expect(result.messages[1]).toEqual({ role: "tool", tool_call_id: "call-1", content: "ok" });
	});

	it("removes tool messages with missing or empty tool_call_id", () => {
		const payload = {
			messages: [
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: "{}" } }],
				},
				{ role: "tool", content: "missing" },
				{ role: "tool", tool_call_id: "", content: "empty" },
				{ role: "tool", tool_call_id: "call-1", content: "ok" },
			],
		};

		const result = sanitizeOpenAIChatCompletionsPayload(payload) as {
			messages: Array<{ role: string; content?: string; tool_call_id?: string }>;
		};

		expect(result.messages).toHaveLength(2);
		expect(result.messages[1]?.role).toBe("tool");
		expect(result.messages[1]?.tool_call_id).toBe("call-1");
	});

	it("returns a new payload and does not mutate input when modified", () => {
		const payload = {
			messages: [
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: "{}" } }],
				},
				{ role: "tool", tool_call_id: "call-1", content: "ok" },
				{ role: "tool", tool_call_id: "orphan", content: "drop" },
			],
		};

		const before = JSON.parse(JSON.stringify(payload)) as typeof payload;
		const result = sanitizeOpenAIChatCompletionsPayload(payload) as typeof payload;

		expect(result).not.toBe(payload);
		expect(payload).toEqual(before);
	});
});
