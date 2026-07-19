import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { streamSimple as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { convertMessages as convertGoogleMessages } from "../src/api/google-shared.ts";
import { convertMessages as convertCompletionMessages } from "../src/api/openai-completions.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import type { Api, Context, Model, OpenAICompletionsCompat, Tool, Usage } from "../src/types.ts";

const PATCH = `*** Begin Patch
*** Update File: src/a.ts
@@
-old
+new
*** End Patch`;

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const APPLY_PATCH_TOOL: Tool = {
	name: "apply_patch",
	description: "Apply a patch",
	parameters: Type.Object({ input: Type.String() }),
	freeform: {
		type: "grammar",
		syntax: "lark",
		definition: 'start: "patch"',
	},
};

const HISTORY: Context["messages"] = [
	{
		role: "assistant",
		content: [{ type: "toolCall", id: "call_patch", name: "apply_patch", arguments: { input: PATCH } }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-source",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: 1,
	},
	{
		role: "toolResult",
		toolCallId: "call_patch",
		toolName: "apply_patch",
		content: [{ type: "text", text: "Done!" }],
		isError: false,
		timestamp: 2,
	},
];

const COMPLETIONS_COMPAT = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	supportsDisabledThinking: true,
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	toolSchemaFlavor: undefined,
	toolCallFormat: undefined,
	cacheControlFormat: "anthropic",
	sendSessionAffinityHeaders: false,
	sessionAffinityFormat: "openai",
	supportsLongCacheRetention: true,
} satisfies Omit<
	Required<OpenAICompletionsCompat>,
	"cacheControlFormat" | "toolCallFormat" | "deferredToolsMode" | "toolSchemaFlavor"
> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
	toolCallFormat?: OpenAICompletionsCompat["toolCallFormat"];
	deferredToolsMode?: OpenAICompletionsCompat["deferredToolsMode"];
	toolSchemaFlavor?: OpenAICompletionsCompat["toolSchemaFlavor"];
};

function makeModel<TApi extends Api>(api: TApi, provider: Model<TApi>["provider"], id: string): Model<TApi> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

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
