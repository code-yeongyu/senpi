import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { convertResponsesMessages, convertResponsesTools } from "../src/providers/openai-responses-shared.ts";
import type { Context, Model, Tool } from "../src/types.ts";

const applyPatchTool: Tool = {
	name: "apply_patch",
	description: "freeform",
	parameters: Type.Object({
		input: Type.String(),
	}),
	freeform: {
		type: "grammar",
		syntax: "lark",
		definition: 'start: "ok"',
	},
};

const model = {
	id: "gpt-5",
	provider: "openai",
	api: "openai-responses",
	input: ["text"],
	reasoning: true,
} as Model<"openai-responses">;

function zeroUsage() {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("openai responses custom tool support", () => {
	it("converts freeform tools into custom response tools", () => {
		expect(convertResponsesTools([applyPatchTool])).toEqual([
			{
				type: "custom",
				name: "apply_patch",
				description: "freeform",
				format: {
					type: "grammar",
					syntax: "lark",
					definition: 'start: "ok"',
				},
			},
		]);
	});

	it("serializes custom tool calls and outputs for freeform tools", () => {
		const context: Context = {
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call_1|item_1",
							name: "apply_patch",
							arguments: { input: "*** Begin Patch\n*** End Patch" },
						},
					],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call_1|item_1",
					toolName: "apply_patch",
					content: [{ type: "text", text: "ok" }],
					details: undefined,
					isError: false,
					timestamp: 2,
				},
			],
			tools: [applyPatchTool],
		};

		expect(convertResponsesMessages(model, context, new Set(["openai"]))).toMatchObject([
			{
				type: "custom_tool_call",
				call_id: "call_1",
				name: "apply_patch",
				input: "*** Begin Patch\n*** End Patch",
			},
			{
				type: "custom_tool_call_output",
				call_id: "call_1",
				name: "apply_patch",
				output: "ok",
			},
		]);
	});

	it("omits the sentinel item id when replaying a custom tool call without its freeform tool", () => {
		// processResponsesStream stores custom_tool_call blocks with the
		// "<call_id>|custom" id sentinel. Requests that replay history without
		// the freeform tool registered (compaction strips `freeform` from its
		// summarization tool list) fall into the function_call branch — and the
		// Responses API rejects any function_call item id not beginning with "fc".
		const context: Context = {
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call_1|custom",
							name: "apply_patch",
							arguments: { input: "*** Begin Patch\n*** End Patch" },
						},
					],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5",
					usage: zeroUsage(),
					stopReason: "toolUse",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call_1|custom",
					toolName: "apply_patch",
					content: [{ type: "text", text: "ok" }],
					details: undefined,
					isError: false,
					timestamp: 2,
				},
			],
			tools: [
				{
					name: "apply_patch",
					description: "freeform stripped, as compaction summarization tools are",
					parameters: Type.Object({ input: Type.String() }),
				},
			],
		};

		const items = convertResponsesMessages(model, context, new Set(["openai"]));
		expect(items).toEqual([
			{
				type: "function_call",
				call_id: "call_1",
				name: "apply_patch",
				arguments: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }),
			},
			{ type: "function_call_output", call_id: "call_1", output: "ok" },
		]);
		expect(items[0]).not.toHaveProperty("id");
	});

	it("keeps server-issued fc item ids on same-model function_call replay", () => {
		const context: Context = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_2|fc_item_2", name: "bash", arguments: { cmd: "npm test" } }],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5",
					usage: zeroUsage(),
					stopReason: "toolUse",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call_2|fc_item_2",
					toolName: "bash",
					content: [{ type: "text", text: "ok" }],
					details: undefined,
					isError: false,
					timestamp: 2,
				},
			],
			tools: [],
		};

		expect(convertResponsesMessages(model, context, new Set(["openai"]))).toEqual([
			{
				type: "function_call",
				id: "fc_item_2",
				call_id: "call_2",
				name: "bash",
				arguments: JSON.stringify({ cmd: "npm test" }),
			},
			{ type: "function_call_output", call_id: "call_2", output: "ok" },
		]);
	});
});
