import { describe, expect, it, vi } from "vitest";
import { warmPromptCache } from "../src/api/warm-prompt-cache.ts";
import { getBuiltinModel as getModel } from "../src/providers/all.ts";
import type { Context, Model } from "../src/types.ts";

const context: Context = {
	systemPrompt: "You are concise.",
	messages: [{ role: "user", content: "Hello", timestamp: 1 }],
	tools: [
		{
			name: "lookup",
			description: "Look something up",
			parameters: {
				type: "object",
				properties: { query: { type: "string" } },
				required: ["query"],
			},
		},
	],
};

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("warmPromptCache", () => {
	it("sends a native Anthropic max_tokens:0 request and parses usage", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return jsonResponse({
				id: "msg_warm",
				type: "message",
				role: "assistant",
				content: [],
				model: "claude-sonnet-4-5",
				stop_reason: "max_tokens",
				stop_sequence: null,
				usage: {
					input_tokens: 120,
					output_tokens: 0,
					cache_read_input_tokens: 90,
					cache_creation_input_tokens: 30,
				},
			});
		});

		const result = await warmPromptCache(getModel("anthropic", "claude-sonnet-4-5"), context, {
			apiKey: "test-key",
			fetch,
		});

		expect(fetch).toHaveBeenCalledOnce();
		expect(requestBody).toMatchObject({ max_tokens: 0, model: "claude-sonnet-4-5" });
		expect(requestBody).not.toHaveProperty("stream");
		expect(requestBody).not.toHaveProperty("thinking");
		expect(requestBody).not.toHaveProperty("tool_choice");
		expect(JSON.stringify(requestBody)).toContain('"cache_control"');
		expect(result).toEqual({
			supported: true,
			usage: { input: 120, output: 0, cacheRead: 90, cacheWrite: 30 },
			usageRaw: {
				input_tokens: 120,
				output_tokens: 0,
				cache_read_input_tokens: 90,
				cache_creation_input_tokens: 30,
			},
		});
	});

	it("returns unsupported without sending a request for non-native Anthropic lanes", async () => {
		const fetch = vi.fn();
		const gatewayModel = {
			...getModel("anthropic", "claude-sonnet-4-5"),
			provider: "gateway",
			baseUrl: "https://gateway.example.test/anthropic",
		} as Model<"anthropic-messages">;
		const nonAnthropicModel = {
			...gatewayModel,
			api: "openai-completions",
		} as unknown as Model<"openai-completions">;

		await expect(warmPromptCache(gatewayModel, context, { apiKey: "test-key", fetch })).resolves.toEqual({
			supported: false,
		});
		await expect(warmPromptCache(nonAnthropicModel, context, { apiKey: "test-key", fetch })).resolves.toEqual({
			supported: false,
		});
		expect(fetch).not.toHaveBeenCalled();
	});
});
