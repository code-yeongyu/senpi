import type { Model } from "./model.ts";
import type { Api } from "./types.ts";

export type SessionAffinityFormat = "openai" | "openai-nosession" | "openrouter";

export interface OpenAIResponsesCompat {
	/** Whether the provider supports the `developer` role (vs `system`). Default: true. */
	supportsDeveloperRole?: boolean;
	/** Session-affinity header format. Default: auto-detected. */
	sessionAffinityFormat?: SessionAffinityFormat;
	/** Whether the provider supports long prompt cache retention. This uses `prompt_cache_options.ttl: "30m"` on GPT-5.6+ and `prompt_cache_retention: "24h"` on earlier models. Default: true. */
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
	/**
	 * Whether the model accepts `configuration_update` input items, which change reasoning effort
	 * mid-session while keeping the cached prompt prefix. Unflagged models change the top-level
	 * `reasoning.effort` instead. Default: false.
	 */
	supportsConfigurationUpdate?: boolean;
	/** Whether the provider accepts the `max_output_tokens` parameter. Some Codex-protocol gateways reject it. Default: true. */
	supportsMaxOutputTokens?: boolean;
	/**
	 * Whether the provider accepts a `tool_choice` that forces a tool (`required` or a named function).
	 * When false the forced choice is dropped before sending. Default: true; a provider that refuses one
	 * at runtime is remembered for the process after one retry without it.
	 */
	supportsForcedToolChoice?: boolean;
	/**
	 * Whether the model accepts `tool_choice: { type: "allowed_tools" }`. When set, callers keep every
	 * declared tool in `tools` and restrict the callable subset through `Context.activeToolNames`, so a
	 * shrinking tool set does not rewrite the cached prompt prefix. Honored by the `openai-responses`
	 * adapter, and only on the native OpenAI API hosts (`api.openai.com` and its regional `*.api.openai.com`
	 * hosts): Responses-compatible gateways reject the choice (senpi#3080), and since a provider `baseUrl`
	 * override keeps the catalog compat, the flag cannot opt a gateway in. Default: false.
	 */
	supportsAllowedTools?: boolean;
}

function isNativeOpenAIEndpoint(baseUrl: string | undefined): boolean {
	try {
		const { hostname } = new URL(baseUrl || "https://api.openai.com/v1");
		return hostname === "api.openai.com" || hostname.endsWith(".api.openai.com");
	} catch {
		return false;
	}
}

/**
 * Whether requests to `model` restrict tools through `allowed_tools`: its compat declares support and it is
 * served by the native OpenAI endpoint (see {@link OpenAIResponsesCompat.supportsAllowedTools}).
 */
export function supportsAllowedToolChoice(model: Model<Api>): boolean {
	return (
		(model.compat as OpenAIResponsesCompat | undefined)?.supportsAllowedTools === true &&
		isNativeOpenAIEndpoint(model.baseUrl)
	);
}
