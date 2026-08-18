// Todo 33 — Anthropic native tool-search adapter (gated GO by the todo-29 spike).
//
// Exercises the request-side injection + HARD RULES against the request
// validator mock (which 400s on violation exactly as the API would), the
// tool_reference expansion, the 400 -> local-fallback path, the config-off
// no-op, and Metis M5 co-residence with anthropic-web-search + a cache_control
// tail tool + a service_tier field.

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { addAnthropicWebSearchToPayload } from "../../src/core/extensions/builtin/anthropic-web-search/index.ts";
import toolSearchExtension from "../../src/core/extensions/builtin/tool-search/index.ts";
import {
	ANTHROPIC_TOOL_SEARCH_TYPE,
	AnthropicNativeToolSearchAdapter,
	addAnthropicNativeToolSearch,
	buildToolReferenceBlocks,
	installMcpNativeToolSearchGate,
	isMcpNativeToolSearchEnabled,
} from "../../src/core/extensions/builtin/tool-search/native-search.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../src/core/extensions/types.ts";
import {
	mockAnthropicExpandToolReferences,
	validateAnthropicToolSearchPayload,
} from "../mcp/fixtures/native-search-mocks.ts";
import { createHarness } from "../suite/harness.ts";

const CONFIG = {
	searchToolName: "tool_search",
	isDeferrable: (name: string) => name.startsWith("mcp_") && name !== "tool_search",
};

function toolsOf(payload: unknown): Record<string, unknown>[] {
	return ((payload as { tools?: unknown[] }).tools ?? []).filter(
		(tool): tool is Record<string, unknown> => typeof tool === "object" && tool !== null,
	);
}
function named(tools: Record<string, unknown>[], name: string): Record<string, unknown> | undefined {
	return tools.find((tool) => tool.name === name);
}
function searchTool(tools: Record<string, unknown>[]): Record<string, unknown>[] {
	return tools.filter((tool) => tool.type === ANTHROPIC_TOOL_SEARCH_TYPE);
}

function mcpToolsPayload(count: number): { tools: Record<string, unknown>[] } {
	const tools: Record<string, unknown>[] = [{ name: "tool_search", description: "search", input_schema: {} }];
	for (let i = 1; i <= count; i += 1) {
		tools.push({ name: `mcp_docs_tool-${i}`, description: `tool ${i}`, input_schema: {} });
	}
	return { tools };
}

describe("todo 9 generalized catalog injection", () => {
	it("wires non-MCP extension catalog membership into native deferral", async () => {
		const searchableExtension: ExtensionFactory = (pi: ExtensionAPI) => {
			pi.registerTool({
				name: "weather_forecast",
				label: "Weather Forecast",
				description: "Forecast weather",
				exposure: "search",
				parameters: Type.Object({ city: Type.String() }),
				execute: async () => ({ content: [{ type: "text", text: "sunny" }], details: {} }),
			});
		};
		const harness = await createHarness({
			api: "anthropic-messages",
			extensionFactories: [
				{ factory: toolSearchExtension, path: "<builtin:tool-search>" },
				{ factory: searchableExtension, path: "/workspace/extensions/weather.ts" },
			],
		});
		try {
			const output = await harness.getExtensionRunner().emitBeforeProviderRequest({
				tools: [{ name: "tool_search", description: "Search", input_schema: {} }],
			});

			expect(named(toolsOf(output), "weather_forecast")).toMatchObject({
				name: "weather_forecast",
				description: "Forecast weather",
				defer_loading: true,
			});
		} finally {
			harness.cleanup();
		}
	});

	it("injects an inactive searchable extension tool schema with defer_loading", () => {
		const parameters = { type: "object", properties: { city: { type: "string" } }, required: ["city"] };
		const payload = { tools: [{ name: "tool_search", description: "search", input_schema: {} }] };
		const out = addAnthropicNativeToolSearch("anthropic-messages", payload, {
			...CONFIG,
			getCatalog: () => [
				{
					name: "weather_forecast",
					label: "Weather Forecast",
					aliases: [],
					description: "Forecast weather",
					keywords: [],
					source: "extension" as const,
					group: "weather",
					ownerLabel: "weather",
					registrationId: "weather.ts\0weather_forecast",
				},
			],
			getToolDefinition: (name) =>
				name === "weather_forecast" ? { description: "Forecast weather", parameters } : undefined,
			isDeferrable: (name) => name === "weather_forecast",
		});

		expect(named(toolsOf(out), "weather_forecast")).toEqual({
			name: "weather_forecast",
			description: "Forecast weather",
			input_schema: parameters,
			defer_loading: true,
		});
	});

	it("gates inactive MCP catalog injection on the MCP nativeToolSearch setting", () => {
		const catalog = [
			{
				name: "mcp_weather_forecast",
				label: "Weather Forecast",
				aliases: ["forecast"],
				description: "Forecast weather",
				keywords: [],
				source: "mcp" as const,
				group: "weather",
				ownerLabel: "weather",
				registrationId: "mcp\\0weather\\0forecast",
			},
		];
		const makeAdapter = () =>
			new AnthropicNativeToolSearchAdapter({
				enabled: () => isMcpNativeToolSearchEnabled(),
				searchToolName: "tool_search",
				getCatalog: () => catalog,
				getToolDefinition: () => ({ description: "Forecast weather", parameters: { type: "object" } }),
				isDeferrable: () => isMcpNativeToolSearchEnabled(),
			});
		const payload = { tools: [{ name: "tool_search", description: "search", input_schema: {} }] };

		installMcpNativeToolSearchGate(() => false);
		expect(makeAdapter().applyBeforeRequest("anthropic-messages", payload)).toBe(payload);
		installMcpNativeToolSearchGate(() => true);
		expect(
			named(toolsOf(makeAdapter().applyBeforeRequest("anthropic-messages", payload)), "mcp_weather_forecast"),
		).toMatchObject({ defer_loading: true, input_schema: { type: "object" } });
		installMcpNativeToolSearchGate(() => false);
	});

	it("does not re-defer an active extension tool and skips definitions without parameters", () => {
		const catalog = [
			{
				name: "weather_forecast",
				label: "Weather Forecast",
				aliases: [],
				description: "Forecast weather",
				keywords: [],
				source: "extension" as const,
				group: "weather",
				ownerLabel: "weather",
				registrationId: "weather.ts\\0weather_forecast",
			},
			{
				name: "malformed_tool",
				label: "Malformed",
				aliases: [],
				keywords: [],
				source: "extension" as const,
				group: "weather",
				ownerLabel: "weather",
				registrationId: "weather.ts\\0malformed_tool",
			},
		];
		const active = { name: "weather_forecast", description: "Forecast weather", input_schema: {} };
		const out = addAnthropicNativeToolSearch(
			"anthropic-messages",
			{ tools: [active] },
			{
				searchToolName: "tool_search",
				getCatalog: () => catalog,
				getToolDefinition: (name) =>
					name === "weather_forecast" ? { description: "Forecast weather", parameters: {} } : {},
				isDeferrable: (name) => name === "malformed_tool",
			},
		);

		expect(named(toolsOf(out), "weather_forecast")?.defer_loading).toBeUndefined();
		expect(named(toolsOf(out), "malformed_tool")).toBeUndefined();
	});

	it("activates and executes a natively injected inactive tool when the model calls it", async () => {
		const searchableExtension: ExtensionFactory = (pi: ExtensionAPI) => {
			pi.registerTool({
				name: "weather_forecast",
				label: "Weather Forecast",
				description: "Forecast weather",
				exposure: "search",
				parameters: Type.Object({ city: Type.String() }),
				execute: async (_id, params) => ({
					content: [{ type: "text" as const, text: `forecast:${params.city}` }],
					details: {},
				}),
			});
		};
		const harness = await createHarness({
			extensionFactories: [
				{ factory: toolSearchExtension, path: "<builtin:tool-search>" },
				{ factory: searchableExtension, path: "/workspace/extensions/weather.ts" },
			],
		});
		try {
			await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
			expect(harness.session.getActiveToolNames()).not.toContain("weather_forecast");
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("weather_forecast", { city: "Seoul" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("call the deferred weather tool");

			expect(harness.session.getActiveToolNames()).toContain("weather_forecast");
			expect(JSON.stringify(harness.sessionManager.getEntries())).toContain("forecast:Seoul");
			if (process.env.TOOL_SEARCH_NATIVE_QA === "1") {
				const payload = addAnthropicNativeToolSearch(
					"anthropic-messages",
					{ tools: [{ name: "tool_search", description: "Search", input_schema: {} }] },
					{
						searchToolName: "tool_search",
						getCatalog: () => [
							{
								name: "weather_forecast",
								label: "Weather Forecast",
								aliases: [],
								description: "Forecast weather",
								keywords: [],
								source: "extension",
								group: "weather",
								ownerLabel: "weather",
								registrationId: "weather.ts\\0weather_forecast",
							},
						],
						getToolDefinition: () => ({
							description: "Forecast weather",
							parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
						}),
						isDeferrable: (name) => name === "weather_forecast",
					},
				);
				console.log(
					JSON.stringify({
						payloadTools: (payload as { tools: unknown[] }).tools,
						resolvedActiveTools: harness.session.getActiveToolNames(),
						toolResult: harness.sessionManager
							.getEntries()
							.find((entry) => entry.type === "message" && entry.message.role === "toolResult"),
					}),
				);
			}
		} finally {
			harness.cleanup();
		}
	});
});

describe("todo33 anthropic native: injection + HARD RULES (validator 400s on violation)", () => {
	it("injects one native search tool and defers MCP tools; validator accepts", () => {
		const out = addAnthropicNativeToolSearch("anthropic-messages", mcpToolsPayload(3), CONFIG);
		const tools = toolsOf(out);
		expect(searchTool(tools)).toHaveLength(1);
		// tool_search itself is never deferred; the three catalog tools are.
		expect(named(tools, "tool_search")?.defer_loading).toBeUndefined();
		expect(named(tools, "mcp_docs_tool-1")?.defer_loading).toBe(true);
		expect(validateAnthropicToolSearchPayload(out)).toEqual({ status: 200 });
	});

	it("never combines defer_loading with cache_control (would be a 400)", () => {
		const payload = mcpToolsPayload(2);
		// Simulate the cache_control tail the anthropic-messages serializer adds.
		(payload.tools[payload.tools.length - 1] as Record<string, unknown>).cache_control = { type: "ephemeral" };
		const out = addAnthropicNativeToolSearch("anthropic-messages", payload, CONFIG);
		const cached = toolsOf(out).find((tool) => "cache_control" in tool);
		expect(cached?.defer_loading).toBeUndefined();
		expect(validateAnthropicToolSearchPayload(out)).toEqual({ status: 200 });
	});

	it("the validator really 400s on each violation (constraint tests exercise the 400 path)", () => {
		expect(
			validateAnthropicToolSearchPayload({
				tools: [{ name: "a", defer_loading: true, cache_control: {} }, { type: ANTHROPIC_TOOL_SEARCH_TYPE }],
			}).status,
		).toBe(400);
		expect(validateAnthropicToolSearchPayload({ tools: [{ name: "a", defer_loading: true }] }).status).toBe(400);
		expect(
			validateAnthropicToolSearchPayload({
				tools: [
					{ name: "a", defer_loading: true },
					{ type: ANTHROPIC_TOOL_SEARCH_TYPE, defer_loading: true },
				],
			}).status,
		).toBe(400);
	});

	it("skips injection above the 10k tool cap", () => {
		const payload = mcpToolsPayload(10001);
		const out = addAnthropicNativeToolSearch("anthropic-messages", payload, CONFIG);
		expect(out).toBe(payload);
	});

	it("is idempotent across the per-turn rebuild", () => {
		const once = addAnthropicNativeToolSearch("anthropic-messages", mcpToolsPayload(3), CONFIG);
		const twice = addAnthropicNativeToolSearch("anthropic-messages", once, CONFIG);
		expect(searchTool(toolsOf(twice))).toHaveLength(1);
		expect(toolsOf(twice)).toEqual(toolsOf(once));
	});
});

describe("todo33 anthropic native: tool_reference expansion", () => {
	it("emits tool_reference blocks the API expands back to tool names", () => {
		const blocks = buildToolReferenceBlocks(["mcp_docs_get-library-docs", "mcp_docs_resolve-library-id"]);
		const toolResult = { type: "tool_result", content: blocks };
		expect(mockAnthropicExpandToolReferences(toolResult)).toEqual([
			"mcp_docs_get-library-docs",
			"mcp_docs_resolve-library-id",
		]);
	});
});

describe("todo33 anthropic native: 400 -> local fallback", () => {
	it("disables native + fires onFallback on an injected 400; then leaves the payload untouched", () => {
		let fallback: string | null = null;
		const adapter = new AnthropicNativeToolSearchAdapter({
			...CONFIG,
			enabled: () => true,
			onFallback: (reason) => {
				fallback = reason;
			},
		});
		const injected = adapter.applyBeforeRequest("anthropic-messages", mcpToolsPayload(3));
		expect(searchTool(toolsOf(injected))).toHaveLength(1);

		adapter.noteResponseStatus(400);
		expect(adapter.disabled).toBe(true);
		expect(fallback).toContain("fell back to local tool_search");

		// Subsequent requests are byte-identical (no injection): session continues.
		const next = mcpToolsPayload(3);
		expect(adapter.applyBeforeRequest("anthropic-messages", next)).toBe(next);
	});

	it("ignores a 400 on a request it did not inject", () => {
		const adapter = new AnthropicNativeToolSearchAdapter({ ...CONFIG, enabled: () => false });
		const payload = mcpToolsPayload(3);
		expect(adapter.applyBeforeRequest("anthropic-messages", payload)).toBe(payload); // config off -> no-op
		adapter.noteResponseStatus(400);
		expect(adapter.disabled).toBe(false);
	});
});

describe("todo33 anthropic native: config off is a byte-identical no-op", () => {
	it("leaves the payload untouched for non-anthropic apis", () => {
		const payload = mcpToolsPayload(3);
		expect(addAnthropicNativeToolSearch("openai-responses", payload, CONFIG)).toBe(payload);
	});
});

describe("todo33 anthropic native: M5 co-residence with web-search + cache tail + service_tier", () => {
	it("produces a single valid tools array with no duplicate injections or defer+cache combos", () => {
		// Base payload: mcp catalog + a cache_control tail tool + a top-level
		// service_tier field (service-tier builtin) + web_search added last-ish.
		const base: Record<string, unknown> = {
			service_tier: "auto",
			tools: [
				{ name: "tool_search", description: "search", input_schema: {} },
				{ name: "mcp_docs_a", description: "a", input_schema: {} },
				{ name: "mcp_docs_b", description: "b", input_schema: {}, cache_control: { type: "ephemeral" } },
			],
		};
		// anthropic-web-search injects its native web_search tool.
		const withWeb = addAnthropicWebSearchToPayload("anthropic-messages", base);
		// Our adapter runs LAST (mcp builtin pinned last) and sees the final payload.
		const final = addAnthropicNativeToolSearch("anthropic-messages", withWeb, CONFIG);

		const tools = toolsOf(final);
		// Single tools array, exactly one native tool-search tool, one web_search.
		expect(searchTool(tools)).toHaveLength(1);
		expect(tools.filter((tool) => typeof tool.type === "string" && tool.type.startsWith("web_search_"))).toHaveLength(
			1,
		);
		// web_search (server tool, no plain name) is not deferred; cache tool not deferred.
		expect(named(tools, "mcp_docs_a")?.defer_loading).toBe(true);
		expect(named(tools, "mcp_docs_b")?.defer_loading).toBeUndefined();
		// service_tier preserved.
		expect((final as { service_tier?: string }).service_tier).toBe("auto");
		// The final captured payload is valid (no 400).
		expect(validateAnthropicToolSearchPayload(final)).toEqual({ status: 200 });
	});
});
