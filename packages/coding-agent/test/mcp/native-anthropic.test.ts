// Todo 33 — Anthropic native tool-search adapter (gated GO by the todo-29 spike).
//
// Exercises the request-side injection + HARD RULES against the request
// validator mock (which 400s on violation exactly as the API would), the
// tool_reference expansion, the 400 -> local-fallback path, the config-off
// no-op, and Metis M5 co-residence with anthropic-web-search + a cache_control
// tail tool + a service_tier field.

import { describe, expect, it } from "vitest";
import { addAnthropicWebSearchToPayload } from "../../src/core/extensions/builtin/anthropic-web-search/index.ts";
import {
	ANTHROPIC_TOOL_SEARCH_TYPE,
	AnthropicNativeToolSearchAdapter,
	addAnthropicNativeToolSearch,
	buildToolReferenceBlocks,
} from "../../src/core/extensions/builtin/mcp/expose/native-search.ts";
import {
	mockAnthropicExpandToolReferences,
	validateAnthropicToolSearchPayload,
} from "./fixtures/native-search-mocks.ts";

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
