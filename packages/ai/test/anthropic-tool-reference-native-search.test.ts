import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import { describe, expect, it } from "vitest";
import { demoteUnavailableToolReferences } from "../src/api/anthropic-tool-references.ts";
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

	// senpi#2912: the pass drops a message only when it emptied the message itself.
	it("drops a search call left alone in its message when its split result stopped resolving, and keeps an empty effort marker", () => {
		const useId = "srvtoolu_split";
		const marker = { role: "system", content: [], output_config: { effort: "medium" } };
		const params = {
			model: "claude-sonnet-5-5",
			max_tokens: 1024,
			stream: true,
			tools: [{ name: "memory", input_schema: { type: "object" } }],
			messages: [
				{ role: "user", content: "find a tool" },
				{
					role: "assistant",
					content: [{ type: "server_tool_use", id: useId, name: "tool_search_tool_bm25", input: { query: "x" } }],
				},
				{
					role: "assistant",
					content: [
						{
							type: "tool_search_tool_result",
							tool_use_id: useId,
							content: {
								type: "tool_search_tool_search_result",
								tool_references: [{ type: "tool_reference", tool_name: "mcp__925c__gone" }],
							},
						},
					],
				},
				{ role: "user", content: "done" },
				marker,
			],
		} as unknown as MessageCreateParamsStreaming;

		const messages = demoteUnavailableToolReferences(params).messages as unknown as Array<{
			role: string;
			content: unknown;
		}>;

		expect(JSON.stringify(messages)).not.toContain("server_tool_use");
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "system"]);
		expect(messages.at(-1)).toEqual(marker);
	});

	it("drops the search call but keeps the text of an earlier [text, server_tool_use] message whose split result stopped resolving", async () => {
		const useId = "srvtoolu_split_text";
		const assistantBase = { ...nativeSearchTurn([], useId) };
		const callMessage = {
			...assistantBase,
			content: [{ type: "text" as const, text: "Let me look for a tool." }, assistantBase.content[0]!],
			stopReason: "toolUse" as const,
		};
		const resultMessage = {
			...assistantBase,
			content: [
				{
					type: "providerNative" as const,
					subtype: "tool_search_tool_result",
					raw: {
						type: "tool_search_tool_result",
						tool_use_id: useId,
						content: {
							type: "tool_search_tool_search_result",
							tool_references: [{ type: "tool_reference", tool_name: "mcp__925c__gone" }],
						},
					},
				},
				{ type: "text" as const, text: "Nothing usable." },
			],
		};
		const context: Context = {
			messages: [userMessage("find a tool"), callMessage, resultMessage, userMessage("done")],
			tools: [makeTool("tool_search"), makeTool("memory")],
		};

		const params = await captureParams(context, undefined, "claude-sonnet-4-6");
		const messages = messagesOf(params);

		// No unpaired call survives, and the call's message keeps its text.
		expect(allBlocks(params).some((block) => block.type === "server_tool_use")).toBe(false);
		expect(nativeSearchResultBlocks(params)).toHaveLength(0);
		expect(JSON.stringify(params)).toContain("Let me look for a tool.");
		expect(JSON.stringify(params)).toContain("Tool reference unavailable: mcp__925c__gone");
		// A valid Messages request: every message has content, it alternates into a user turn last, and the
		// two assistant messages that may now sit side by side carry only text (Anthropic combines them).
		expect(messages.every((message) => (Array.isArray(message.content) ? message.content.length > 0 : true))).toBe(
			true,
		);
		expect(messages.at(-1)?.role).toBe("user");
		for (const message of messages.filter((entry) => entry.role === "assistant")) {
			expect(blocksOf(message).every((block) => block.type === "text")).toBe(true);
		}
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

	it("strips a gateway namespace whose prefix is capitalized", async () => {
		const context: Context = {
			messages: [
				userMessage("find a tool"),
				nativeSearchTurn(["Mcp__a4e6__Memory", "MCP__a4e6__lsp_symbols"]),
				userMessage("done"),
			],
			tools: [makeTool("tool_search"), makeTool("memory"), makeTool("lsp_symbols")],
		};

		const params = await captureParams(context, undefined, "claude-sonnet-4-6");

		expect(nativeSearchReferenceNames(params)).toEqual(["memory", "lsp_symbols"]);
	});

	it("resolves a reference under a namespace id with underscores or onto a namespaced request tool", async () => {
		const context: Context = {
			messages: [
				userMessage("find a tool"),
				nativeSearchTurn(["mcp__my_server__Memory", "mcp__a4e6__create_issue"]),
				userMessage("done"),
			],
			tools: [makeTool("tool_search"), makeTool("memory"), makeTool("mcp_github_create_issue")],
		};

		const params = await captureParams(context, undefined, "claude-sonnet-4-6");

		expect(nativeSearchReferenceNames(params)).toEqual(["memory", "mcp_github_create_issue"]);
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
