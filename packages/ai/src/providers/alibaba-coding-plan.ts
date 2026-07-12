import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { ALIBABA_CODING_PLAN_MODELS } from "./alibaba-coding-plan.models.ts";

export function alibabaCodingPlanProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "alibaba-coding-plan",
		name: "Alibaba Coding Plan",
		baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
		auth: { apiKey: envApiKeyAuth("Alibaba Coding Plan API key", ["ALIBABA_CODING_PLAN_API_KEY"]) },
		models: Object.values(ALIBABA_CODING_PLAN_MODELS),
		api: openAICompletionsApi(),
	});
}
