import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.ts";
import { buildAnthropicMessagesSearchRequest, normalizeAnthropicMessagesSearchPayload } from "./anthropic.ts";
import type { BuildContext, ProviderModule } from "./shared.ts";

// DeepSeek's official API serves Anthropic-compatible Messages with the
// server-side web_search_20250305 tool at /anthropic/v1/messages.
export const deepseekProvider: ProviderModule = {
	buildRequest(ctx: BuildContext): BuiltSearchRequest {
		return buildAnthropicMessagesSearchRequest(ctx, "deepseek-v4-flash");
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		return normalizeAnthropicMessagesSearchPayload(data);
	},
};
