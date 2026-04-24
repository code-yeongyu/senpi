import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { convertResponsesMessages, convertResponsesTools } from "../src/providers/openai-responses-shared.js";
import type { Context, Model, Tool } from "../src/types.js";

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
});
