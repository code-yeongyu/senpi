import type {
	AnthropicMessagesCompat,
	Api,
	BedrockCompat,
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
	 * In a present map, omitting `xhigh` or `max` disables that extended tier; ordinary missing levels
	 * use provider defaults. null marks any level as unsupported.
	 */
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image" | "video")[];
	cost: ModelCost;
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	/** Default prompt-cache retention preference when the request omits one. */
	cacheRetention?: CacheRetention;
	/**
	 * Upstream model id sent on the wire when it differs from the catalog id
	 * (for example `-fast` priority-tier variants aliasing their base model).
	 */
	upstreamModelId?: string;
	/** Service tier requested by default for this model (for example `-fast` variants). */
	serviceTier?: "auto" | "flex" | "priority";
	/** Whether to recover supported text-encoded tool calls from assistant text. */
	recoverTextToolCalls?: boolean;
	/** Compatibility overrides for OpenAI-compatible APIs. If not set, auto-detected from baseUrl. */
	compat?: TApi extends "openai-completions"
		? OpenAICompletionsCompat
		: TApi extends "openai-responses" | "openai-codex-responses" | "azure-openai-responses"
			? OpenAIResponsesCompat
			: TApi extends "anthropic-messages"
				? AnthropicMessagesCompat
				: TApi extends "bedrock-converse-stream"
					? BedrockCompat
					: never;
}
