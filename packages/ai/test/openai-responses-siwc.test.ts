import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { type OpenAIResponsesOptions, stream, warmOpenAIResponsesPromptCache } from "../src/api/openai-responses.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Model, Tool, TranscriptContext } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-responses"> = {
	...getModel("openai", "gpt-6-luna"),
	id: "siwc-test",
	reasoning: false,
	compat: { supportsDeveloperRole: false, supportsToolSearch: true },
};
const context = normalizeContext({
	systemPrompt: "system-marker",
	messages: [{ role: "user", content: "user-marker", timestamp: 1 }],
});
const forbidden = [
	"background",
	"conversation",
	"max_output_tokens",
	"max_tool_calls",
	"metadata",
	"moderation",
	"multi_agent",
	"prompt",
	"prompt_cache_retention",
	"safety_identifier",
	"temperature",
	"top_logprobs",
	"top_p",
	"truncation",
	"user",
	"previous_response_id",
] as const;

function target(siwc: boolean, supportsAdditionalTools = false): Model<"openai-responses"> {
	return { ...model, compat: { ...model.compat, siwc, supportsAdditionalTools } };
}

async function capture(
	targetModel: Model<"openai-responses">,
	transcript: TranscriptContext = context,
	options: OpenAIResponsesOptions = {},
): Promise<{ raw: string; body: Record<string, unknown> }> {
	let raw = "";
	const fetchStub: typeof fetch = async (_input, init) => {
		if (typeof init?.body !== "string") throw new Error("expected a JSON request body");
		raw = init.body;
		return new Response('data: {"type":"response.completed","response":{"id":"resp_test","output":[]}}\n\n', {
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await stream(targetModel, transcript, {
		apiKey: "synthetic-siwc-token",
		cacheRetention: "none",
		maxRetries: 0,
		...options,
		fetch: fetchStub,
	}).result();
	expect(result.stopReason).not.toBe("error");
	expect(raw).not.toBe("");
	return { raw, body: JSON.parse(raw) };
}

// senpi#5003 W8: assert the final HTTP body, after every caller-controlled override.
describe("SIWC Responses request contract", () => {
	it("removes unsupported fields and hosted tools after a payload hook", async () => {
		const { body } = await capture(target(true), context, {
			maxTokens: 128,
			temperature: 0.5,
			cacheRetention: "long",
			samplingParams: { top_p: 0.9, top_logprobs: 3 },
			extraBody: { metadata: { fixture: "synthetic" }, previous_response_id: "resp_old" },
			onPayload: (payload) => ({
				...(payload as Record<string, unknown>),
				...Object.fromEntries(forbidden.map((key) => [key, "unsupported"])),
				store: true,
				stream: false,
				tools: [
					{ type: "web_search" },
					...[
						"image_generation",
						"file_search",
						"code_interpreter",
						"computer",
						"mcp",
						"tool_search",
						"programmatic_tool_calling",
					].map((type) => ({ type })),
				],
				tool_choice: { type: "image_generation" },
			}),
		});
		expect(body.store).toBe(false);
		expect(body.stream).toBe(true);
		for (const key of forbidden) expect(body).not.toHaveProperty(key);
		expect(body.tools).toEqual([{ type: "web_search" }]);
		expect(body).not.toHaveProperty("tool_choice");
		expect(body.input).toEqual([
			{ role: "developer", content: "system-marker" },
			{ role: "user", content: [{ type: "input_text", text: "user-marker" }] },
		]);
	});

	it("uses HTTP with full history even when WebSocket continuation is requested", async () => {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
		let connections = 0;
		Object.defineProperty(globalThis, "WebSocket", {
			configurable: true,
			value: class {
				constructor() {
					connections++;
					throw new Error("unexpected WebSocket connection");
				}
			},
		});
		try {
			const { body } = await capture(target(true), context, {
				transport: "websocket",
				sessionId: "synthetic-session",
				extraBody: { previous_response_id: "resp_previous" },
			});
			expect(body).not.toHaveProperty("previous_response_id");
			expect(body.input).toHaveLength(2);
			expect(connections).toBe(0);
		} finally {
			if (descriptor) Object.defineProperty(globalThis, "WebSocket", descriptor);
			else Reflect.deleteProperty(globalThis, "WebSocket");
		}
	});

	it.each([false, true])("loads deferred tools without tool_search (additional_tools=%s)", async (additional) => {
		const read: Tool = { name: "read", description: "read fixture", parameters: Type.Object({}) };
		const late: Tool = { name: "late", description: "late fixture", parameters: Type.Object({}) };
		const call: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [{ type: "toolCall", id: "call_read", name: "read", arguments: {} }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		};
		const transcript = normalizeContext({
			systemPrompt: "system-marker",
			tools: [read, late],
			messages: [
				{ role: "user", content: "load", timestamp: 1 },
				call,
				{
					role: "toolResult",
					toolCallId: "call_read",
					toolName: "read",
					content: [{ type: "text", text: "loaded" }],
					addedToolNames: ["late"],
					isError: false,
					timestamp: 3,
				},
				{ role: "user", content: "continue", timestamp: 4 },
			],
		});
		const { body } = await capture(target(true, additional), transcript);
		const input = body.input as Array<{ type?: string; role?: string; tools?: Array<{ name: string }> }>;
		expect(input.some((item) => item.type === "tool_search_call" || item.type === "tool_search_output")).toBe(false);
		const eager = input[0]?.tools ?? [];
		expect(eager.map((tool) => tool.name)).toEqual(additional ? ["read"] : ["late", "read"]);
		const loaded = input.filter((item) => item.type === "additional_tools").flatMap((item) => item.tools ?? []);
		expect(loaded.map((tool) => tool.name)).toEqual(additional ? ["read", "late"] : ["late", "read"]);
		expect(body.tools).toEqual([]);
		expect(input.map((item) => item.type ?? item.role)).toEqual([
			"additional_tools",
			"developer",
			"user",
			"function_call",
			"function_call_output",
			...(additional ? ["additional_tools"] : []),
			"user",
		]);
	});

	it("rewrites explicit system items added by hooks without dropping history", async () => {
		const { body } = await capture(target(true), context, {
			onPayload: (payload) => ({
				...(payload as Record<string, unknown>),
				input: [
					...(payload as { input: object[] }).input,
					{ type: "message", role: "system", content: "hook-marker" },
				],
			}),
		});
		expect(body.input).toEqual([
			{ role: "developer", content: "system-marker" },
			{ role: "user", content: [{ type: "input_text", text: "user-marker" }] },
			{ type: "message", role: "developer", content: "hook-marker" },
		]);
	});

	it.each([
		[[{ type: "image_generation" }], "none"],
		[
			[{ type: "image_generation" }, { type: "function", name: "local" }],
			{ type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "local" }] },
		],
	])("filters unsupported allowed_tools references (%j)", async (references, expected) => {
		const { body } = await capture(target(true), context, {
			onPayload: (payload) => ({
				...(payload as Record<string, unknown>),
				tools: [{ type: "function", name: "local", parameters: {} }, { type: "image_generation" }],
				tool_choice: { type: "allowed_tools", mode: "auto", tools: references },
			}),
		});
		expect(body.tool_choice).toEqual(expected);
	});

	it("keeps local custom tools and namespaces without forwarding nested hosted tools", async () => {
		const { body } = await capture(target(true), context, {
			onPayload: (payload) => ({
				...(payload as Record<string, unknown>),
				tools: [
					{ type: "custom", name: "local", format: { type: "text" } },
					{
						type: "namespace",
						name: "fixtures",
						description: "fixture tools",
						tools: [{ type: "function", name: "read" }, { type: "file_search" }],
					},
				],
			}),
		});
		expect(body.tools).toEqual([
			{
				type: "namespace",
				name: "fixtures",
				description: "fixture tools",
				tools: [{ type: "function", name: "read" }],
			},
		]);
		expect(body.input).toEqual([
			{
				type: "additional_tools",
				role: "developer",
				tools: [{ type: "custom", name: "local", format: { type: "text" } }],
			},
			{ role: "developer", content: "system-marker" },
			{ role: "user", content: [{ type: "input_text", text: "user-marker" }] },
		]);
	});

	it("preserves the pre-SIWC serialized body byte for byte when disabled", async () => {
		const { raw } = await capture(target(false), context, {
			maxTokens: 128,
			temperature: 0.5,
			samplingParams: { top_p: 0.9 },
			extraBody: { metadata: { fixture: "synthetic" }, previous_response_id: "resp_old" },
		});
		expect(raw).toBe(
			'{"model":"siwc-test","input":[{"role":"system","content":"system-marker"},{"role":"user","content":[{"type":"input_text","text":"user-marker"}]}],"stream":true,"store":false,"max_output_tokens":128,"temperature":0.5,"metadata":{"fixture":"synthetic"},"previous_response_id":"resp_old","top_p":0.9}',
		);
	});

	it("does not send a non-streaming prompt-cache prewarm on the SIWC route", async () => {
		let requests = 0;
		await expect(
			warmOpenAIResponsesPromptCache(
				target(true),
				{ messages: [] },
				{
					apiKey: "synthetic-siwc-token",
					fetch: async () => {
						requests++;
						throw new Error("must not send");
					},
				},
			),
		).rejects.toThrow(/SIWC/);
		expect(requests).toBe(0);
	});
});
