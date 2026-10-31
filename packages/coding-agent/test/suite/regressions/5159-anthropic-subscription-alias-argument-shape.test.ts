import type { Api, Context, Model, Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	type Options,
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SdkQueryInput,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import { TOOL_EXECUTION_DENIED_MESSAGE } from "../../../src/core/extensions/builtin/anthropic-subscription/tools.ts";

const model: Model<Api> = {
	id: "claude-test",
	name: "Claude",
	api: "claude-sdk-oauth",
	provider: "anthropic-subscription",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

function tool(name: string, parameters: Tool["parameters"] = Type.Object({})): Tool {
	return { name, description: `${name} tool`, parameters };
}

const brokerBash = tool("bash", Type.Object({ program: Type.String(), args: Type.Array(Type.String()) }));
const context: Context = { messages: [], tools: [tool("read"), tool("edit"), brokerBash, tool("find")] };

function sdk(value: unknown): SDKMessage {
	return value as SDKMessage;
}

type ToolUse = { id: string; name: string; input: Record<string, unknown> };

/** One SDK turn: the model emits every tool_use in one response, the deny hook answers each, the turn ends. */
function turn(uses: ToolUse[]): SDKMessage[] {
	const blocks = uses.flatMap((use, index) => [
		sdk({
			type: "stream_event",
			event: {
				type: "content_block_start",
				index,
				content_block: { type: "tool_use", id: use.id, name: use.name, input: {} },
			},
		}),
		sdk({
			type: "stream_event",
			event: {
				type: "content_block_delta",
				index,
				delta: { type: "input_json_delta", partial_json: JSON.stringify(use.input) },
			},
		}),
		sdk({ type: "stream_event", event: { type: "content_block_stop", index } }),
	]);
	return [
		sdk({
			type: "stream_event",
			event: { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } },
		}),
		...blocks,
		sdk({
			type: "stream_event",
			event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
		}),
		sdk({
			type: "user",
			parent_tool_use_id: null,
			message: {
				role: "user",
				content: uses.map((use) => ({
					type: "tool_result",
					tool_use_id: use.id,
					is_error: true,
					content: TOOL_EXECUTION_DENIED_MESSAGE,
				})),
			},
		}),
		sdk({ type: "result", subtype: "success", is_error: false, stop_reason: "tool_use", result: "" }),
	];
}

function captureQuery(messages: SDKMessage[]): () => Options {
	let captured: Options | undefined;
	overrideSdkBoundary({
		query: (input: SdkQueryInput) => {
			captured = input.options;
			return {
				async *[Symbol.asyncIterator]() {
					yield* messages;
				},
				async interrupt() {},
				close() {},
			};
		},
	});
	return () => {
		if (!captured) throw new Error("query was never called");
		return captured;
	};
}

async function run(uses: ToolUse[]) {
	const options = captureQuery(turn(uses));
	const message = await streamAnthropicSubscription(model, context, { cwd: process.cwd() }).result();
	return { options: options(), calls: message.content.filter((block) => block.type === "toolCall"), message };
}

afterEach(() => resetSdkBoundary());

describe("regression senpi#5159: built-in names reach senpi through the alias, never through a built-in tool", () => {
	it("spawns Claude Code with no built-in tool and an alias for every built-in name an active tool covers", async () => {
		const { options } = await run([{ id: "toolu_r", name: "mcp__custom-tools__read", input: { path: "a.txt" } }]);
		expect(options.tools).toEqual([]);
		expect(options.toolAliases).toEqual({
			Read: "mcp__custom-tools__read",
			read: "mcp__custom-tools__read",
			Edit: "mcp__custom-tools__edit",
			edit: "mcp__custom-tools__edit",
			MultiEdit: "mcp__custom-tools__edit",
			multiedit: "mcp__custom-tools__edit",
			Bash: "mcp__custom-tools__bash",
			bash: "mcp__custom-tools__bash",
			Glob: "mcp__custom-tools__find",
			glob: "mcp__custom-tools__find",
		});
		expect(Object.keys(options.mcpServers ?? {})).toEqual(["custom-tools"]);
	});

	it("translates the built-in Edit / MultiEdit shapes into senpi's edit contract (#2401 class)", async () => {
		const { calls } = await run([
			{
				id: "toolu_e1",
				name: "Edit",
				input: { file_path: "/outside/notes.md", old_string: "beta", new_string: "beta-edited", replace_all: true },
			},
			{
				id: "toolu_e2",
				name: "MultiEdit",
				input: {
					file_path: "notes.md",
					edits: [
						{ old_string: "a", new_string: "b" },
						{ old_string: "c", new_string: "d", replace_all: false },
					],
				},
			},
		]);
		expect(calls).toEqual([
			{
				type: "toolCall",
				id: "toolu_e1",
				name: "edit",
				arguments: { path: "/outside/notes.md", edits: [{ oldText: "beta", newText: "beta-edited" }] },
			},
			{
				type: "toolCall",
				id: "toolu_e2",
				name: "edit",
				arguments: {
					path: "notes.md",
					edits: [
						{ oldText: "a", newText: "b" },
						{ oldText: "c", newText: "d" },
					],
				},
			},
		]);
	});

	it("passes MCP-named arguments through verbatim so a custom bash schema survives (#4059)", async () => {
		const { calls, message } = await run([
			{ id: "toolu_b", name: "mcp__custom-tools__bash", input: { program: "gh", args: ["--version"] } },
			{ id: "toolu_f", name: "mcp__custom-tools__find", input: { pattern: "**/*.ts", path: "src", limit: 3 } },
		]);
		expect(calls).toEqual([
			{ type: "toolCall", id: "toolu_b", name: "bash", arguments: { program: "gh", args: ["--version"] } },
			{ type: "toolCall", id: "toolu_f", name: "find", arguments: { pattern: "**/*.ts", path: "src", limit: 3 } },
		]);
		expect(message.stopReason).toBe("toolUse");
	});

	it("translates the built-in Bash / Glob / Read shapes when the model emitted the built-in name", async () => {
		const { calls } = await run([
			{ id: "toolu_b", name: "Bash", input: { command: "ls", timeout: 30_000, description: "list" } },
			{ id: "toolu_g", name: "Glob", input: { pattern: "**/*.ts", path: "src" } },
			{ id: "toolu_r", name: "Read", input: { file_path: "src/a.ts", offset: 2, limit: 3 } },
		]);
		expect(calls).toEqual([
			{ type: "toolCall", id: "toolu_b", name: "bash", arguments: { command: "ls", timeout: 30 } },
			{
				type: "toolCall",
				id: "toolu_g",
				name: "find",
				arguments: { pattern: "**/*.ts", path: "src", limit: undefined },
			},
			{ type: "toolCall", id: "toolu_r", name: "read", arguments: { path: "src/a.ts", offset: 2, limit: 3 } },
		]);
	});

	it("leaves an unknown tool name untouched for the host to refuse", async () => {
		const { calls } = await run([{ id: "toolu_w", name: "WebFetch", input: { url: "https://example.invalid" } }]);
		expect(calls).toEqual([
			{ type: "toolCall", id: "toolu_w", name: "WebFetch", arguments: { url: "https://example.invalid" } },
		]);
	});
});
