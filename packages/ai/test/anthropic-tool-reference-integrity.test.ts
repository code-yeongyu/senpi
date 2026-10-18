import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "../src/providers/faux.ts";
import type { Context } from "../src/types.ts";
import {
	captureParams,
	makeTool,
	messagesOf,
	textBlocks,
	toolNamesIn,
	toolResultBlocks,
	toolResultMessage,
	toolUseBlocks,
	userMessage,
} from "./anthropic-tool-reference-harness.ts";

/**
 * Anthropic rejects a request whose message history references a tool that is
 * neither defined in `tools` nor discovered through a `tool_reference` block:
 *
 *   400 invalid_request_error: Tool reference 'mcp_computer_use_drag' not
 *   found in available tools
 *
 * Sessions outlive their tools — an MCP server can be absent after a resume,
 * an extension can stop registering a tool, or a payload hook can strip a
 * definition while history still carries the call. The provider must demote
 * those references to plain text (in lockstep with their tool_results) so the
 * turn can proceed instead of failing the whole request.
 */

describe("Anthropic tool-reference integrity", () => {
	it("demotes history tool calls whose tool is no longer available", async () => {
		const context: Context = {
			messages: [
				userMessage("drag the window"),
				fauxAssistantMessage(fauxToolCall("mcp_computer_use_drag", { x: 10, y: 20 }, { id: "call_gone" }), {
					stopReason: "toolUse",
				}),
				toolResultMessage("call_gone", "mcp_computer_use_drag", "dragged to 10,20"),
				userMessage("thanks"),
			],
			tools: [],
		};

		const params = await captureParams(context);

		// No tool_use or tool_result may reference the missing tool.
		expect(toolUseBlocks(params).map((block) => block.name)).not.toContain("mcp_computer_use_drag");
		expect(toolResultBlocks(params).map((block) => block.tool_use_id)).not.toContain("call_gone");

		// The history intent survives as plain text instead of failing the request.
		const texts = textBlocks(params)
			.map((block) => block.text ?? "")
			.join("\n");
		expect(texts).toContain("mcp_computer_use_drag");
		expect(texts).toContain("dragged to 10,20");

		// No empty-content messages may be left behind.
		for (const message of messagesOf(params)) {
			if (Array.isArray(message.content)) expect(message.content.length).toBeGreaterThan(0);
		}
	});

	it("demotes only the missing tool in a mixed assistant turn", async () => {
		const context: Context = {
			messages: [
				userMessage("drag then read"),
				fauxAssistantMessage(
					[
						fauxToolCall("mcp_computer_use_drag", { x: 1, y: 2 }, { id: "call_gone" }),
						fauxToolCall("read", { input: "f" }, { id: "call_kept" }),
					],
					{ stopReason: "toolUse" },
				),
				toolResultMessage("call_gone", "mcp_computer_use_drag", "dragged"),
				toolResultMessage("call_kept", "read", "file contents"),
				userMessage("go on"),
			],
			tools: [makeTool("read")],
		};

		const params = await captureParams(context);

		expect(toolUseBlocks(params).map((block) => block.name)).toEqual(["read"]);
		expect(toolResultBlocks(params).map((block) => block.tool_use_id)).toEqual(["call_kept"]);
		expect(toolNamesIn(params)).toEqual(["read"]);
	});

	it("keeps tool calls for tools that are still available", async () => {
		const context: Context = {
			messages: [
				userMessage("drag the window"),
				fauxAssistantMessage(fauxToolCall("mcp_computer_use_drag", { x: 10, y: 20 }, { id: "call_kept" }), {
					stopReason: "toolUse",
				}),
				toolResultMessage("call_kept", "mcp_computer_use_drag", "dragged"),
				userMessage("thanks"),
			],
			tools: [makeTool("mcp_computer_use_drag")],
		};

		const params = await captureParams(context);

		expect(toolUseBlocks(params).map((block) => block.name)).toContain("mcp_computer_use_drag");
		expect(toolResultBlocks(params).map((block) => block.tool_use_id)).toContain("call_kept");
	});

	it("keeps deferred tools discovered through tool_reference blocks", async () => {
		const context: Context = {
			messages: [
				userMessage("find a tool"),
				fauxAssistantMessage(fauxToolCall("tool_search", { query: "drag" }, { id: "call_search" }), {
					stopReason: "toolUse",
				}),
				toolResultMessage("call_search", "tool_search", "1 tool(s) activated", ["mcp_computer_use_drag"]),
				userMessage("done"),
			],
			tools: [makeTool("tool_search"), makeTool("mcp_computer_use_drag")],
		};

		const params = await captureParams(context, undefined, "claude-sonnet-4-6");

		// The unused activated tool ships deferred, and its tool_reference must survive.
		const tools = (params.tools ?? []) as Array<{ name: string; defer_loading?: boolean }>;
		expect(tools.some((tool) => tool.name === "mcp_computer_use_drag" && tool.defer_loading === true)).toBe(true);
		const references = toolResultBlocks(params).flatMap((block) =>
			Array.isArray(block.content) ? (block.content as Array<{ type: string; tool_name?: string }>) : [],
		);
		expect(references.some((ref) => ref.type === "tool_reference" && ref.tool_name === "mcp_computer_use_drag")).toBe(
			true,
		);
	});

	it("strips tool_reference blocks whose definition was removed by a payload hook", async () => {
		const context: Context = {
			messages: [
				userMessage("find a tool"),
				fauxAssistantMessage(fauxToolCall("tool_search", { query: "drag" }, { id: "call_search" }), {
					stopReason: "toolUse",
				}),
				toolResultMessage("call_search", "tool_search", "1 tool(s) activated", ["mcp_computer_use_drag"]),
				userMessage("done"),
			],
			tools: [makeTool("tool_search"), makeTool("mcp_computer_use_drag")],
		};

		const params = await captureParams(
			context,
			(payload) => {
				const mutable = payload as { tools?: Array<{ name: string }> };
				mutable.tools = (mutable.tools ?? []).filter((tool) => tool.name !== "mcp_computer_use_drag");
				return payload;
			},
			"claude-sonnet-4-6",
		);

		expect(toolNamesIn(params)).not.toContain("mcp_computer_use_drag");
		const references = toolResultBlocks(params).flatMap((block) =>
			Array.isArray(block.content) ? (block.content as Array<{ type: string; tool_name?: string }>) : [],
		);
		expect(references.some((ref) => ref.type === "tool_reference" && ref.tool_name === "mcp_computer_use_drag")).toBe(
			false,
		);
		// The reference-carrying tool_result must not end up with empty content.
		for (const block of toolResultBlocks(params)) {
			if (Array.isArray(block.content)) expect(block.content.length).toBeGreaterThan(0);
		}
	});

	it("renames a gateway-namespaced history tool call to the request's tool name", async () => {
		const context: Context = {
			messages: [
				userMessage("remember this"),
				fauxAssistantMessage(fauxToolCall("mcp__925c__memory", { input: "note" }, { id: "call_memory" }), {
					stopReason: "toolUse",
				}),
				toolResultMessage("call_memory", "mcp__925c__memory", "stored"),
				userMessage("done"),
			],
			tools: [makeTool("memory")],
		};

		const params = await captureParams(context, undefined, "claude-sonnet-4-6");

		const calls = toolUseBlocks(params);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.name).toBe("memory");
		expect(toolResultBlocks(params).map((block) => block.tool_use_id)).toEqual(["call_memory"]);
		expect(textBlocks(params).some((block) => block.text?.includes("no longer available"))).toBe(false);
	});

	it("demotes a history tool call whose only discovery was a stripped tool_reference", async () => {
		const context: Context = {
			messages: [
				userMessage("find a tool"),
				fauxAssistantMessage(fauxToolCall("tool_search", { query: "drag" }, { id: "call_search" }), {
					stopReason: "toolUse",
				}),
				toolResultMessage("call_search", "tool_search", "1 tool(s) activated", ["mcp_computer_use_drag"]),
				fauxAssistantMessage(fauxToolCall("mcp_computer_use_drag", { x: 1 }, { id: "call_drag" }), {
					stopReason: "toolUse",
				}),
				toolResultMessage("call_drag", "mcp_computer_use_drag", "dragged"),
				userMessage("done"),
			],
			tools: [makeTool("tool_search"), makeTool("mcp_computer_use_drag")],
		};

		const params = await captureParams(
			context,
			(payload) => {
				const mutable = payload as { tools?: Array<{ name: string }> };
				mutable.tools = (mutable.tools ?? []).filter((tool) => tool.name !== "mcp_computer_use_drag");
				return payload;
			},
			"claude-sonnet-4-6",
		);

		expect(toolNamesIn(params)).not.toContain("mcp_computer_use_drag");
		expect(toolUseBlocks(params).map((block) => block.name)).toEqual(["tool_search"]);
		expect(JSON.stringify(params)).not.toContain('"tool_name":"mcp_computer_use_drag"');
		expect(textBlocks(params).some((block) => block.text?.includes("mcp_computer_use_drag"))).toBe(true);
	});

	it("renames a recased gateway-namespaced history tool call to the request's tool name", async () => {
		const context: Context = {
			messages: [
				userMessage("search x"),
				fauxAssistantMessage(fauxToolCall("mcp__a4e6__XSearch", { input: "omo" }, { id: "call_x" }), {
					stopReason: "toolUse",
				}),
				toolResultMessage("call_x", "mcp__a4e6__XSearch", "3 posts"),
				userMessage("done"),
			],
			tools: [makeTool("x_search")],
		};

		const params = await captureParams(context, undefined, "claude-sonnet-4-6");

		expect(toolUseBlocks(params).map((block) => block.name)).toEqual(["x_search"]);
		expect(toolResultBlocks(params).map((block) => block.tool_use_id)).toEqual(["call_x"]);
		expect(textBlocks(params).some((block) => block.text?.includes("no longer available"))).toBe(false);
	});
});
