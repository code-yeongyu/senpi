import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { createProvider, type Provider } from "../models.ts";
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "./cloudflare-ai-gateway.models.ts";
import { cloudflareAIGatewayAuth } from "./cloudflare-auth.ts";
import { cloudflareStreams } from "./cloudflare-stream.ts";
import { CLOUDFLARE_WORKERS_AI_MODELS } from "./cloudflare-workers-ai.models.ts";

type CloudflareAIGatewayApi = "anthropic-messages" | "openai-completions" | "openai-responses";

export function cloudflareAIGatewayProvider(): Provider<CloudflareAIGatewayApi> {
	return createProvider<CloudflareAIGatewayApi>({
		id: "cloudflare-ai-gateway",
		name: "Cloudflare AI Gateway",
		auth: { apiKey: cloudflareAIGatewayAuth() },
		models: [
			...Object.values(CLOUDFLARE_AI_GATEWAY_MODELS),
			...Object.values(CLOUDFLARE_WORKERS_AI_MODELS).map((model) => ({
				...model,
				provider: "cloudflare-ai-gateway" as const,
				id: `workers-ai/${model.id}`,
				baseUrl: "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/compat",
			})),
		],
		api: {
			"anthropic-messages": cloudflareStreams(anthropicMessagesApi()),
			"openai-completions": cloudflareStreams(openAICompletionsApi()),
			"openai-responses": cloudflareStreams(openAIResponsesApi()),
		},
	});
}
