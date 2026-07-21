import type {
	AnthropicMessagesCompat,
	Api,
	CacheRetention,
	ModelCost,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
	ProviderId,
	ThinkingLevelMap,
} from "./types.ts";

/** Model interface for the unified model system. */
export interface Model<TApi extends Api> {
	id: string;
	name: string;
	api: TApi;
	provider: ProviderId;
	baseUrl: string;
	reasoning: boolean;
	/**
	 * Maps pi thinking levels to provider/model-specific values.
	 * Missing keys use provider defaults. null marks a level as unsupported.
	 */
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image" | "video")[];
	cost: ModelCost;
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	/** Default prompt-cache retention preference when the request omits one. */
	cacheRetention?: CacheRetention;
	/** Whether to recover supported text-encoded tool calls from assistant text. */
	recoverTextToolCalls?: boolean;
	/** Compatibility overrides for OpenAI-compatible APIs. If not set, auto-detected from baseUrl. */
	compat?: TApi extends "openai-completions"
		? OpenAICompletionsCompat
		: TApi extends "openai-responses" | "openai-codex-responses"
			? OpenAIResponsesCompat
			: TApi extends "anthropic-messages"
				? AnthropicMessagesCompat
				: never;
}
