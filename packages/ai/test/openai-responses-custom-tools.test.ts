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

	it("recovers persisted custom calls without active tools as raw custom Responses items", () => {
		// processResponsesStream stores custom_tool_call blocks with the
		// "<call_id>|custom" id sentinel. Compaction sends no tool definitions,
		// so this must recover the original freeform wire shape from persistence.
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
			tools: [],
		};

		const replayModel = { ...model, id: "gpt-5-replay" } as Model<"openai-responses">;
		const items = convertResponsesMessages(replayModel, context, new Set(["openai"]));
		expect(items).toEqual([
			{
				type: "custom_tool_call",
				call_id: "call_1",
				name: "apply_patch",
				input: "*** Begin Patch\n*** End Patch",
			},
			{ type: "custom_tool_call_output", call_id: "call_1", name: "apply_patch", output: "ok" },
		]);
		// Never let the persisted sentinel reach the provider as an item id.
		expect(items[0]).not.toHaveProperty("id");
	});

	it("gives an active grammar declaration precedence over sentinel freeform recovery", () => {
		const items = convertResponsesMessages(
			model,
			{
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "call_grammar|custom",
								name: "apply_patch",
								arguments: { input: "persisted freeform input", patch: "active grammar input" },
							},
						],
						api: "openai-responses",
						provider: "openai",
						model: "gpt-5",
						usage: zeroUsage(),
						stopReason: "toolUse",
						timestamp: 1,
					},
				],
				tools: [],
			},
			new Set(["openai"]),
			{ grammarToolInputProperties: new Map([["apply_patch", "patch"]]) },
		);

		expect(items[0]).toEqual({
			type: "custom_tool_call",
			call_id: "call_grammar",
			name: "apply_patch",
			input: "active grammar input",
		});
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
