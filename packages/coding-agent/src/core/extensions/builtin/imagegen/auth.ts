import { credentialParts, isPlaceholderKey, nonEmpty, OPENAI_BASE_URL } from "./credentials.ts";
import { resolveConfiguredOpenAi } from "./openai-auth.ts";

export interface ImageGenAuthModel {
	provider: string;
	id: string;
	baseUrl: string;
	api?: string;
}

export type ImageGenRegistryAuthResult =
	| { ok: true; apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string }
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
	getProviderAuthStatus?(provider: string): { configured: boolean; source?: string };
}

export interface ResolveImageGenAuthDeps<TModel extends ImageGenAuthModel = ImageGenAuthModel> {
	modelRegistry: ImageGenAuthRegistry<TModel>;
	env?: Readonly<Record<string, string | undefined>>;
}

export interface ImageGenResolvedAuth {
	kind: "native-openai" | "gateway";
	apiKey: string | undefined;
	baseUrl: string;
	headers?: Record<string, string>;
	provenance: "store" | "env" | "provider-config";
	providerId?: string;
}

export type ImageGenAuthResolution = ImageGenResolvedAuth | { kind: "none"; reason: string };

/**
 * One source the tool may send the request to. `fallthrough` is true only for a gateway found by
 * scanning models.json: when it has no images endpoint (404/405) the tool tries the next candidate.
 * A source the user chose (a stored or overridden `openai`, the PI_IMAGE_GEN_PROVIDER pin, or
 * OPENAI_API_KEY) never falls through, so its failure is reported as is.
 */
export interface ImageGenCandidate extends ImageGenResolvedAuth {
	fallthrough: boolean;
}

export const SETUP_REASON =
	'Image generation is not configured. Store an OpenAI API key for provider "openai", configure an OpenAI-compatible gateway in models.json and optionally pin it with PI_IMAGE_GEN_PROVIDER, or set OPENAI_API_KEY.';

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

async function resolveGateway<TModel extends ImageGenAuthModel>(
	providerId: string,
	model: TModel,
	registry: ImageGenAuthRegistry<TModel>,
): Promise<ImageGenResolvedAuth | undefined> {
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

/**
 * Yields the image sources in precedence order, resolving each one's credentials only when the
 * previous candidate fell through: a stored `openai` key, the PI_IMAGE_GEN_PROVIDER pin, a
 * models.json `openai` override, scanned gateways, then OPENAI_API_KEY.
 */
export async function* imageGenCandidates<TModel extends ImageGenAuthModel>(
	deps: ResolveImageGenAuthDeps<TModel>,
): AsyncGenerator<ImageGenCandidate> {
	const registry = deps.modelRegistry;
	const env = deps.env ?? process.env;
	const openai = await resolveConfiguredOpenAi(registry);
	if (openai?.tier === "store") {
		yield { ...openai.resolution, fallthrough: false };
		return;
	}

	const groups = groupGatewayModels(registry.getAll());
	const pinnedProvider = nonEmpty(env.PI_IMAGE_GEN_PROVIDER);
	const pinnedModel = pinnedProvider === undefined ? undefined : groups.get(pinnedProvider);
	if (pinnedProvider !== undefined && pinnedModel !== undefined) {
		const pinned = await resolveGateway(pinnedProvider, pinnedModel, registry);
		if (pinned) {
			yield { ...pinned, fallthrough: false };
			return;
		}
	}

	if (openai) {
		yield { ...openai.resolution, fallthrough: false };
		return;
	}

	const providerIds = [...groups.keys()]
		.filter((providerId) => providerId !== pinnedProvider)
		.sort(compareProviderIds);
	for (const providerId of providerIds) {
		const model = groups.get(providerId);
		if (!model) continue;
		const gateway = await resolveGateway(providerId, model, registry);
		if (gateway) yield { ...gateway, fallthrough: true };
	}

	const envApiKey = nonEmpty(env.OPENAI_API_KEY);
	if (envApiKey && !isPlaceholderKey(envApiKey)) {
		yield {
			kind: "native-openai",
			apiKey: envApiKey,
			baseUrl: OPENAI_BASE_URL,
			provenance: "env",
			fallthrough: false,
		};
	}
}

export async function resolveImageGenAuth<TModel extends ImageGenAuthModel>(
	deps: ResolveImageGenAuthDeps<TModel>,
): Promise<ImageGenAuthResolution> {
	const first = await imageGenCandidates(deps).next();
	if (first.done) return { kind: "none", reason: SETUP_REASON };
	const { fallthrough: _fallthrough, ...resolution } = first.value;
	return resolution;
}
