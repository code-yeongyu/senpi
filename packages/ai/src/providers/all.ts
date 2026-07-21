import { createImagesModels, type ImagesProvider, type MutableImagesModels } from "../images-models.ts";
import { MODELS } from "../models.generated.ts";
import { type CreateModelsOptions, createModels, type MutableModels, type Provider } from "../models.ts";
import type { Api, Model } from "../types.ts";
import { alibabaCodingPlanProvider } from "./alibaba-coding-plan.ts";
import { amazonBedrockProvider } from "./amazon-bedrock.ts";
import { antLingProvider } from "./ant-ling.ts";
import { anthropicProvider } from "./anthropic.ts";
import { azureOpenAIResponsesProvider } from "./azure-openai-responses.ts";
import { cerebrasProvider } from "./cerebras.ts";
import { cloudflareAIGatewayProvider } from "./cloudflare-ai-gateway.ts";
import { cloudflareWorkersAIProvider } from "./cloudflare-workers-ai.ts";
import { cursorProvider } from "./cursor.ts";
import { deepinfraProvider } from "./deepinfra.ts";
import { deepseekProvider } from "./deepseek.ts";
import { firepassProvider } from "./firepass.ts";
import { fireworksProvider } from "./fireworks.ts";
import { fuguProvider } from "./fugu.ts";
import { githubCopilotProvider } from "./github-copilot.ts";
import { gitlabDuoProvider } from "./gitlab-duo.ts";
import { googleProvider } from "./google.ts";
import { googleAntigravityProvider, googleGeminiCliProvider } from "./google-gemini-cli.ts";
import { googleVertexProvider } from "./google-vertex.ts";
import { groqProvider } from "./groq.ts";
import { huggingfaceProvider } from "./huggingface.ts";
import { kiloProvider } from "./kilo.ts";
import { kimiCodingProvider } from "./kimi-coding.ts";
import { litellmProvider } from "./litellm.ts";
import { lmStudioProvider } from "./lm-studio.ts";
import { minimaxProvider } from "./minimax.ts";
import { minimaxCnProvider } from "./minimax-cn.ts";
import { minimaxCodeProvider } from "./minimax-code.ts";
import { minimaxCodeCnProvider } from "./minimax-code-cn.ts";
import { mistralProvider } from "./mistral.ts";
import { moonshotProvider } from "./moonshot.ts";
import { moonshotaiProvider } from "./moonshotai.ts";
import { moonshotaiCnProvider } from "./moonshotai-cn.ts";
import { nanogptProvider } from "./nanogpt.ts";
import { nvidiaProvider } from "./nvidia.ts";
import { ollamaProvider } from "./ollama.ts";
import { ollamaCloudProvider } from "./ollama-cloud.ts";
import { openaiProvider } from "./openai.ts";
import { openaiCodexProvider } from "./openai-codex.ts";
import { openaiCodexDeviceProvider } from "./openai-codex-device.ts";
import { opencodeProvider } from "./opencode.ts";
import { opencodeGoProvider } from "./opencode-go.ts";
import { opencodeZenProvider } from "./opencode-zen.ts";
import { openrouterProvider } from "./openrouter.ts";
import { openrouterImagesProvider } from "./openrouter-images.ts";
import { perplexityProvider } from "./perplexity.ts";
import { qianfanProvider } from "./qianfan.ts";
import { qwenPortalProvider } from "./qwen-portal.ts";
import { radiusProvider } from "./radius.ts";
import { syntheticProvider } from "./synthetic.ts";
import { togetherProvider } from "./together.ts";
import { veniceProvider } from "./venice.ts";
import { vercelAIGatewayProvider } from "./vercel-ai-gateway.ts";
import { vllmProvider } from "./vllm.ts";
import { xaiProvider } from "./xai.ts";
import { xiaomiProvider } from "./xiaomi.ts";
import { xiaomiTokenPlanAmsProvider } from "./xiaomi-token-plan-ams.ts";
import { xiaomiTokenPlanCnProvider } from "./xiaomi-token-plan-cn.ts";
import { xiaomiTokenPlanSgpProvider } from "./xiaomi-token-plan-sgp.ts";
import { zaiProvider } from "./zai.ts";
import { zaiCodingCnProvider } from "./zai-coding-cn.ts";
import { zenmuxProvider } from "./zenmux.ts";

/** Providers present in the generated catalog. `KnownProvider` additionally
 * includes purely dynamic providers (e.g. "radius") that have no static
 * catalog entry. */
export type BuiltinProvider = keyof typeof MODELS;

type BuiltinModelApi<
	TProvider extends BuiltinProvider,
	TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

const XIAOMI_MIMO_PROVIDERS = new Set([
	"xiaomi",
	"xiaomi-token-plan-cn",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-sgp",
]);

function normalizeBuiltinModel<TApi extends Api>(model: Model<TApi> | undefined): Model<TApi> | undefined {
	if (!model) return undefined;

	if (XIAOMI_MIMO_PROVIDERS.has(model.provider) && model.id === "mimo-v2.5-pro") {
		return {
			...model,
			compat: {
				...model.compat,
				requiresReasoningContentOnAssistantMessages: true,
				thinkingFormat: "deepseek",
				supportsDisabledThinking: false,
			},
		} as Model<TApi>;
	}

	if (model.provider === "anthropic" && model.id === "claude-opus-4-8") {
		return {
			...model,
			thinkingLevelMap: {
				...model.thinkingLevelMap,
				max: "max",
			},
		};
	}

	return model;
}

/** Typed read of the generated built-in catalog. */
export function getBuiltinModel<TProvider extends BuiltinProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<BuiltinModelApi<TProvider, TModelId>> {
	const models = MODELS[provider] as Record<string, Model<Api>> | undefined;
	return normalizeBuiltinModel(models?.[modelId as string]) as Model<BuiltinModelApi<TProvider, TModelId>>;
}

export function getBuiltinProviders(): BuiltinProvider[] {
	return Object.keys(MODELS) as BuiltinProvider[];
}

export function getBuiltinModels<TProvider extends BuiltinProvider>(
	provider: TProvider,
): Model<BuiltinModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[] {
	const models = MODELS[provider] as Record<string, Model<Api>> | undefined;
	return models
		? (Object.values(models)
				.map((model) => normalizeBuiltinModel(model))
				.filter((model): model is Model<Api> => model !== undefined) as Model<
				BuiltinModelApi<TProvider, keyof (typeof MODELS)[TProvider]>
			>[])
		: [];
}

/** All built-in providers, freshly constructed. */
export { radiusProvider };

export function builtinProviders(): Provider[] {
	return [
		alibabaCodingPlanProvider(),
		amazonBedrockProvider(),
		antLingProvider(),
		anthropicProvider(),
		azureOpenAIResponsesProvider(),
		cerebrasProvider(),
		cloudflareAIGatewayProvider(),
		cloudflareWorkersAIProvider(),
		cursorProvider(),
		deepinfraProvider(),
		deepseekProvider(),
		firepassProvider(),
		fireworksProvider(),
		fuguProvider(),
		githubCopilotProvider(),
		gitlabDuoProvider(),
		googleProvider(),
		googleGeminiCliProvider(),
		googleAntigravityProvider(),
		googleVertexProvider(),
		groqProvider(),
		huggingfaceProvider(),
		kiloProvider(),
		kimiCodingProvider(),
		litellmProvider(),
		lmStudioProvider(),
		minimaxProvider(),
		minimaxCnProvider(),
		minimaxCodeProvider(),
		minimaxCodeCnProvider(),
		mistralProvider(),
		moonshotProvider(),
		moonshotaiProvider(),
		moonshotaiCnProvider(),
		nanogptProvider(),
		nvidiaProvider(),
		ollamaProvider(),
		ollamaCloudProvider(),
		openaiProvider(),
		openaiCodexProvider(),
		openaiCodexDeviceProvider(),
		opencodeProvider(),
		opencodeGoProvider(),
		opencodeZenProvider(),
		openrouterProvider(),
		perplexityProvider(),
		radiusProvider(),
		qianfanProvider(),
		qwenPortalProvider(),
		syntheticProvider(),
		togetherProvider(),
		veniceProvider(),
		vercelAIGatewayProvider(),
		vllmProvider(),
		xaiProvider(),
		xiaomiProvider(),
		xiaomiTokenPlanAmsProvider(),
		xiaomiTokenPlanCnProvider(),
		xiaomiTokenPlanSgpProvider(),
		zaiProvider(),
		zaiCodingCnProvider(),
		zenmuxProvider(),
	];
}

/** A `Models` collection with every built-in provider registered. */
export function builtinModels(options?: CreateModelsOptions): MutableModels {
	const models = createModels(options);
	for (const provider of builtinProviders()) {
		models.setProvider(provider);
	}
	return models;
}

/** All built-in image-generation providers, freshly constructed. */
export function builtinImagesProviders(): ImagesProvider[] {
	return [openrouterImagesProvider()];
}

/** An `ImagesModels` collection with every built-in image-generation provider registered. */
export function builtinImagesModels(options?: CreateModelsOptions): MutableImagesModels {
	const models = createImagesModels(options);
	for (const provider of builtinImagesProviders()) {
		models.setProvider(provider);
	}
	return models;
}
