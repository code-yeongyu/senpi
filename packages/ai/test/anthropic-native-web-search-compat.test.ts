import type Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const minimalEvents = [
	{
		event: "message_start",
		data: JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_test",
				usage: {
					input_tokens: 12,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		}),
	},
	{
		event: "message_delta",
		data: JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: {
				input_tokens: 12,
				output_tokens: 5,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		}),
	},
	{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
];

function createCapturingClient(response: Response, captured?: { params?: Record<string, unknown> }): Anthropic {
	return {
		messages: {
			create: (params: Record<string, unknown>) => {
				if (captured) captured.params = params;
				return {
					asResponse: async () => response,
				};
			},
		},
	} as unknown as Anthropic;
}

const nativeWebSearchTool = { type: "web_search_20250305", name: "web_search", max_uses: 8 };
const functionTool = {
	name: "read",
	description: "Read a file.",
	parameters: Type.Object({ path: Type.String() }),
};
const webSearchFunctionTool = {
	name: "web_search",
	description: "Search the web through a function fallback.",
	parameters: Type.Object({ query: Type.String() }),
};

const kimiCodingModel: Model<"anthropic-messages"> = {
	...getModel("anthropic", "claude-sonnet-4-5"),
	provider: "kimi-coding",
	baseUrl: "https://api.kimi.com/coding",
};

function createContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		tools: [functionTool],
	};
}

async function captureParams(
	model: Model<"anthropic-messages">,
	options?: {
		readonly context?: Context;
		readonly toolChoice?: { readonly type: "tool"; readonly name: string };
	},
): Promise<Record<string, unknown>> {
	const captured: { params?: Record<string, unknown> } = {};
	const stream = streamAnthropic(model, options?.context ?? createContext(), {
		client: createCapturingClient(createSseResponse(minimalEvents), captured),
		...(options?.toolChoice ? { toolChoice: options.toolChoice } : {}),
		onPayload: (payload) => {
			const params = payload as Record<string, unknown>;
			const tools = Array.isArray(params.tools) ? params.tools : [];
			return { ...params, tools: [...tools, nativeWebSearchTool] };
		},
	});
	await stream.result();
	if (!captured.params) {
		throw new Error("Expected the fake client to capture request params");
	}
	return captured.params;
}

function toolTypes(params: Record<string, unknown>): unknown[] {
	const tools = Array.isArray(params.tools) ? params.tools : [];
	return tools.map((tool) => (tool as Record<string, unknown>).type);
}

describe("Anthropic native web_search tool guard", () => {
	it("strips hook-injected web_search_* tools for Anthropic-compatible endpoints", async () => {
		// kimi-coding executes the server-side search but rejects the replayed
		// server_tool_use / web_search_tool_result blocks on the next request
		// with 400 `tool_call_id is not found`, wedging the session.
		const params = await captureParams(kimiCodingModel);

		expect(toolTypes(params)).not.toContain("web_search_20250305");
		const toolNames = (params.tools as Array<Record<string, unknown>>).map((tool) => tool.name);
		expect(toolNames).toContain("read");
	});

	it("keeps a forced named choice when a same-name function fallback remains", async () => {
		const params = await captureParams(kimiCodingModel, {
			context: {
				messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
				tools: [webSearchFunctionTool],
			},
			toolChoice: { type: "tool", name: "web_search" },
		});

		expect(params.tools).toMatchObject([
			{
				name: "web_search",
				description: "Search the web through a function fallback.",
				input_schema: webSearchFunctionTool.parameters,
			},
		]);
		expect(params.tool_choice).toEqual({ type: "tool", name: "web_search" });
	});

	it("removes a forced named choice when its native tool is the only matching tool", async () => {
		const params = await captureParams(kimiCodingModel, {
			context: {
				messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
				tools: [],
			},
			toolChoice: { type: "tool", name: "web_search" },
		});

		expect(params.tools).toBeUndefined();
		expect(params.tool_choice).toBeUndefined();
	});

	it("keeps web_search_* tools for the first-party Anthropic endpoint", async () => {
		const params = await captureParams(getModel("anthropic", "claude-sonnet-4-5"));

		expect(toolTypes(params)).toContain("web_search_20250305");
	});

	it("strips web_search_* tools when the Anthropic provider is redirected to a custom endpoint", async () => {
		const params = await captureParams({
			...getModel("anthropic", "claude-sonnet-4-5"),
			baseUrl: "https://anthropic-proxy.example/v1",
		});

		expect(toolTypes(params)).not.toContain("web_search_20250305");
	});

	it("keeps web_search_* tools when a compatible endpoint opts in via compat", async () => {
		const params = await captureParams({
			...kimiCodingModel,
			compat: { supportsWebSearch: true },
		});

		expect(toolTypes(params)).toContain("web_search_20250305");
	});
});

describe("Anthropic web-search replay guard", () => {
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	} as const;
	const serverToolUse = { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "x" } };
	const webSearchToolResult = {
		type: "web_search_tool_result",
		tool_use_id: "srvtoolu_1",
		content: [{ type: "web_search_result", title: "A", url: "https://a.example", encrypted_content: "enc" }],
	};

	function replayContext(model: Model<"anthropic-messages">): Context {
		return {
			messages: [
				{ role: "user", content: "hello", timestamp: 1 },
				{
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: [
						{ type: "providerNative", subtype: "server_tool_use", raw: serverToolUse },
						{ type: "providerNative", subtype: "web_search_tool_result", raw: webSearchToolResult },
						{ type: "text", text: "answer" },
					],
					usage,
					stopReason: "stop",
					timestamp: 2,
				},
				{ role: "user", content: "follow up", timestamp: 3 },
			],
		};
	}

	async function captureReplayedAssistantContent(model: Model<"anthropic-messages">): Promise<unknown> {
		const captured: { params?: Record<string, unknown> } = {};
		const stream = streamAnthropic(model, replayContext(model), {
			client: createCapturingClient(createSseResponse(minimalEvents), captured),
		});
		await stream.result();
		const messages = captured.params?.messages as Array<{ role: string; content: unknown }>;
		return messages.find((message) => message.role === "assistant")?.content;
	}

	it("drops same-model web-search server-tool blocks for endpoints without supportsWebSearch", async () => {
		// A session wedged before this fix has these blocks persisted; replaying
		// them keeps 400ing. Dropping the pair unwedges the session.
		const content = await captureReplayedAssistantContent(kimiCodingModel);

		expect(content).toEqual([{ type: "text", text: "answer" }]);
	});

	it("keeps same-model web-search server-tool blocks for the first-party endpoint", async () => {
		const content = await captureReplayedAssistantContent(getModel("anthropic", "claude-sonnet-4-5"));

		expect(content).toEqual([serverToolUse, webSearchToolResult, { type: "text", text: "answer" }]);
	});
});

describe("Anthropic server_tool_use input streaming", () => {
	it("accumulates input_json_delta into the stored server_tool_use block", async () => {
		// The block captured at content_block_start has `input: {}`; the actual
		// input streams via input_json_delta. Without accumulation, the replayed
		// server_tool_use always carries an empty input.
		const response = createSseResponse([
			minimalEvents[0],
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
				}),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: '{"query":' },
				}),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: '"senpi worktree"}' },
				}),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 1,
					content_block: {
						type: "web_search_tool_result",
						tool_use_id: "srvtoolu_1",
						content: [
							{
								type: "web_search_result",
								title: "Example",
								url: "https://example.com",
								encrypted_content: "enc",
							},
						],
					},
				}),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 1 }) },
			minimalEvents[1],
			minimalEvents[2],
		]);

		const stream = streamAnthropic(getModel("anthropic", "claude-sonnet-4-5"), createContext(), {
			client: createCapturingClient(response),
		});
		const result = await stream.result();

		expect(result.errorMessage).toBeUndefined();
		expect(result.content[0]).toEqual({
			type: "providerNative",
			subtype: "server_tool_use",
			raw: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "senpi worktree" } },
		});
		expect(result.content[1]).toMatchObject({
			type: "providerNative",
			subtype: "web_search_tool_result",
		});
	});
});
