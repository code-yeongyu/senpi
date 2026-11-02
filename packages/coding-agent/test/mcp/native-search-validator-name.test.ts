import { describe, expect, it } from "vitest";
import { addAnthropicNativeToolSearch } from "../../src/core/extensions/builtin/tool-search/native-search.ts";
import {
	ANTHROPIC_TOOL_SEARCH_CONTRACT_NAME,
	ANTHROPIC_TOOL_SEARCH_TYPE,
	validateAnthropicToolSearchPayload,
} from "./fixtures/native-search-mocks.ts";

// The mock validator must reject what the real API rejects: a tool-search server
// tool whose `name` does not match its variant. Before this check existed, eleven
// focused files stayed green while production returned
// `tools.N.tool_search_tool_bm25_20251119.name: Input should be 'tool_search_tool_bm25'`.
describe("mock Anthropic validator: server tool name", () => {
	const CONFIG = { searchToolName: "tool_search", isDeferrable: (name: string) => name.startsWith("mcp_") };

	it("rejects the pre-fix wire shape with the production error path", () => {
		const result = validateAnthropicToolSearchPayload({
			tools: [
				{ name: "tool_search", description: "search", input_schema: {} },
				{ name: "mcp_docs_a", description: "docs", input_schema: {}, defer_loading: true },
				{ type: ANTHROPIC_TOOL_SEARCH_TYPE, name: "tool_search" },
			],
		});
		expect(result.status).toBe(400);
		expect(result.error).toBe(
			`invalid_request_error: tools.2.${ANTHROPIC_TOOL_SEARCH_TYPE}.name: Input should be '${ANTHROPIC_TOOL_SEARCH_CONTRACT_NAME}'`,
		);
	});

	it("accepts the payload the production adapter emits", () => {
		const payload = addAnthropicNativeToolSearch(
			"anthropic-messages",
			{
				tools: [
					{ name: "tool_search", description: "search", input_schema: {} },
					{ name: "mcp_docs_a", description: "docs", input_schema: {} },
				],
			},
			CONFIG,
		);
		expect(validateAnthropicToolSearchPayload(payload)).toEqual({ status: 200 });
	});
});
