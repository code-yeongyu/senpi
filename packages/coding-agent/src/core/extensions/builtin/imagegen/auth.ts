export interface ImageGenAuthModel {
	provider: string;
	id: string;
	baseUrl: string;
	api?: string;
}

export type ImageGenRegistryAuthResult =
	| { ok: true; apiKey?: string; headers?: Record<string, string | null> }
	| { ok: false; error: string };

export interface ImageGenProviderAuthResult {
	auth: {
		apiKey?: string;
		headers?: Record<string, string | null>;
	};
}

export interface ImageGenAuthRegistry<TModel extends ImageGenAuthModel = ImageGenAuthModel> {
	authStorage: {
		get(provider: string): unknown;
	};
	getAll(): TModel[];
	getApiKeyAndHeaders(model: TModel): Promise<ImageGenRegistryAuthResult>;
	getProviderAuth(provider: string): Promise<ImageGenProviderAuthResult | undefined>;
}

export interface ResolveImageGenAuthDeps<TModel extends ImageGenAuthModel = ImageGenAuthModel> {
	modelRegistry: ImageGenAuthRegistry<TModel>;
	env?: Readonly<Record<string, string | undefined>>;
}

export type ImageGenAuthResolution =
	| {
			kind: "native-openai" | "gateway";
			apiKey: string | undefined;
			baseUrl: string;
			headers?: Record<string, string>;
			provenance: "store" | "env" | "provider-config";
			providerId?: string;
	  }
	| { kind: "none"; reason: string };

interface CredentialParts {
	apiKey: string | undefined;
	headers?: Record<string, string>;
}

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const SETUP_REASON =
	'Image generation is not configured. Store an OpenAI API key for provider "openai", configure an OpenAI-compatible gateway in models.json and optionally pin it with PI_IMAGE_GEN_PROVIDER, or set OPENAI_API_KEY.';

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function resolvedHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (typeof value === "string" && value.trim().length > 0) resolved[name] = value;
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function credentialParts(
	auth: { apiKey?: string; headers?: Record<string, string | null> } | undefined,
): CredentialParts | undefined {
	const apiKey = nonEmpty(auth?.apiKey);
	if (!apiKey) return undefined;
	const headers = resolvedHeaders(auth?.headers);
	return { apiKey, ...(headers ? { headers } : {}) };
}

function isStoredApiKey(value: unknown): boolean {
	return typeof value === "object" && value !== null && "type" in value && value.type === "api_key";
}

function isGatewayApi(api: string | undefined): boolean {
	return api === "openai-completions" || api === "openai-responses";
}

function compareText(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function compareProviderIds(left: string, right: string): number {
	const leftMatches = /openai/i.test(left);
	const rightMatches = /openai/i.test(right);
	if (leftMatches !== rightMatches) return leftMatches ? -1 : 1;
	return compareText(left, right);
}

function groupGatewayModels<TModel extends ImageGenAuthModel>(models: readonly TModel[]): Map<string, TModel> {
	const groups = new Map<string, TModel>();
	const ordered = [...models].sort(
		(left, right) => compareText(left.provider, right.provider) || compareText(left.id, right.id),
	);
	for (const model of ordered) {
		if (model.provider === "openai" || !isGatewayApi(model.api) || !nonEmpty(model.baseUrl)) continue;
		if (!groups.has(model.provider)) groups.set(model.provider, model);
	}
	return groups;
}

async function resolveStoredOpenAi<TModel extends ImageGenAuthModel>(
	registry: ImageGenAuthRegistry<TModel>,
): Promise<ImageGenAuthResolution | undefined> {
	if (!isStoredApiKey(registry.authStorage.get("openai"))) return undefined;
	let resolved: ImageGenProviderAuthResult | undefined;
	try {
		resolved = await registry.getProviderAuth("openai");
	} catch {
		return undefined;
	}
	const credentials = credentialParts(resolved?.auth);
	if (!credentials) return undefined;
	return {
		kind: "native-openai",
		...credentials,
		baseUrl: OPENAI_BASE_URL,
		provenance: "store",
		providerId: "openai",
	};
}

async function resolveGateway<TModel extends ImageGenAuthModel>(
	providerId: string,
	model: TModel,
	registry: ImageGenAuthRegistry<TModel>,
): Promise<ImageGenAuthResolution | undefined> {
	const baseUrl = nonEmpty(model.baseUrl);
	if (!baseUrl) return undefined;
	let resolved: ImageGenRegistryAuthResult;
	try {
		resolved = await registry.getApiKeyAndHeaders(model);
	} catch {
		return undefined;
	}
	if (!resolved.ok) return undefined;
	const credentials = credentialParts(resolved);
	if (!credentials) return undefined;
	return {
		kind: "gateway",
		...credentials,
		baseUrl,
		provenance: "provider-config",
		providerId,
	};
}

export async function resolveImageGenAuth<TModel extends ImageGenAuthModel>(
	deps: ResolveImageGenAuthDeps<TModel>,
): Promise<ImageGenAuthResolution> {
	const native = await resolveStoredOpenAi(deps.modelRegistry);
	if (native) return native;

	const groups = groupGatewayModels(deps.modelRegistry.getAll());
	const env = deps.env ?? process.env;
	const pinnedProvider = nonEmpty(env.PI_IMAGE_GEN_PROVIDER);
	if (pinnedProvider) {
		const pinnedModel = groups.get(pinnedProvider);
		if (pinnedModel) {
			const pinned = await resolveGateway(pinnedProvider, pinnedModel, deps.modelRegistry);
			if (pinned) return pinned;
		}
	}

	const providerIds = [...groups.keys()]
		.filter((providerId) => providerId !== pinnedProvider)
		.sort(compareProviderIds);
	for (const providerId of providerIds) {
		const model = groups.get(providerId);
		if (!model) continue;
		const gateway = await resolveGateway(providerId, model, deps.modelRegistry);
		if (gateway) return gateway;
	}

	const envApiKey = nonEmpty(env.OPENAI_API_KEY);
	if (envApiKey) {
		return {
			kind: "native-openai",
			apiKey: envApiKey,
			baseUrl: OPENAI_BASE_URL,
			provenance: "env",
		};
	}

	return { kind: "none", reason: SETUP_REASON };
}
