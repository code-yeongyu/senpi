import { CLASSIFIER_MODELS, IMAGE_MODELS, MODELS } from "../models.generated.ts";
import { type CreateModelsOptions, createModels, type MutableModels, type Provider } from "../models.ts";
import type { AnyModel, Api, ClassifierApi, ClassifierModel, ImageApi, ImageModel, Model } from "../types.ts";
import { alibabaTokenPlanProvider } from "./alibaba-token-plan.ts";
import { amazonBedrockProvider } from "./amazon-bedrock.ts";
import { antLingProvider } from "./ant-ling.ts";
import { anthropicProvider } from "./anthropic.ts";
import { azureOpenAIResponsesProvider } from "./azure-openai-responses.ts";
import { baiProvider } from "./bai.ts";
import { basetenProvider } from "./baseten.ts";
import { cerebrasProvider } from "./cerebras.ts";
import { chatgptSubscriptionProvider } from "./chatgpt-subscription.ts";
import { cloudflareAIGatewayProvider } from "./cloudflare-ai-gateway.ts";
import { cloudflareWorkersAIProvider } from "./cloudflare-workers-ai.ts";
import { cursorProvider } from "./cursor.ts";
import modelDataManifest from "./data/.manifest.json" with { type: "json" };
import { deepseekProvider } from "./deepseek.ts";
import { devinProvider } from "./devin.ts";
import { fireworksProvider } from "./fireworks.ts";
import { githubCopilotProvider } from "./github-copilot.ts";
import { googleProvider } from "./google.ts";
import { googleVertexProvider } from "./google-vertex.ts";
import { groqProvider } from "./groq.ts";
import { huggingfaceProvider } from "./huggingface.ts";
import { KIMI_CODING_MODELS } from "./kimi-coding.models.ts";
import { kimiCodingProvider } from "./kimi-coding.ts";
import { metaProvider } from "./meta.ts";
import { minimaxProvider } from "./minimax.ts";
import { minimaxCnProvider } from "./minimax-cn.ts";
import { mistralProvider } from "./mistral.ts";
import { moonshotaiProvider } from "./moonshotai.ts";
import { moonshotaiCnProvider } from "./moonshotai-cn.ts";
import { nvidiaProvider } from "./nvidia.ts";
import { ollamaProvider } from "./ollama.ts";
import { openaiProvider } from "./openai.ts";
import { opencodeProvider } from "./opencode.ts";
import { opencodeGoProvider } from "./opencode-go.ts";
import { opengatewayProvider } from "./opengateway.ts";
import { openrouterProvider } from "./openrouter.ts";
import { qwenTokenPlanProvider } from "./qwen-token-plan.ts";
import { qwenTokenPlanCnProvider } from "./qwen-token-plan-cn.ts";
import { qwenTokenPlanIndividualProvider } from "./qwen-token-plan-individual.ts";
import { radiusProvider } from "./radius.ts";
import { togetherProvider } from "./together.ts";
import { typesafeProvider } from "./typesafe.ts";
import { veniceProvider } from "./venice.ts";
import { vercelAIGatewayProvider } from "./vercel-ai-gateway.ts";
import { xaiProvider } from "./xai.ts";
import { xiaomiProvider } from "./xiaomi.ts";
import { xiaomiTokenPlanAmsProvider } from "./xiaomi-token-plan-ams.ts";
import { xiaomiTokenPlanCnProvider } from "./xiaomi-token-plan-cn.ts";
import { xiaomiTokenPlanSgpProvider } from "./xiaomi-token-plan-sgp.ts";
import { zaiProvider } from "./zai.ts";
import { zaiCodingCnProvider } from "./zai-coding-cn.ts";

export { ollamaProvider, radiusProvider };

/**
 * Catalogs the fork owns by hand because models.dev does not describe them.
 *
 * A generation run emits neither their shard nor their data file, so they can
 * never appear in `MODELS`; they are still shipped providers and every catalog
 * read below must see them exactly like a generated one.
 */
const FORK_OWNED_CATALOGS = {
	"kimi-coding": KIMI_CODING_MODELS,
} as const;

type BuiltinCatalogs = typeof MODELS & typeof FORK_OWNED_CATALOGS;

const BUILTIN_CATALOGS: BuiltinCatalogs = { ...MODELS, ...FORK_OWNED_CATALOGS };

/** Providers present in the generated catalog, plus the fork-owned ones.
 * `KnownProvider` additionally includes purely dynamic providers
 * (e.g. "radius") that have no static catalog entry. */
export type BuiltinProvider = keyof BuiltinCatalogs;

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

/** Entries of one provider in a typed catalog; empty when the catalog has no shard for it. */
type CatalogEntries<TCatalog, TProvider> = TProvider extends keyof TCatalog
	? TCatalog[TProvider]
	: Record<never, never>;
type BuiltinChatModelId<TProvider extends BuiltinProvider> = keyof BuiltinCatalogs[TProvider];
type BuiltinImageModelId<TProvider extends BuiltinProvider> = keyof CatalogEntries<typeof IMAGE_MODELS, TProvider>;
type BuiltinClassifierModelId<TProvider extends BuiltinProvider> = keyof CatalogEntries<
	typeof CLASSIFIER_MODELS,
	TProvider
>;
/** API ids of catalog entries. Built-in getters return `Model<Api>` shapes, not literal entry types. */
type CatalogApi<TEntry> = TEntry extends { api: infer TApi extends string } ? TApi : never;

/** Typed read of one generated built-in chat model. */
export function getBuiltinModel<TProvider extends BuiltinProvider, TModelId extends BuiltinChatModelId<TProvider>>(
	provider: TProvider,
	modelId: TModelId,
): Model<CatalogApi<BuiltinCatalogs[TProvider][TModelId]>> {
	const models = BUILTIN_CATALOGS[provider] as Record<string, Model<Api>> | undefined;
	return normalizeBuiltinModel(models?.[modelId as string]) as Model<CatalogApi<BuiltinCatalogs[TProvider][TModelId]>>;
}

/** Typed read of one generated built-in image model. */
export function getBuiltinImageModel<
	TProvider extends BuiltinProvider,
	TModelId extends BuiltinImageModelId<TProvider>,
>(
	provider: TProvider,
	modelId: TModelId,
): ImageModel<CatalogApi<CatalogEntries<typeof IMAGE_MODELS, TProvider>[TModelId]>> {
	return (IMAGE_MODELS as Record<string, Record<string, ImageModel<ImageApi>> | undefined>)[provider]?.[
		modelId as string
	] as ImageModel<CatalogApi<CatalogEntries<typeof IMAGE_MODELS, TProvider>[TModelId]>>;
}

/** Typed read of one generated built-in classifier model. */
export function getBuiltinClassifierModel<
	TProvider extends BuiltinProvider,
	TModelId extends BuiltinClassifierModelId<TProvider>,
>(
	provider: TProvider,
	modelId: TModelId,
): ClassifierModel<CatalogApi<CatalogEntries<typeof CLASSIFIER_MODELS, TProvider>[TModelId]>> {
	return (CLASSIFIER_MODELS as Record<string, Record<string, ClassifierModel<ClassifierApi>> | undefined>)[provider]?.[
		modelId as string
	] as ClassifierModel<CatalogApi<CatalogEntries<typeof CLASSIFIER_MODELS, TProvider>[TModelId]>>;
}

export function getBuiltinProviders(): BuiltinProvider[] {
	return Object.keys(BUILTIN_CATALOGS) as BuiltinProvider[];
}

/** Generation timestamp shared by all built-in provider catalogs. */
export function getBuiltinModelDataGeneratedAt(): number | undefined {
	const generatedAt = Date.parse(modelDataManifest.generatedAt);
	return Number.isNaN(generatedAt) ? undefined : generatedAt;
}

export function getBuiltinModels<TProvider extends BuiltinProvider>(
	provider: TProvider,
): Model<CatalogApi<BuiltinCatalogs[TProvider][BuiltinChatModelId<TProvider>]>>[] {
	const models = BUILTIN_CATALOGS[provider] as Record<string, Model<Api>> | undefined;
	return Object.values(models ?? {})
		.map((model) => normalizeBuiltinModel(model))
		.filter((model): model is Model<Api> => model !== undefined) as Model<
		CatalogApi<BuiltinCatalogs[TProvider][BuiltinChatModelId<TProvider>]>
	>[];
}

export function getBuiltinImageModels<TProvider extends BuiltinProvider>(
	provider: TProvider,
): ImageModel<CatalogApi<CatalogEntries<typeof IMAGE_MODELS, TProvider>[BuiltinImageModelId<TProvider>]>>[] {
	const models = (IMAGE_MODELS as Record<string, Record<string, ImageModel<ImageApi>> | undefined>)[provider];
	return Object.values(models ?? {}) as ImageModel<
		CatalogApi<CatalogEntries<typeof IMAGE_MODELS, TProvider>[BuiltinImageModelId<TProvider>]>
	>[];
}

export function getBuiltinClassifierModels<TProvider extends BuiltinProvider>(
	provider: TProvider,
): ClassifierModel<
	CatalogApi<CatalogEntries<typeof CLASSIFIER_MODELS, TProvider>[BuiltinClassifierModelId<TProvider>]>
>[] {
	const models = (CLASSIFIER_MODELS as Record<string, Record<string, ClassifierModel<ClassifierApi>> | undefined>)[
		provider
	];
	return Object.values(models ?? {}) as ClassifierModel<
		CatalogApi<CatalogEntries<typeof CLASSIFIER_MODELS, TProvider>[BuiltinClassifierModelId<TProvider>]>
	>[];
}

export function getAllBuiltinModels<TProvider extends BuiltinProvider>(provider: TProvider): AnyModel[] {
	return [...getBuiltinModels(provider), ...getBuiltinImageModels(provider), ...getBuiltinClassifierModels(provider)];
}

/** All built-in providers, freshly constructed. */
export function builtinProviders(): Provider[] {
	return [
		alibabaTokenPlanProvider(),
		amazonBedrockProvider(),
		antLingProvider(),
		anthropicProvider(),
		azureOpenAIResponsesProvider(),
		baiProvider(),
		basetenProvider(),
		cerebrasProvider(),
		cloudflareAIGatewayProvider(),
		cloudflareWorkersAIProvider(),
		cursorProvider(),
		devinProvider(),
		deepseekProvider(),
		fireworksProvider(),
		githubCopilotProvider(),
		googleProvider(),
		googleVertexProvider(),
		groqProvider(),
		huggingfaceProvider(),
		kimiCodingProvider(),
		metaProvider(),
		minimaxProvider(),
		minimaxCnProvider(),
		mistralProvider(),
		moonshotaiProvider(),
		moonshotaiCnProvider(),
		nvidiaProvider(),
		openaiProvider(),
		chatgptSubscriptionProvider(),
		ollamaProvider(),
		opencodeProvider(),
		opencodeGoProvider(),
		opengatewayProvider(),
		openrouterProvider(),
		qwenTokenPlanProvider(),
		qwenTokenPlanCnProvider(),
		qwenTokenPlanIndividualProvider(),
		radiusProvider(),
		togetherProvider(),
		typesafeProvider(),
		veniceProvider(),
		vercelAIGatewayProvider(),
		xaiProvider(),
		xiaomiProvider(),
		xiaomiTokenPlanAmsProvider(),
		xiaomiTokenPlanCnProvider(),
		xiaomiTokenPlanSgpProvider(),
		zaiProvider(),
		zaiCodingCnProvider(),
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
