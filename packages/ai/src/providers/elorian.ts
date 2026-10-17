import { Type } from "typebox";
import { Value } from "typebox/value";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { OAuthTokenEndpointError } from "../utils/oauth-refresh-error.ts";
import { ELORIAN_MODELS } from "./elorian.models.ts";
import { withElorianRuns } from "./elorian-runs.ts";
import { elorianCompletionsApi } from "./elorian-stream.ts";

const limitsSchema = Type.Object({
	media: Type.Object({ context_tokens: Type.Integer({ minimum: 1 }) }),
	output: Type.Object({ max_completion_tokens: Type.Integer({ minimum: 1 }) }),
});

export interface ElorianProviderOptions {
	readonly baseUrl?: string;
	readonly fetch?: typeof fetch;
}

/** OpenAI-compatible chat with Elorian's media, hosted tools and account limits. */
export function elorianProvider(options: ElorianProviderOptions = {}): Provider<"openai-completions"> {
	const baseUrl = (options.baseUrl ?? "https://api.elorian.ai/v1").replace(/\/+$/u, "");
	const baseline = Object.values(ELORIAN_MODELS).map((model) => ({ ...model, baseUrl }));
	return createProvider({
		id: "elorian",
		name: "Elorian",
		baseUrl,
		auth: { apiKey: envApiKeyAuth("Elorian API key", ["ELORIAN_API_KEY"]) },
		models: baseline,
		fetchModels: async (context) => {
			if (context.credential?.type !== "api_key") return [];
			const signal = AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]);
			const response = await (options.fetch ?? fetch)(`${baseUrl}/limits`, {
				headers: { authorization: `Bearer ${context.credential.key}`, accept: "application/json" },
				signal,
			});
			if (!response.ok) {
				throw new OAuthTokenEndpointError(
					`Could not load Elorian account limits: ${response.status}`,
					response.status,
				);
			}
			const limits = Value.Parse(limitsSchema, await response.json());
			return baseline.map((model) => ({
				...model,
				contextWindow: limits.media.context_tokens,
				maxTokens: limits.output.max_completion_tokens,
			}));
		},
		api: withElorianRuns(elorianCompletionsApi()),
	});
}
