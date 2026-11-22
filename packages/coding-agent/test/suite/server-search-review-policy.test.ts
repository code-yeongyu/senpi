import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { disableServerSearch } from "../../src/core/extensions/builtin/server-search-fallback.ts";
import {
	additionalServerSearch,
	hasServerSearch,
	serverSearchPayload,
} from "../../src/core/extensions/builtin/websearch/server-search.ts";

const route = (api: Api, provider: string, id: string): Model<Api> => ({
	api,
	provider,
	id,
	name: id,
	baseUrl: "https://example.com",
	reasoning: false,
	input: ["text"],
	contextWindow: 10000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

describe("reviewed server search route policy", () => {
	it.each([
		["google-generative-ai", "google", "gemini-2.5-pro"],
		["google-vertex", "google-vertex", "gemini-3-pro-preview"],
		["openai-completions", "moonshotai", "kimi-k3"],
		["openai-completions", "openrouter", "anthropic/claude-opus-5"],
	] as const)("requires opt-in for %s/%s instead of enabling an unverified route", (api, provider, id) => {
		const model = route(api, provider, id);
		expect(additionalServerSearch(model)).toBeUndefined();
		expect(hasServerSearch(model)).toBe(false);
	});

	it.each([
		["anthropic-messages", "anthropic", "claude-opus-5-5"],
		["openai-responses", "openai", "gpt-6-luna"],
		["azure-openai-responses", "azure-openai", "gpt-6-luna"],
	] as const)("preserves main's shipped %s server-search default", (api, provider, id) => {
		const model = route(api, provider, id);
		model.baseUrl = api === "anthropic-messages" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
		expect(hasServerSearch(model)).toBe(true);
	});

	it("strips a stale Moonshot declaration from non-Moonshot requests even without native search", () => {
		const payload = {
			tools: [
				{ type: "function", function: { name: "$web_search", parameters: {} } },
				{ type: "function", function: { name: "read", parameters: {} } },
			],
		};
		expect(serverSearchPayload(route("openai-completions", "custom", "model"), payload)).toEqual({
			tools: [payload.tools[1]],
		});
		expect(payload.tools).toHaveLength(2);
	});

	it("preserves an intentional empty tools array when tool history requires it", () => {
		// senpi#3125: pi-ai retains tools: [] for LiteLLM-style proxies with tool history.
		const payload = {
			messages: [
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "read-1", type: "function", function: { name: "read", arguments: "{}" } }],
				},
				{ role: "tool", tool_call_id: "read-1", content: "File contents" },
			],
			tools: [],
		};
		const result = serverSearchPayload(route("openai-completions", "custom", "model"), payload);
		expect(result).toEqual(payload);
		expect(result).toBe(payload);
	});

	it("retains the provider-normalized fallback declaration in the existing Gemini tool entry", () => {
		const model = {
			...route("google-generative-ai", "google", "gemini-3-pro-preview"),
			compat: { supportsWebSearch: true },
		};
		const search = {
			name: "web_search",
			parametersJsonSchema: {
				type: "object",
				properties: { query: { type: "string" } },
				required: ["query"],
				additionalProperties: false,
			},
		};
		const read = { name: "read", parametersJsonSchema: { type: "object" } };
		const result = serverSearchPayload(
			model,
			{
				config: { tools: [{ functionDeclarations: [read, search] }, { googleSearch: {} }] },
			},
			true,
		);
		expect(result).toMatchObject({ config: { tools: [{ functionDeclarations: [read, search] }] } });
		expect(JSON.parse(JSON.stringify(result))).toEqual({
			config: { tools: [{ functionDeclarations: [read, search] }] },
		});
	});

	it("strips flat declarations, forced choices, and empty Gemini groups on other routes", () => {
		expect(
			serverSearchPayload(route("anthropic-messages", "anthropic", "opus"), {
				tools: [{ name: "$web_search", input_schema: {} }],
				tool_choice: { type: "tool", name: "$web_search" },
			}),
		).toEqual({});
		expect(
			serverSearchPayload(route("openai-responses", "openai", "model"), {
				tools: [{ type: "function", name: "$web_search", parameters: {} }],
				tool_choice: { type: "function", name: "$web_search" },
			}),
		).toEqual({});
		expect(
			serverSearchPayload(route("google-generative-ai", "google", "gemini-2.5-pro"), {
				config: { tools: [{ functionDeclarations: [{ name: "$web_search" }] }] },
			}),
		).toEqual({ config: {} });
	});

	it.each([
		["anthropic-messages", "custom", "opus"],
		["openai-completions", "deepseek", "deepseek-chat"],
		["openai-responses", "custom", "model"],
	] as const)(
		"keeps client search and its forced choice when server search is disabled on %s",
		(api, provider, id) => {
			const client =
				api === "anthropic-messages"
					? { name: "web_search", input_schema: { type: "object" } }
					: { type: "function", name: "web_search", parameters: { type: "object" } };
			const choice =
				api === "anthropic-messages"
					? { type: "tool", name: "web_search" }
					: { type: "function", name: "web_search" };
			const payload = { tools: [client], tool_choice: choice };
			expect(
				JSON.parse(JSON.stringify(serverSearchPayload(route(api, provider, id), disableServerSearch(payload)))),
			).toEqual(payload);
		},
	);

	it("preserves Gemini client declarations while excluding grounding", () => {
		const declaration = { name: "web_search", parametersJsonSchema: { type: "object" } };
		const result = serverSearchPayload(
			{ ...route("google-generative-ai", "google", "gemini-2.5-pro"), compat: { supportsWebSearch: true } },
			disableServerSearch({ config: { tools: [{ functionDeclarations: [declaration] }, { googleSearch: {} }] } }),
		);
		expect(JSON.parse(JSON.stringify(result))).toEqual({
			config: { tools: [{ functionDeclarations: [declaration] }] },
		});
	});

	it.each([
		["openai-completions", "deepseek", "deepseek-chat"],
		["anthropic-messages", "kimi-coding", "kimi"],
		["openai-responses", "openai", "model"],
	] as const)("does not add tools to a tool-less disabled %s request", (api, provider, id) => {
		const payload = { messages: [] };
		expect(
			JSON.parse(JSON.stringify(serverSearchPayload(route(api, provider, id), disableServerSearch(payload)))),
		).toEqual(payload);
	});
});
