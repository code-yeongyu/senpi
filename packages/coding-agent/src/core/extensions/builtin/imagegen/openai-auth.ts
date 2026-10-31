import type {
	ImageGenAuthModel,
	ImageGenAuthRegistry,
	ImageGenProviderAuthResult,
	ImageGenResolvedAuth,
} from "./auth.ts";
import { credentialParts, nonEmpty, OPENAI_BASE_URL, sameBaseUrl } from "./credentials.ts";

/**
 * How explicitly the user configured the `openai` provider. `store` (a stored or runtime key) keeps
 * the lead it always had, ahead of PI_IMAGE_GEN_PROVIDER; `provider-config` (a models.json override
 * of its baseUrl or key) ranks after the pin. A key that only comes from OPENAI_API_KEY is neither:
 * it stays the last resort behind configured gateways.
 */
export type OpenAiTier = "store" | "provider-config";

export interface ConfiguredOpenAi {
	tier: OpenAiTier;
	resolution: ImageGenResolvedAuth;
}

function isStoredApiKey(value: unknown): boolean {
	return typeof value === "object" && value !== null && "type" in value && value.type === "api_key";
}

function openAiTier(
	stored: boolean,
	model: ImageGenAuthModel,
	statusSource: string | undefined,
): OpenAiTier | undefined {
	if (stored || statusSource === "runtime") return "store";
	if (!sameBaseUrl(model.baseUrl, OPENAI_BASE_URL)) return "provider-config";
	if (statusSource?.startsWith("models_json")) return "provider-config";
	return undefined;
}

async function storedKeyWithoutCatalogModel<TModel extends ImageGenAuthModel>(
	registry: ImageGenAuthRegistry<TModel>,
): Promise<ConfiguredOpenAi | undefined> {
	let resolved: ImageGenProviderAuthResult | undefined;
	try {
		resolved = await registry.getProviderAuth("openai");
	} catch {
		return undefined;
	}
	const credentials = credentialParts(resolved?.auth);
	if (!credentials) return undefined;
	return {
		tier: "store",
		resolution: {
			kind: "native-openai",
			...credentials,
			baseUrl: OPENAI_BASE_URL,
			provenance: "store",
			providerId: "openai",
		},
	};
}

export async function resolveConfiguredOpenAi<TModel extends ImageGenAuthModel>(
	registry: ImageGenAuthRegistry<TModel>,
): Promise<ConfiguredOpenAi | undefined> {
	const stored = isStoredApiKey(registry.authStorage.get("openai"));
	const model = registry.getAll().find((candidate) => candidate.provider === "openai" && nonEmpty(candidate.baseUrl));
	if (!model) return stored ? storedKeyWithoutCatalogModel(registry) : undefined;
	const tier = openAiTier(stored, model, registry.getProviderAuthStatus?.("openai").source);
	if (!tier) return undefined;
	let resolved: Awaited<ReturnType<typeof registry.getApiKeyAndHeaders>>;
	try {
		resolved = await registry.getApiKeyAndHeaders(model);
	} catch {
		return undefined;
	}
	if (!resolved.ok) return undefined;
	const credentials = credentialParts(resolved);
	if (!credentials) return undefined;
	const baseUrl = nonEmpty(resolved.baseUrl) ?? model.baseUrl;
	return {
		tier,
		resolution: {
			kind: sameBaseUrl(baseUrl, OPENAI_BASE_URL) ? "native-openai" : "gateway",
			...credentials,
			baseUrl,
			provenance: tier,
			providerId: "openai",
		},
	};
}
