import { describe, expect, it } from "vitest";
import {
	addAnthropicNativeToolSearch,
	buildToolReferenceBlocks,
} from "../../../src/core/extensions/builtin/tool-search/native-search.ts";
import { supportsAnthropicNativeToolSearch } from "../../../src/core/extensions/builtin/tool-search/native-support.ts";

// Anthropic's tool-search contract, spelled out as literals on purpose:
// importing the production constants would make these assertions tautologies
// that pass for any value the constants hold.
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
const CONTRACT_TYPE = "tool_search_tool_bm25_20251119";
const CONTRACT_NAME = "tool_search_tool_bm25";
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

function anthropicModel(id: string) {
	return { api: "anthropic-messages" as const, id, provider: "anthropic" };
}

describe("Anthropic native tool-search wire contract", () => {
	it("names tool_reference targets through tool_name", () => {
		// given two discovered tool names
		const names = ["mcp_docs_get-library-docs", "mcp_docs_resolve-library-id"];

		// when the reference blocks are built for a tool_result
		const blocks = buildToolReferenceBlocks(names);

		// then each block carries the API's `tool_name` field, never a bare `name`
		expect(blocks).toEqual([
			{ type: "tool_reference", tool_name: "mcp_docs_get-library-docs" },
			{ type: "tool_reference", tool_name: "mcp_docs_resolve-library-id" },
		]);
		expect(blocks.every((block) => !("name" in block))).toBe(true);
	});

	it("injects the server tool under the exact type and name pair", () => {
		// given a payload carrying the local tool_search tool plus a deferrable MCP tool
		const payload = catalogPayload();

		// when the native adapter injects the Anthropic server tool
		const tools = toolsOf(addAnthropicNativeToolSearch(anthropicModel("claude-opus-5"), payload, CONFIG));

		// then exactly one injected object carries the canonical type/name pair
		expect(tools.filter((tool) => tool.type === CONTRACT_TYPE)).toEqual([
			{ type: CONTRACT_TYPE, name: CONTRACT_NAME },
		]);
	});
});

describe("Anthropic native tool-search model gate", () => {
	it.each([
		["claude-fable-5-1", true],
		["claude-opus-5", true],
		["claude-opus-4-8", true],
		["claude-sonnet-4-5-20250929", true],
		["claude-opus-4-1", false],
		["claude-haiku-4-5-20251001", false],
		["claude-3-5-sonnet-20241022", false],
	])("resolves %s to %s per Anthropic's compatibility table", (id, supported) => {
		// given a first-party Anthropic model id
		// when the gate classifies it
		// then it matches the documented tool-search support
		expect(supportsAnthropicNativeToolSearch(anthropicModel(id))).toBe(supported);
	});

	it("leaves an Anthropic-compatible third-party endpoint untouched", () => {
		// given a proxy that answers anthropic-messages but rejects the server tool
		const payload = catalogPayload();
		const proxied = { api: "anthropic-messages" as const, id: "claude-opus-5", provider: "openmodel" };

		// when the native adapter runs against it
		const out = addAnthropicNativeToolSearch(proxied, payload, CONFIG);

		// then the payload is returned unmutated, so no 400 disables search for the session
		expect(supportsAnthropicNativeToolSearch(proxied)).toBe(false);
		expect(out).toBe(payload);
	});

	it("honours an explicit compat override over the model-id default", () => {
		// given a third-party endpoint that declares tool-reference support
		const overridden = {
			api: "anthropic-messages" as const,
			id: "claude-opus-4-1",
			provider: "openmodel",
			compat: { supportsToolReferences: true },
		};

		// when the gate classifies it
		// then the declared capability wins over the id-derived default
		expect(supportsAnthropicNativeToolSearch(overridden)).toBe(true);
	});

	it("keeps the api-only contract for callers that pass no model", () => {
		// given a bare api string, which carries no model identity to gate on
		// when the gate classifies it
		// then anthropic-messages stays supported and every other api stays out
		expect(supportsAnthropicNativeToolSearch("anthropic-messages")).toBe(true);
		expect(supportsAnthropicNativeToolSearch("openai-responses")).toBe(false);
		expect(supportsAnthropicNativeToolSearch(undefined)).toBe(false);
	});
});
