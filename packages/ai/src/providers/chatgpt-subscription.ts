import { openAICodexResponsesApi } from "../api/openai-codex-responses.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadChatGptSubscriptionOAuth, loadOpenAIChatGPTOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Api, Model, OpenAIResponsesCompat } from "../types.ts";
import { extractChatGptSubscriptionIdentity } from "../utils/chatgpt-subscription-auth.ts";
import { CHATGPT_SUBSCRIPTION_MODELS } from "./chatgpt-subscription.models.ts";

export function chatgptSubscriptionProvider(): Provider<"openai-codex-responses" | "openai-responses"> {
	const legacy = lazyOAuth({
		name: "ChatGPT Subscription (Plus/Pro)",
		isSubscription: true,
		accountIdentity: (credential) => extractChatGptSubscriptionIdentity(credential.access),
		load: loadChatGptSubscriptionOAuth,
	});
	const siwc = lazyOAuth({
		name: "ChatGPT Subscription",
		isSubscription: true,
		load: loadOpenAIChatGPTOAuth,
	});
	const responses = openAIResponsesApi();
	const siwcModel = (model: Model<Api>): Model<"openai-responses"> => ({
		...model,
		api: "openai-responses",
		id: model.upstreamModelId ?? model.id,
		compat: { ...(model.compat as OpenAIResponsesCompat), siwc: true, webSearchToolType: "web_search" },
	});
	return createProvider<"openai-codex-responses" | "openai-responses">({
		id: "chatgpt-subscription",
		name: "ChatGPT Subscription",
		baseUrl: "https://chatgpt.com/backend-api",
		auth: {
			oauth: {
				...legacy,
				loginLabel: "Continue with ChatGPT",
				login: async (interaction, options) => {
					const route = await interaction.prompt({
						type: "select",
						message: "Sign in to ChatGPT Subscription:",
						options: [
							{ id: "siwc", label: "Continue with ChatGPT" },
							{ id: "legacy", label: "Legacy sign-in (existing users)" },
						],
					});
					if (route === "legacy") return legacy.login(interaction, options);
					if (route !== "siwc") throw new Error(`Unknown ChatGPT sign-in route: ${route}`);
					return { ...(await siwc.login(interaction, options)), route: "siwc" };
				},
				refresh: async (credential, signal) =>
					credential.route === "siwc"
						? { ...credential, ...(await siwc.refresh(credential, signal)), route: "siwc" }
						: legacy.refresh(credential, signal),
				toAuth: async (credential) =>
					credential.route === "siwc"
						? {
								...(await siwc.toAuth(credential)),
								api: "openai-responses",
								baseUrl: "https://api.openai.com/v1",
								compat: { siwc: true, webSearchToolType: "web_search" },
							}
						: legacy.toAuth(credential),
			},
		},
		models: Object.values(CHATGPT_SUBSCRIPTION_MODELS),
		api: {
			"openai-codex-responses": openAICodexResponsesApi(),
			"openai-responses": {
				stream: (model, context, options) => responses.stream(siwcModel(model), context, options),
				streamSimple: (model, context, options) => responses.streamSimple(siwcModel(model), context, options),
			},
		},
	});
}
