import { describe, expect, it } from "vitest";
import { addAnthropicNativeToolSearch } from "../../../src/core/extensions/builtin/tool-search/native-search.ts";

// The Anthropic Messages tool-search server tool is identified by the exact
// pair {type:"tool_search_tool_bm25_20251119", name:"tool_search_tool_bm25"} --
// the dated type is the versioned server-tool identifier, and the name is the
// tool name the model invokes. Both literals are spelled out here on purpose:
// importing the production constants would make the assertion a tautology that
// passes for any value they hold.
const ANTHROPIC_CONTRACT_TYPE = "tool_search_tool_bm25_20251119";
const ANTHROPIC_CONTRACT_NAME = "tool_search_tool_bm25";
const LOCAL_SEARCH_TOOL_NAME = "tool_search";

const CONFIG = {
	searchToolName: LOCAL_SEARCH_TOOL_NAME,
	isDeferrable: (name: string) => name.startsWith("mcp_"),
};

function toolsOf(payload: unknown): Record<string, unknown>[] {
	return ((payload as { tools?: unknown[] }).tools ?? []).filter(
		(tool): tool is Record<string, unknown> => typeof tool === "object" && tool !== null,
	);
}

function catalogPayload(): { tools: Record<string, unknown>[] } {
	return {
		tools: [
			{ name: LOCAL_SEARCH_TOOL_NAME, description: "search", input_schema: {} },
			{ name: "mcp_docs_get-library-docs", description: "docs", input_schema: {} },
		],
	};
}

describe("Anthropic native tool-search canonical naming regression", () => {
	it("injects the server tool under the exact Anthropic type and name", () => {
		// given a payload carrying the local tool_search tool plus a deferrable MCP tool
		const payload = catalogPayload();

		// when the native adapter injects the Anthropic server tool
		const tools = toolsOf(addAnthropicNativeToolSearch("anthropic-messages", payload, CONFIG));

		// then exactly one injected object carries the canonical type/name pair
		const injected = tools.filter((tool) => tool.type === ANTHROPIC_CONTRACT_TYPE);
		expect(injected).toEqual([{ type: ANTHROPIC_CONTRACT_TYPE, name: ANTHROPIC_CONTRACT_NAME }]);
	});

	it("keeps the local tool_search custom tool resident and undeferred", () => {
		// given the same payload
		const payload = catalogPayload();

		// when the native adapter runs
		const tools = toolsOf(addAnthropicNativeToolSearch("anthropic-messages", payload, CONFIG));

		// then the local custom tool survives untouched alongside the server tool
		const local = tools.find((tool) => tool.name === LOCAL_SEARCH_TOOL_NAME && tool.type === undefined);
		expect(local).toEqual({ name: LOCAL_SEARCH_TOOL_NAME, description: "search", input_schema: {} });
	});

	it("leaves a non-anthropic payload byte-identical", () => {
		// given a payload destined for a non-Anthropic api
		const payload = catalogPayload();
		const before = JSON.stringify(payload);

		// when the native adapter runs against openai-responses
		const out = addAnthropicNativeToolSearch("openai-responses", payload, CONFIG);

		// then the very same object is returned, unmutated
		expect(out).toBe(payload);
		expect(JSON.stringify(out)).toBe(before);
	});
});
