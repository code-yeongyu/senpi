import { Type } from "typebox";
import type { Api, Context, Model, OpenAICompletionsCompat, Tool, Usage } from "../src/types.ts";

export const PATCH = `*** Begin Patch
*** Update File: src/a.ts
@@
-old
+new
*** End Patch`;

export const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const APPLY_PATCH_TOOL: Tool = {
	name: "apply_patch",
	description: "Apply a patch",
	parameters: Type.Object({ input: Type.String() }),
	freeform: {
		type: "grammar",
		syntax: "lark",
		definition: 'start: "patch"',
	},
};

export function makePatchHistory(sourceApi: Api): Context["messages"] {
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call_patch", name: "apply_patch", arguments: { input: PATCH } }],
			api: sourceApi,
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
}

export const HISTORY: Context["messages"] = makePatchHistory("openai-responses");

export const COMPLETIONS_COMPAT = {
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

export function makeModel<TApi extends Api>(api: TApi, provider: Model<TApi>["provider"], id: string): Model<TApi> {
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
