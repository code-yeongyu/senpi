import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { addAnthropicWebSearchToPayload } from "../../src/core/extensions/builtin/anthropic-web-search/index.ts";
import { addOpenAiWebSearchToPayload } from "../../src/core/extensions/builtin/openai-web-search/index.ts";
import {
	additionalServerSearch,
	hasServerSearch,
	serverSearchFailure,
	serverSearchPayload,
} from "../../src/core/extensions/builtin/websearch/server-search.ts";
import { resolveNativeSearchModel } from "../../src/core/extensions/builtin/websearch/websearch/search-model.ts";

function model(api: Api, provider: string, id: string) {
	return { api, provider, id, baseUrl: "https://example.com" } as Model<Api>;
}

describe("provider-specific server search payloads", () => {
	it("uses OpenRouter's own server tool without leaking the upstream vendor's tool shape", () => {
		const route = model("openai-completions", "openrouter", "anthropic/claude-opus-5");
		route.compat = { supportsWebSearch: true };
		expect(
			serverSearchPayload(route, {
				tools: [
					{ type: "function", function: { name: "web_search" } },
					{ type: "function", function: { name: "read" } },
				],
			}),
		).toEqual({
			tools: [{ type: "function", function: { name: "read" } }, { type: "openrouter:web_search" }],
		});
	});

	it("adds Google grounding alongside non-search function declarations on a supported generation model", () => {
		const route = model("google-generative-ai", "google", "gemini-3-pro-preview");
		route.compat = { supportsWebSearch: true };
		expect(
			serverSearchPayload(route, {
				contents: [{ role: "user", parts: [{ text: "Latest documentation?" }] }],
				config: { tools: [{ functionDeclarations: [{ name: "read" }, { name: "web_search" }] }] },
			}),
		).toEqual({
			contents: [{ role: "user", parts: [{ text: "Latest documentation?" }] }],
			config: { tools: [{ functionDeclarations: [{ name: "read" }] }, { googleSearch: {} }] },
		});
	});

	it("does not enable PAYG tool shapes on coding-plan endpoints or change a session API", () => {
		expect(additionalServerSearch(model("openai-completions", "deepseek", "deepseek-v4-pro"))).toBeUndefined();
		expect(additionalServerSearch(model("openai-completions", "zai", "glm-5"))).toBeUndefined();
		expect(hasServerSearch(model("anthropic-messages", "kimi-coding", "kimi-for-coding"))).toBe(false);
		expect(hasServerSearch(model("openai-completions", "xai", "grok-4.7"))).toBe(false);
		expect(additionalServerSearch(model("google-generative-ai", "google", "gemini-2.5-pro"))).toBeUndefined();
	});

	it("uses Moonshot's built-in search on its PAYG route, but not on Kimi coding", () => {
		const route = model("openai-completions", "moonshotai", "kimi-k3");
		route.compat = { supportsWebSearch: true };
		expect(
			serverSearchPayload(route, {
				tools: [{ type: "function", function: { name: "web_search" } }],
			}),
		).toEqual({
			tools: [{ type: "builtin_function", function: { name: "$web_search" } }],
		});
	});

	it("enables Z.AI in-chat search only after explicit route capability opt-in", () => {
		const route = model("openai-completions", "zai", "glm-5");
		route.compat = { supportsWebSearch: true };
		expect(serverSearchPayload(route, { tools: [] })).toEqual({
			tools: [{ type: "web_search", web_search: { enable: true, search_result: true } }],
		});
		route.compat.supportsWebSearch = false;
		expect(hasServerSearch(route)).toBe(false);
	});

	it("preserves opaque Messages history when replacing a failed native tool with the function fallback", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "server_tool_use", id: "s", name: "web_search", input: { query: "docs" } },
					{ type: "web_search_tool_result", tool_use_id: "s", content: [{ encrypted_content: "opaque==" }] },
				],
			},
		];
		const payload = serverSearchPayload(
			model("anthropic-messages", "anthropic", "claude-opus-5-5"),
			{
				messages,
				tools: [
					{ type: "web_search_20250305", name: "web_search" },
					{ name: "web_search", input_schema: { type: "object" } },
				],
			},
			true,
		) as { messages: unknown };
		expect(payload.messages).toBe(messages);
	});

	it("recognizes a 200 response's native search error object without retrying cancellation", () => {
		const message = {
			role: "assistant",
			stopReason: "stop",
			content: [
				{
					type: "providerNative",
					subtype: "web_search_tool_result",
					raw: {
						type: "web_search_tool_result",
						content: { type: "web_search_tool_result_error", error_code: "unavailable" },
					},
				},
			],
		} as AssistantMessage;
		expect(serverSearchFailure(message)).toBe("server search result: unavailable");
		expect(serverSearchFailure({ ...message, stopReason: "aborted" })).toBeUndefined();
		expect(
			serverSearchFailure({
				...message,
				content: [
					{
						type: "providerNative",
						subtype: "web_search_call",
						raw: { type: "web_search_call", status: "failed" },
					},
				],
			}),
		).toBe("server search result: failed");
	});

	it("never defaults an eligible main-request route to a cheaper auxiliary model", () => {
		const route = {
			...model("anthropic-messages", "anthropic", "claude-opus-5-5"),
			baseUrl: "https://proxy.example/anthropic",
			compat: { supportsWebSearch: true },
			cost: { input: 15, output: 75 },
		};
		const cheaper = { ...route, id: "claude-haiku-4-5", cost: { input: 1, output: 5 } };
		const registry = {
			getAvailable: () => [route, cheaper],
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
		};
		expect(resolveNativeSearchModel(route, registry, undefined)).toEqual({ model: route.id, source: "session" });
		expect(resolveNativeSearchModel(route, registry, cheaper.id)).toEqual({ model: route.id, source: "session" });
	});

	it("keeps the fallback function even when native injectors run after the fallback handler", () => {
		const anthropic = { ...model("anthropic-messages", "anthropic", "opus"), compat: { supportsWebSearch: true } };
		const responses = {
			...model("openai-responses", "custom", "model"),
			compat: { supportsWebSearchPreview: true, webSearchToolType: "web_search" as const },
		};
		for (const [route, inject] of [
			[anthropic, addAnthropicWebSearchToPayload],
			[responses, addOpenAiWebSearchToPayload],
		] as const) {
			const fallback = serverSearchPayload(
				route,
				{
					tools:
						route.api === "anthropic-messages"
							? [{ name: "web_search", input_schema: { type: "object", additionalProperties: false } }]
							: [
									{
										type: "function",
										name: "web_search",
										parameters: { type: "object", additionalProperties: false },
										strict: true,
									},
								],
				},
				true,
			);
			const after = inject(route, fallback);
			expect(JSON.parse(JSON.stringify(after))).toEqual(JSON.parse(JSON.stringify(fallback)));
			expect(JSON.stringify(after)).not.toMatch(/web_search_20250305|"type":"web_search"/);
		}
	});

	it("keeps unrelated auth, quota and function-schema failures out of native fallback", () => {
		for (const errorMessage of [
			"401 invalid_api_key; request tools web_search_20250305",
			"429 quota exceeded; body echoes web_search_preview",
			"Invalid input_schema for function web_search",
		]) {
			expect(
				serverSearchFailure({
					content: [],
					stopReason: "error",
					errorMessage,
				}),
			).toBeUndefined();
		}
	});

	it("selects a custom Responses endpoint's explicitly declared search tool name", () => {
		const route = {
			...model("openai-responses", "custom-grok", "grok"),
			compat: { supportsWebSearchPreview: true, webSearchToolType: "web_search" as const },
		};
		expect(addOpenAiWebSearchToPayload(route, { tools: [] })).toMatchObject({
			tools: [{ type: "web_search" }],
		});
	});

	it("does not convert Sonar model errors into unsupported function-tool retries", () => {
		expect(
			serverSearchFailure(
				{
					content: [],
					stopReason: "error",
					errorMessage: "400 type: web_search unavailable",
				},
				model("openai-completions", "perplexity", "sonar-pro"),
			),
		).toBeUndefined();
	});

	it("tries explicitly enabled Gemini 2 grounding first and falls back on its mixed-tool rejection", () => {
		const route = model("google-generative-ai", "google", "gemini-2.5-pro");
		route.compat = { supportsWebSearch: true };
		expect(hasServerSearch(route)).toBe(true);
		expect(
			serverSearchFailure(
				{
					content: [],
					stopReason: "error",
					errorMessage: "Tool use with function calling is unsupported",
				},
				route,
			),
		).toBe("server search request rejected (mixed tools unsupported)");
		expect(hasServerSearch(model("google-generative-ai", "google", "gemini-2.5-flash-image"))).toBe(false);
	});
});
