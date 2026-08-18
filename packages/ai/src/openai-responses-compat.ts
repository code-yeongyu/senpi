export type SessionAffinityFormat = "openai" | "openai-nosession" | "openrouter";

export interface OpenAIResponsesCompat {
	/** Whether the provider supports the `developer` role (vs `system`). Default: true. */
	supportsDeveloperRole?: boolean;
	/** Session-affinity header format. Default: auto-detected. */
	sessionAffinityFormat?: SessionAffinityFormat;
	/** Whether the provider supports `prompt_cache_retention: "24h"`. Default: true. */
	supportsLongCacheRetention?: boolean;
	/** Whether the provider supports the OpenAI Responses WebSocket transport. */
	supportsWebSocket?: boolean;
	/** Whether the provider supports Responses remote compaction v2. */
	supportsRemoteCompactionV2?: boolean;
	/** Whether the provider supports the native `web_search_preview` tool. */
	supportsWebSearchPreview?: boolean;
	/** Whether the provider supports the native `image_generation` tool. */
	supportsImageGeneration?: boolean;
	/** Whether the provider supports strict JSON-schema function tools. */
	supportsStrictMode?: boolean;
	/** Whether to emit OpenAI custom tools with Lark/regex grammar formats. */
	supportsOpenAIGrammarTools?: boolean;
	/** Whether the model supports client-executed tool search for deferred tools. */
	supportsToolSearch?: boolean;
	/** Whether the model accepts `prompt_cache_options`. */
	supportsExplicitPromptCacheMode?: boolean;
}
