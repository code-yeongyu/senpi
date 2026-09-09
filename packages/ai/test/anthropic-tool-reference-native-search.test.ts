import { describe, expect, it } from "vitest";
import type { Context } from "../src/types.ts";
import {
	allBlocks,
	blocksOf,
	captureParams,
	makeTool,
	messagesOf,
	nativeSearchReferenceNames,
	nativeSearchResultBlocks,
	nativeSearchTurn,
	toolNamesIn,
	userMessage,
} from "./anthropic-tool-reference-harness.ts";

/**
 * Anthropic's native tool search (`tool_search_tool_bm25`) hands the model a
 * `tool_search_tool_result` block whose `tool_reference` items name the tools it
 * found. Those blocks replay verbatim on the same model, and a gateway on the
 * wire path can hand the names back under an opaque namespace (`mcp__<id>__`)
 * and recased (`Memory` for `memory`). Every replayed reference must resolve
 * against the request's own `tools` array before the request is sent, or
 * Anthropic rejects it with "Tool reference '<name>' not found in available
 * tools".
 */

describe("Anthropic native tool-search reference integrity", () => {
	it("normalizes gateway-namespaced native search references to the request's tool names", async () => {
		// Live 2026-09-08: the native search result replayed
		// `mcp__925c__memory` while the request defined `memory`; the namespace
		// belongs to the wire path, not to senpi, and it does not survive across
		// requests, so the next turn 400ed with "Tool reference 'mcp__925c__memory'
		// not found in available tools".
		const context: Context = {
			messages: [userMessage("find a tool"), nativeSearchTurn(["mcp__925c__memory"]), userMessage("done")],
			tools: [makeTool("tool_search"), makeTool("memory")],
		};

		const params = await captureParams(context, undefined, "claude-sonnet-4-6");

		expect(toolNamesIn(params)).toContain("memory");
		expect(nativeSearchReferenceNames(params)).toEqual(["memory"]);
		expect(allBlocks(params).some((block) => block.type === "server_tool_use")).toBe(true);
	});

	it("keeps literal native search references and drops only the ones that no longer resolve", async () => {
		const context: Context = {
			messages: [
				userMessage("find a tool"),
				nativeSearchTurn(["memory", "mcp__925c__gone", "mcp__925c__todo"]),
				userMessage("done"),
			],
			tools: [makeTool("tool_search"), makeTool("memory"), makeTool("todo")],
		};

		const params = await captureParams(context, undefined, "claude-sonnet-4-6");

		expect(nativeSearchReferenceNames(params)).toEqual(["memory", "todo"]);
	});

	it("drops a native search pair whose every reference stopped resolving", async () => {
		const context: Context = {
			messages: [userMessage("find a tool"), nativeSearchTurn(["mcp__925c__gone"]), userMessage("done")],
			tools: [makeTool("tool_search"), makeTool("memory")],
		};

		const params = await captureParams(context, undefined, "claude-sonnet-4-6");

		expect(nativeSearchResultBlocks(params)).toHaveLength(0);
		expect(allBlocks(params).some((block) => block.type === "server_tool_use")).toBe(false);
		// The assistant turn survives as text so the transcript keeps its shape.
		const assistant = messagesOf(params).filter((message) => message.role === "assistant");
		expect(assistant).toHaveLength(1);
		expect(blocksOf(assistant[0]!).every((block) => block.type === "text")).toBe(true);
		expect(JSON.stringify(params)).not.toContain('"tool_name":"mcp__925c__gone"');
	});

	it("folds a recased gateway-namespaced native search reference onto the request's tool name", async () => {
		// Live 2026-09-08 (session 01a08016): the search result came back as
		// mcp__a4e6__Memory / mcp__a4e6__LspSymbols / mcp__a4e6__XSearch for the
		// request tools memory / lsp_symbols / x_search; a hyphenated MCP tool kept
		// its literal name under the namespace.
		const context: Context = {
			messages: [
				userMessage("find a tool"),
				nativeSearchTurn([
					"mcp__a4e6__Memory",
					"mcp__a4e6__LspSymbols",
					"mcp__a4e6__XSearch",
					"mcp__a4e6__cloudflare-docs_search_cloudflare_documentation",
				]),
				userMessage("done"),
			],
			tools: [
				makeTool("tool_search"),
				makeTool("memory"),
				makeTool("lsp_symbols"),
				makeTool("x_search"),
				makeTool("cloudflare-docs_search_cloudflare_documentation"),
			],
		};

		const params = await captureParams(context, undefined, "claude-sonnet-4-6");

		expect(nativeSearchReferenceNames(params)).toEqual([
			"memory",
			"lsp_symbols",
			"x_search",
			"cloudflare-docs_search_cloudflare_documentation",
		]);
		expect(allBlocks(params).some((block) => block.type === "server_tool_use")).toBe(true);
	});

	it("drops a recased reference when two request tools fold onto the same name", async () => {
		const context: Context = {
			messages: [
				userMessage("find a tool"),
				nativeSearchTurn(["mcp__a4e6__XSearch", "mcp__a4e6__Memory"]),
				userMessage("done"),
			],
			tools: [makeTool("tool_search"), makeTool("x_search"), makeTool("x-search"), makeTool("memory")],
		};

		const params = await captureParams(context, undefined, "claude-sonnet-4-6");

		expect(nativeSearchReferenceNames(params)).toEqual(["memory"]);
	});
});
