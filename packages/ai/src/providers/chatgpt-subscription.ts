import {
	CHATGPT_SUBSCRIPTION_REJECTED_TOKEN_MESSAGE,
	CHATGPT_SUBSCRIPTION_REJECTED_TOKEN_STATUSES,
} from "../api/chatgpt-subscription-rejected-token.ts";
import { openAICodexResponsesApi } from "../api/openai-codex-responses.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadChatGptSubscriptionOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { CHATGPT_SUBSCRIPTION_MODELS } from "./chatgpt-subscription.models.ts";

export function chatgptSubscriptionProvider(): Provider<"openai-codex-responses"> {
	return createProvider({
		id: "chatgpt-subscription",
		name: "ChatGPT Subscription",
		baseUrl: "https://chatgpt.com/backend-api",
		auth: {
			oauth: lazyOAuth({
				name: "ChatGPT Subscription (Plus/Pro)",
				isSubscription: true,
				rejectedTokenStatuses: CHATGPT_SUBSCRIPTION_REJECTED_TOKEN_STATUSES,
				rejectedTokenMessage: CHATGPT_SUBSCRIPTION_REJECTED_TOKEN_MESSAGE,
				load: loadChatGptSubscriptionOAuth,
			}),
		},
		models: Object.values(CHATGPT_SUBSCRIPTION_MODELS),
		api: openAICodexResponsesApi(),
	});
}
