import { describe, expect, it } from "vitest";
import { streamSimple as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { convertMessages as convertGoogleMessages } from "../src/api/google-shared.ts";
import { convertMessages as convertCompletionMessages } from "../src/api/openai-completions.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import type { Context } from "../src/types.ts";
import {
	APPLY_PATCH_TOOL,
	COMPLETIONS_COMPAT,
	HISTORY,
	makeModel,
	makePatchHistory,
	PATCH,
} from "./model-switch-replay-fixtures.ts";

async function captureAnthropicPayload(context: Context): Promise<unknown> {
	let payload: unknown;
	const stream = streamAnthropic(makeModel("anthropic-messages", "anthropic", "claude-target"), context, {
		apiKey: "fake-api-key",
		onPayload: (candidate) => {
			payload = candidate;
			throw new Error("payload captured before transport");
		},
	});
	await stream.result();
	if (payload === undefined) {
		throw new Error("Anthropic payload was not captured");
	}
	return payload;
}

describe("model-switch replay characterization", () => {
	// Mutation-proof note (plan todo 3a): these assertions bite on the
	// isFreeformToolName seam (openai-responses-shared.ts:118-120). Inverting that
	// check flips every item type asserted below; the mutated-FAIL log is saved at
	// local-ignore/qa-evidence/20260719-gpt-model-switch/task-3-replay/red-mutation-isFreeformToolName.log
	it("s5 serializes apply_patch from Responses history according to the current tool declaration", () => {
		// Given
		const model = makeModel("openai-responses", "openai", "gpt-target");
		const context: Context = { messages: HISTORY, tools: [APPLY_PATCH_TOOL] };

		// When
		const customReplay = convertResponsesMessages(model, context, new Set(["openai"]));
		const functionReplay = convertResponsesMessages(model, { messages: HISTORY }, new Set(["openai"]));

		// Then
		expect(customReplay).toMatchObject([
			{ type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: PATCH },
			{ type: "custom_tool_call_output", call_id: "call_patch", name: "apply_patch", output: "Done!" },
		]);
		expect(functionReplay).toMatchObject([
			{
				type: "function_call",
				call_id: "call_patch",
				name: "apply_patch",
				arguments: JSON.stringify({ input: PATCH }),
			},
			{ type: "function_call_output", call_id: "call_patch", output: "Done!" },
		]);
	});

	it("s5b upgrades a function-era apply_patch recording to custom_tool_call on a freeform-declaring target", () => {
		// Given: history recorded while the model was on openai-completions (JSON function era),
		// replayed to an openai-responses target whose request declares a freeform apply_patch.
		const model = makeModel("openai-responses", "openai", "gpt-target");
		const context: Context = { messages: makePatchHistory("openai-completions"), tools: [APPLY_PATCH_TOOL] };

		// When
		const replay = convertResponsesMessages(model, context, new Set(["openai"]));

		// Then: getFreeformToolInput (openai-responses-shared.ts:123) extracts the raw patch string.
		expect(replay).toMatchObject([
			{ type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: PATCH },
			{ type: "custom_tool_call_output", call_id: "call_patch", name: "apply_patch", output: "Done!" },
		]);
	});

	it("s5b stringifies recorded arguments that lack an input string when upgrading to custom_tool_call", () => {
		// Given: a freeform-declaring target and a stored call whose arguments have no `input` key.
		const model = makeModel("openai-responses", "openai", "gpt-target");
		const [assistant, toolResult] = makePatchHistory("openai-completions");
		if (assistant === undefined || assistant.role !== "assistant" || toolResult === undefined) {
			throw new Error("fixture shape changed");
		}
		const legacyArguments = { patch: PATCH };
		const context: Context = {
			messages: [
				{
					...assistant,
					content: [{ type: "toolCall", id: "call_patch", name: "apply_patch", arguments: legacyArguments }],
				},
				toolResult,
			],
			tools: [APPLY_PATCH_TOOL],
		};

		// When
		const replay = convertResponsesMessages(model, context, new Set(["openai"]));

		// Then
		expect(replay).toMatchObject([
			{
				type: "custom_tool_call",
				call_id: "call_patch",
				name: "apply_patch",
				input: JSON.stringify(legacyArguments),
			},
			{ type: "custom_tool_call_output", call_id: "call_patch", name: "apply_patch", output: "Done!" },
		]);
	});

	it("s5c replays mixed edit + apply_patch history with per-name item types in both truth-table branches", () => {
		// Given: one edit call/result pair plus one apply_patch call/result pair.
		const model = makeModel("openai-responses", "openai", "gpt-target");
		const [patchAssistant, patchResult] = makePatchHistory("openai-responses");
		if (patchAssistant === undefined || patchAssistant.role !== "assistant" || patchResult === undefined) {
			throw new Error("fixture shape changed");
		}
		const mixedMessages: Context["messages"] = [
			{
				...patchAssistant,
				content: [
					{
						type: "toolCall",
						id: "call_edit",
						name: "edit",
						arguments: { path: "src/a.ts", edits: [{ oldText: "old", newText: "new" }] },
					},
					{ type: "toolCall", id: "call_patch", name: "apply_patch", arguments: { input: PATCH } },
				],
			},
			{
				role: "toolResult",
				toolCallId: "call_edit",
				toolName: "edit",
				content: [{ type: "text", text: "Edited" }],
				isError: false,
				timestamp: 2,
			},
			patchResult,
		];

		// When
		const withFreeform = convertResponsesMessages(
			model,
			{ messages: mixedMessages, tools: [APPLY_PATCH_TOOL] },
			new Set(["openai"]),
		);
		const withoutFreeform = convertResponsesMessages(model, { messages: mixedMessages }, new Set(["openai"]));

		// Then: edit stays a function item in both branches; only apply_patch follows the declaration.
		expect(withFreeform).toMatchObject([
			{ type: "function_call", call_id: "call_edit", name: "edit" },
			{ type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: PATCH },
			{ type: "function_call_output", call_id: "call_edit", output: "Edited" },
			{ type: "custom_tool_call_output", call_id: "call_patch", name: "apply_patch", output: "Done!" },
		]);
		expect(withoutFreeform).toMatchObject([
			{ type: "function_call", call_id: "call_edit", name: "edit" },
			{
				type: "function_call",
				call_id: "call_patch",
				name: "apply_patch",
				arguments: JSON.stringify({ input: PATCH }),
			},
			{ type: "function_call_output", call_id: "call_edit", output: "Edited" },
			{ type: "function_call_output", call_id: "call_patch", output: "Done!" },
		]);
	});

	it("s6 preserves an undeclared apply_patch call while replaying to non-Responses providers", async () => {
		// Given
		const context: Context = { messages: HISTORY };

		// When
		const completionReplay = convertCompletionMessages(
			makeModel("openai-completions", "openai", "gpt-target"),
			context,
			COMPLETIONS_COMPAT,
		);
		const anthropicPayload = await captureAnthropicPayload(context);
		const googleReplay = convertGoogleMessages(makeModel("google-generative-ai", "google", "gemini-target"), context);

		// Then
		expect(completionReplay).toMatchObject([
			{
				role: "assistant",
				tool_calls: [
					{
						id: "call_patch",
						type: "function",
						function: { name: "apply_patch", arguments: JSON.stringify({ input: PATCH }) },
					},
				],
			},
			{ role: "tool", tool_call_id: "call_patch", content: "Done!" },
		]);
		expect(anthropicPayload).toMatchObject({
			messages: [
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "call_patch", name: "apply_patch", input: { input: PATCH } }],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "call_patch", content: "Done!" }],
				},
			],
		});
		expect(googleReplay).toMatchObject([
			{ role: "model", parts: [{ functionCall: { name: "apply_patch", args: { input: PATCH } } }] },
			{ role: "user", parts: [{ functionResponse: { name: "apply_patch", response: { output: "Done!" } } }] },
		]);
	});
});
