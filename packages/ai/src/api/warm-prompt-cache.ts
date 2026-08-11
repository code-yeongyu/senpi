import type { Context, Model, ProviderHeaders, StreamOptions } from "../types.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { isAnthropicApiBaseUrl } from "../utils/prompt-cache-ttl.ts";
import type { AnthropicOptions } from "./anthropic-messages.ts";

export interface WarmPromptCacheUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

export type WarmPromptCacheResult =
	| { readonly supported: false }
	| { readonly supported: true; readonly usage: WarmPromptCacheUsage; readonly usageRaw: unknown };

export type WarmPromptCacheOptions = Pick<
	StreamOptions,
	"apiKey" | "cacheRetention" | "env" | "fetch" | "headers" | "onPayload" | "sessionId" | "signal" | "timeoutMs"
>;

export async function warmPromptCache(
	model: Model<any>,
	context: Context,
	options: WarmPromptCacheOptions = {},
): Promise<WarmPromptCacheResult> {
	if (model.api !== "anthropic-messages" || !isAnthropicApiBaseUrl(model.baseUrl)) {
		return { supported: false };
	}

	const anthropicModel = model as Model<"anthropic-messages">;
	// Loaded lazily: a static import would pull the Anthropic SDK into the root
	// barrel and break the lazy provider-loading contract (lazy-module-load.test.ts).
	const [{ default: Anthropic }, { buildAnthropicWarmPromptCacheParams }] = await Promise.all([
		import("@anthropic-ai/sdk"),
		import("./anthropic-messages.ts"),
	]);
	const headers = providerHeadersToRecord(options.headers);
	const client = new Anthropic({
		apiKey: options.apiKey ?? null,
		baseURL: anthropicModel.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch: options.fetch,
		defaultHeaders: { ...anthropicModel.headers, ...headers },
	});
	let params = buildAnthropicWarmPromptCacheParams(anthropicModel, context, options as AnthropicOptions);
	const transformed = await options.onPayload?.(params, anthropicModel, {
		model: anthropicModel,
		headers: headers as ProviderHeaders,
	});
	if (transformed !== undefined) params = transformed as typeof params;
	const sanitized = { ...params } as Record<string, unknown>;
	delete sanitized.stream;
	delete sanitized.thinking;
	delete sanitized.output_config;
	delete sanitized.tool_choice;
	sanitized.max_tokens = 0;

	const response = await client.messages.create(sanitized as unknown as typeof params, {
		maxRetries: 0,
		...(options.signal ? { signal: options.signal } : {}),
		...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
	});
	const usageRaw = response.usage;
	return {
		supported: true,
		usage: {
			input: usageRaw.input_tokens,
			output: usageRaw.output_tokens,
			cacheRead: usageRaw.cache_read_input_tokens ?? 0,
			cacheWrite: usageRaw.cache_creation_input_tokens ?? 0,
		},
		usageRaw,
	};
}
