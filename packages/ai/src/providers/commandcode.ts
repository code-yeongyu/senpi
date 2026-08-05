import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { COMMANDCODE_MODELS } from "./commandcode.models.ts";

export function commandcodeProvider(): Provider<"anthropic-messages" | "openai-completions"> {
	return createProvider({
		id: "commandcode",
		name: "CommandCode",
		baseUrl: "https://api.commandcode.ai/provider/v1",
		auth: { apiKey: envApiKeyAuth("CommandCode API key", ["COMMANDCODE_API_KEY"]) },
		models: Object.values(COMMANDCODE_MODELS),
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
		},
	});
}
