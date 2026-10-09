import type {
	AnthropicMessagesCompat,
	Api,
	BaseModel,
	BedrockCompat,
	CacheRetention,
	MistralConversationsCompat,
	ModelPromptCache,
	ModelThinkingLevel,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
	ThinkingLevelMap,
} from "./types.ts";

/** Chat model: usable with `stream()` and friends. */
export interface Model<TApi extends Api> extends BaseModel<TApi> {
	/**
	 * Optional: chat is the default model type, so models without `type` are chat
	 * models. Narrow mixed model lists with `isModelType()` instead of comparing
	 * `type` directly.
	 */
	type?: "chat";
	reasoning: boolean;
	/**
	 * Maps pi thinking levels to provider/model-specific values.
	 * In a present map, omitting `xhigh` or `max` disables that extended tier; ordinary missing levels
	 * use provider defaults. null marks any level as unsupported.
	 */
	thinkingLevelMap?: ThinkingLevelMap;
	/**
	 * Level to start at when the user has not chosen one for this model, for example the default an
	 * OpenAI-compatible endpoint advertises. Clamped to the supported levels like any other request.
	 */
	defaultThinkingLevel?: ModelThinkingLevel;
	/** Prompt cache lifetimes per retention tier. Unset when the provider's cache behavior is unknown. */
	promptCache?: ModelPromptCache;
	contextWindow: number;
	maxTokens: number;
	/** Default sampling parameters; per-request values override these by key. */
	samplingParams?: Record<string, unknown>;
	/** Default prompt-cache retention preference when the request omits one. */
	cacheRetention?: CacheRetention;
	/**
	 * Upstream model id sent on the wire when it differs from the catalog id
	 * (for example `-fast` priority-tier variants aliasing their base model).
	 */
	upstreamModelId?: string;
	/** Service tier requested by default for this model (for example `-fast` variants). */
	serviceTier?: "auto" | "flex" | "priority" | "ultrafast";
	/** Whether to recover supported text-encoded tool calls from assistant text. */
	recoverTextToolCalls?: boolean;
	/**
	 * Whether a request may end with an assistant message the model continues
	 * writing (assistant prefill). Absent means no: Claude 4.6 and later reject a
	 * trailing assistant message, OpenAI's Responses API has no prefill, and the
	 * other default providers document none. Set it per model only after a live
	 * probe; `modelSupportsAssistantPrefill` also applies the request settings.
	 */
	supportsAssistantPrefill?: boolean;
	/** Compatibility overrides for OpenAI-compatible APIs. If not set, auto-detected from baseUrl. */
	compat?: TApi extends "openai-completions"
		? OpenAICompletionsCompat
		: TApi extends "openai-responses" | "openai-codex-responses" | "azure-openai-responses"
			? OpenAIResponsesCompat
			: TApi extends "anthropic-messages"
				? AnthropicMessagesCompat
				: TApi extends "bedrock-converse-stream"
					? BedrockCompat
					: TApi extends "mistral-conversations"
						? MistralConversationsCompat
						: TApi extends "cursor-agent"
							? CursorAgentCompat
							: TApi extends "devin-agent"
								? DevinAgentCompat
								: never;
}

/** Devin (Cascade) model metadata the transport branches on. */
export interface DevinAgentCompat {
	/**
	 * Server-side router (`adaptive`): its uid is never a legal chat model uid, so
	 * the transport resolves it through `AssignModel` before every turn.
	 */
	modelRouter?: boolean;
	/** The lane accepts several tool calls per turn; absent means one at a time. */
	supportsParallelToolCalls?: boolean;
}

/** Cursor agent protocol model metadata. */
export interface CursorAgentCompat {
	/** Request Cursor's max-mode (1M-context) variant of the model. */
	cursorMaxMode?: boolean;
	/**
	 * Wire-reasoning capability for grouped Cursor catalog identities.
	 * Presence is the capability gate: models without it never emit reasoning
	 * parameters on the wire.
	 */
	cursorReasoning?: {
		/** Base id into the static cursor capability table. */
		capabilityId: string;
		/** Fixed Claude thinking boolean for this selectable identity. */
		thinkingMode?: boolean;
		/** Exact catalog variant sent when no explicit selection exists. */
		representativeVariantId: string;
		/**
		 * Derived-group variant ids: normalized thinking level -> the exact
		 * server-listed variant id observed in the live catalog. Present only on
		 * identities derived at runtime from ids the static alias table does not
		 * list; explicit selections resolve through it before any capability
		 * lookup (senpi#2038).
		 */
		variantIds?: Readonly<Partial<Record<ModelThinkingLevel, string>>>;
	};
}

/**
 * Whether a request to `model` with these settings may end with an assistant
 * message the model continues writing. Extended thinking rules prefill out on
 * the Anthropic Messages API even for models that otherwise accept it.
 */
export function modelSupportsAssistantPrefill(
	model: Pick<Model<Api>, "api" | "supportsAssistantPrefill">,
	settings: { readonly thinkingEnabled: boolean },
): boolean {
	if (model.supportsAssistantPrefill !== true) return false;
	return !(model.api === "anthropic-messages" && settings.thinkingEnabled);
}
