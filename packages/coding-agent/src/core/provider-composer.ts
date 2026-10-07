import {
	type AnyModel,
	type Api,
	type AssistantMessageEventStream,
	type AuthCheck,
	type AuthContext,
	type AuthResult,
	type ClassifierApi,
	type Credential,
	getApiProvider,
	getCurrentTools,
	getProtocol,
	getToolCallFormat,
	type ImageApi,
	isModelType,
	lazyStream,
	type Model,
	type OAuthAuth,
	type OAuthCredential,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type Provider,
	type ProviderClassifier,
	type ProviderHeaders,
	type ProviderImages,
	type RefreshModelsContext,
	type SimpleStreamOptions,
	type StreamOptions,
	type TranscriptContext,
	transformContext,
	wrapStreamWithToolCallMiddleware,
} from "@earendil-works/pi-ai";
import { classifierErrorResult, imageErrorResult } from "@earendil-works/pi-ai/utils/model-operations";
import type { RetryPolicyProfile } from "@earendil-works/pi-ai/utils/retry-profile/types";
import type { ModelConfig, ModelsJsonModel, ModelsJsonModelOverride, ModelsJsonProvider } from "./model-config.ts";
import { composeApiKeyAuth, configuredApiKey, configuredHeaders, withConfiguredAuth } from "./provider-api-key-auth.ts";
import { configuredHeaderAuthStatus, type HeaderAuthStatusSource } from "./provider-header-auth.ts";
import {
	clearConfigValueCache,
	getConfigValueEnvVarNames,
	isCommandConfigValue,
	isConfigValueConfigured,
	resolveHeadersOrThrow,
} from "./resolve-config-value.ts";

export interface ExtensionOAuthConfig {
	name: string;
	/** Whether access through this auth method is backed by a provider subscription. */
	isSubscription?: boolean;
	/** @deprecated Retained for extension source compatibility; ignored by canonical auth flows. */
	usesCallbackServer?: boolean;
	check?(input: { ctx: AuthContext; credential?: OAuthCredential }): Promise<AuthCheck | undefined>;
	/**
	 * Request auth for providers whose credentials live outside auth.json —
	 * an environment token, or a CLI the provider shells out to. Supplying this
	 * gives the provider api-key auth it would otherwise be denied for having
	 * `oauth`, so ambient users resolve instead of hitting
	 * "Provider is not configured". Never consulted once a credential is stored.
	 */
	resolveAmbient?(input: { ctx: AuthContext; signal?: AbortSignal }): Promise<AuthResult | undefined>;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
	modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
}

interface ProviderModelConfigBase {
	id: string;
	name: string;
	upstreamModelId?: string;
	api?: string;
	baseUrl?: string;
	input: ("text" | "image" | "video")[];
	inputLimits?: AnyModel["inputLimits"];
	cost: AnyModel["cost"];
	headers?: Record<string, string>;
}

export interface ProviderChatModelConfig extends ProviderModelConfigBase {
	type?: "chat";
	api?: Api;
	serviceTier?: "auto" | "flex" | "priority" | "ultrafast";
	promptPreset?: string;
	recoverTextToolCalls?: boolean;
	reasoning: boolean;
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	promptCache?: Model<Api>["promptCache"];
	contextWindow: number;
	maxTokens: number;
	samplingParams?: Record<string, unknown>;
	extraBody?: Record<string, unknown>;
	cacheRetention?: Model<Api>["cacheRetention"];
	compat?: Model<Api>["compat"];
}

export interface ProviderImageModelConfig extends ProviderModelConfigBase {
	type: "image";
	api?: ImageApi;
	output: ("text" | "image")[];
}

export interface ProviderClassifierModelConfig extends ProviderModelConfigBase {
	type: "classifier";
	api?: ClassifierApi;
	contextWindow: number;
}

export type ProviderModelConfig = ProviderChatModelConfig | ProviderImageModelConfig | ProviderClassifierModelConfig;

/** Input type for the extension registerProvider API. */
export interface ProviderConfigInput {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
	images?: Partial<Record<ImageApi, ProviderImages>>;
	classifiers?: Partial<Record<ClassifierApi, ProviderClassifier>>;
	headers?: Record<string, string>;
	extraBody?: Record<string, unknown>;
	authHeader?: boolean;
	oauth?: ExtensionOAuthConfig;
	retryPolicy?: RetryPolicyProfile;
	models?: ProviderModelConfig[];
	refreshModels?(context: RefreshModelsContext): Promise<ProviderModelConfig[]>;
	/**
	 * Deterministic usability gate for implicit fallback expansion. Return `false`
	 * while this lane is guaranteed to refuse unattended execution (for example an
	 * unacknowledged approval gate); the provider stays registered and explicitly
	 * selectable, but bare-family fallback expansion skips it. Re-evaluated on
	 * every expansion, so a settings change takes effect without re-registration.
	 */
	fallbackEligible?(): boolean;
}

export type AuthStatus = {
	configured: boolean;
	source?:
		| "stored"
		| "runtime"
		| "environment"
		| "fallback"
		| "models_json_key"
		| "models_json_command"
		| HeaderAuthStatusSource;
	label?: string;
	/** Environment auth that came only from a shared cloud credential chain (`AuthCheck.ambient`). */
	ambient?: true;
};

export const clearApiKeyCache = clearConfigValueCache;

type ModelWithConfigMetadata = Model<Api> & {
	promptPreset?: string;
};

function getAllProviderModels(provider: Provider | undefined): readonly AnyModel[] {
	return provider ? (provider.getAllModels?.() ?? provider.getModels()) : [];
}

function isChatModelConfig(definition: ProviderModelConfig): definition is ProviderChatModelConfig {
	return (definition.type ?? "chat") === "chat";
}

/** Extension chat-model definition for a chat model id (image/classifier definitions never match). */
function findExtensionChatModel(
	extension: ProviderConfigInput | undefined,
	modelId: string,
): ProviderChatModelConfig | undefined {
	return extension?.models?.filter(isChatModelConfig).find((entry) => entry.id === modelId);
}

function mergeCompat(
	base: Model<Api>["compat"],
	override: Model<Api>["compat"] | ModelsJsonModelOverride["compat"],
): Model<Api>["compat"] {
	if (!override) return base;
	const merged = { ...base, ...override } as NonNullable<Model<Api>["compat"]>;
	const baseNested = base as Record<string, unknown> | undefined;
	const overrideNested = override as Record<string, unknown>;
	const mergedNested = merged as Record<string, unknown>;
	for (const key of ["openRouterRouting", "vercelGatewayRouting", "chatTemplateKwargs", "chatTemplateArgs"] as const) {
		const baseValue = baseNested?.[key];
		const overrideValue = overrideNested[key];
		if (
			(typeof baseValue === "object" && baseValue !== null) ||
			(typeof overrideValue === "object" && overrideValue !== null)
		) {
			mergedNested[key] = { ...(baseValue as object | undefined), ...(overrideValue as object | undefined) };
		}
	}
	return merged;
}

function mergeInputLimits(
	base: Model<Api>["inputLimits"],
	override: ModelsJsonModelOverride["inputLimits"],
): Model<Api>["inputLimits"] {
	if (!override) return base;
	return {
		...base,
		...override,
		images: override.images
			? {
					...base?.images,
					...override.images,
					resize: override.images.resize
						? { ...base?.images?.resize, ...override.images.resize }
						: base?.images?.resize,
				}
			: base?.images,
	};
}

function applyModelOverride(model: Model<Api>, override: ModelsJsonModelOverride): ModelWithConfigMetadata {
	return {
		...model,
		name: override.name ?? model.name,
		promptPreset: override.promptPreset ?? (model as Model<Api> & { promptPreset?: string }).promptPreset,
		recoverTextToolCalls: override.recoverTextToolCalls ?? model.recoverTextToolCalls,
		reasoning: override.reasoning ?? model.reasoning,
		thinkingLevelMap: override.thinkingLevelMap
			? override.thinkingLevelMapMode === "replace"
				? override.thinkingLevelMap
				: { ...model.thinkingLevelMap, ...override.thinkingLevelMap }
			: model.thinkingLevelMap,
		input: (override.input as ("text" | "image" | "video")[] | undefined) ?? model.input,
		inputLimits: mergeInputLimits(model.inputLimits, override.inputLimits),
		cost: override.cost
			? {
					input: override.cost.input ?? model.cost.input,
					output: override.cost.output ?? model.cost.output,
					cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
					cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
					tiers: override.cost.tiers ?? model.cost.tiers,
				}
			: model.cost,
		promptCache: override.promptCache ? { ...model.promptCache, ...override.promptCache } : model.promptCache,
		contextWindow: override.contextWindow ?? model.contextWindow,
		maxTokens: override.maxTokens ?? model.maxTokens,
		cacheRetention: override.cacheRetention ?? model.cacheRetention,
		samplingParams: override.samplingParams
			? { ...model.samplingParams, ...override.samplingParams }
			: model.samplingParams,
		compat: mergeCompat(model.compat, override.compat),
	};
}

function modelFromJson(
	providerId: string,
	definition: ModelsJsonModel,
	providerConfig: ModelsJsonProvider,
	defaults: { api?: Api; baseUrl?: string } | undefined,
): ModelWithConfigMetadata {
	const api = definition.api ?? providerConfig.api ?? defaults?.api;
	if (!api) {
		throw new Error(
			`Provider ${providerId}, model ${definition.id}: no "api" specified. Set at provider or model level.`,
		);
	}
	const baseUrl = definition.baseUrl ?? providerConfig.baseUrl ?? defaults?.baseUrl;
	if (!baseUrl) throw new Error(`Provider ${providerId}: "baseUrl" is required when defining custom models.`);
	if (definition.contextWindow !== undefined && definition.contextWindow <= 0) {
		throw new Error(`Provider ${providerId}, model ${definition.id}: invalid contextWindow`);
	}
	if (definition.maxTokens !== undefined && definition.maxTokens <= 0) {
		throw new Error(`Provider ${providerId}, model ${definition.id}: invalid maxTokens`);
	}
	return {
		id: definition.id,
		name: definition.name ?? definition.id,
		promptPreset: definition.promptPreset,
		recoverTextToolCalls: definition.recoverTextToolCalls,
		api: api as Api,
		provider: providerId,
		baseUrl,
		reasoning: definition.reasoning ?? false,
		thinkingLevelMap: definition.thinkingLevelMap,
		defaultThinkingLevel: definition.defaultThinkingLevel,
		input: (definition.input ?? ["text"]) as ("text" | "image" | "video")[],
		inputLimits: definition.inputLimits,
		cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		promptCache: definition.promptCache,
		contextWindow: definition.contextWindow ?? 128000,
		maxTokens: definition.maxTokens ?? 16384,
		samplingParams: definition.samplingParams,
		headers: undefined,
		cacheRetention: definition.cacheRetention ?? providerConfig.cacheRetention,
		compat: mergeCompat(providerConfig.compat, definition.compat),
	};
}

function findModelDefaults(models: readonly AnyModel[], modelId: string, api?: Api): Model<Api> | undefined {
	const chatModels = models.filter((model) => isModelType(model, "chat"));
	return (
		chatModels.find((model) => model.id === modelId) ??
		(api ? chatModels.find((model) => model.api === api) : undefined) ??
		chatModels.find((model) => model.api === "openai-completions") ??
		chatModels[0]
	);
}

function findExtensionModelDefaults(
	models: readonly AnyModel[],
	definition: ProviderModelConfig,
): AnyModel | undefined {
	const type = definition.type ?? "chat";
	const candidates = models.filter((model) => isModelType(model, type));
	return (
		candidates.find((model) => model.id === definition.id) ??
		(definition.api ? candidates.find((model) => model.api === definition.api) : undefined) ??
		(type === "chat" ? candidates.find((model) => model.api === "openai-completions") : undefined) ??
		candidates[0]
	);
}

function extensionModelFromDefinition(
	providerId: string,
	models: readonly AnyModel[],
	config: ProviderConfigInput,
	definition: ProviderModelConfig,
): AnyModel {
	const type = definition.type ?? "chat";
	const defaults = findExtensionModelDefaults(models, definition);
	const api = definition.api ?? (type === "chat" ? config.api : undefined) ?? defaults?.api;
	if (!api) {
		throw new Error(
			type === "chat"
				? `Provider ${providerId}, model ${definition.id}: no "api" specified. Set at provider or model level.`
				: `Provider ${providerId}, model ${definition.id}: no "api" specified. Set it at model level.`,
		);
	}
	const baseUrl = definition.baseUrl ?? config.baseUrl ?? defaults?.baseUrl;
	if (!baseUrl) throw new Error(`Provider ${providerId}: "baseUrl" is required when defining custom models.`);
	if (definition.type === "image") {
		return { ...definition, api: api as ImageApi, provider: providerId, baseUrl, headers: undefined };
	}
	if (definition.type === "classifier") {
		return { ...definition, api: api as ClassifierApi, provider: providerId, baseUrl, headers: undefined };
	}
	return { ...definition, api: api as Api, provider: providerId, baseUrl, headers: undefined };
}

function applyModelsJson(
	providerId: string,
	baseModels: readonly AnyModel[],
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): AnyModel[] {
	if (!config) return [...baseModels];
	const hasOverrides = config.modelOverrides && Object.keys(config.modelOverrides).length > 0;
	if (
		!config.models?.length &&
		!config.baseUrl &&
		!config.headers &&
		!config.extraBody &&
		!config.compat &&
		!hasOverrides &&
		!config.whitelist &&
		!config.blacklist &&
		config.hideFreeModels === undefined &&
		!config.apiKey &&
		config.authHeader === undefined
	) {
		throw new Error(
			`Provider ${providerId}: must specify "baseUrl", "headers", "extraBody", "compat", "modelOverrides", or "models".`,
		);
	}

	// An explicit local Ollama catalog replaces Cloud discovery instead of rebinding its dynamic tags to localhost.
	const configuredBaseModels = providerId === "ollama" && config.models?.length ? [] : baseModels;
	const models: AnyModel[] = configuredBaseModels.map((model) => {
		const baseUrl = config.baseUrl ?? model.baseUrl;
		return isModelType(model, "chat")
			? { ...model, baseUrl, compat: mergeCompat(model.compat, config.compat) }
			: { ...model, baseUrl };
	});
	for (const definition of config.models ?? []) {
		const existingIndex = models.findIndex((model) => isModelType(model, "chat") && model.id === definition.id);
		const defaults =
			existingIndex >= 0
				? models[existingIndex]
				: findModelDefaults(models, definition.id, definition.api ?? extension?.api ?? config.api);
		// Extension-provided api/baseUrl still win over the resolved defaults so a
		// models.json extension can retarget an inherited built-in entry, and remain
		// the fallback when no built-in default exists (empty catalog).
		const model = modelFromJson(providerId, definition, config, {
			...defaults,
			api: extension?.api ?? defaults?.api,
			baseUrl: extension?.baseUrl ?? defaults?.baseUrl,
		});
		if (existingIndex >= 0) models[existingIndex] = model;
		else models.push(model);
	}
	const whitelist = config.whitelist ? new Set(config.whitelist) : undefined;
	const blacklist = config.blacklist ? new Set(config.blacklist) : undefined;
	const hideFree = config.hideFreeModels === true;
	return models.filter(
		(model) =>
			(whitelist === undefined || whitelist.has(model.id)) &&
			(blacklist === undefined || !blacklist.has(model.id)) &&
			!(hideFree && model.cost.input === 0 && model.cost.output === 0),
	);
}

function applyExtension(
	providerId: string,
	models: readonly AnyModel[],
	config: ProviderConfigInput | undefined,
	customModelIds: ReadonlySet<string>,
): AnyModel[] {
	if (!config) return [...models];
	if (!config.models) {
		return config.baseUrl ? models.map((model) => ({ ...model, baseUrl: config.baseUrl! })) : [...models];
	}
	const declaredModels = config.models;
	const extensionModels = declaredModels.map((definition) =>
		extensionModelFromDefinition(providerId, models, config, definition),
	);
	return [
		...extensionModels,
		...models.filter(
			(model) =>
				isModelType(model, "chat") &&
				customModelIds.has(model.id) &&
				!declaredModels.some((definition) => isChatModelConfig(definition) && definition.id === model.id),
		),
	];
}

function adaptOAuth(config: ExtensionOAuthConfig): OAuthAuth {
	return {
		name: config.name,
		isSubscription: config.isSubscription,
		login: async (callbacks) => {
			const credential = await config.login({
				onAuth: (info) => callbacks.notify({ type: "auth_url", ...info }),
				onDeviceCode: (info) => callbacks.notify({ type: "device_code", ...info }),
				onPrompt: (prompt) => callbacks.prompt({ type: "text", ...prompt }),
				onProgress: (message) => callbacks.notify({ type: "progress", message }),
				onManualCodeInput: () => callbacks.prompt({ type: "manual_code", message: "Paste the authorization code" }),
				onSelect: (prompt) => callbacks.prompt({ type: "select", ...prompt }),
				signal: callbacks.signal,
			});
			return { ...credential, type: "oauth" };
		},
		refresh: async (credential, signal) => ({ ...(await config.refreshToken(credential, signal)), type: "oauth" }),
		toAuth: async (credential) => ({ apiKey: config.getApiKey(credential) }),
		...(config.check ? { check: config.check } : {}),
	};
}

function composeOAuthAuth(
	providerId: string,
	base: Provider | undefined,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): OAuthAuth | undefined {
	const oauth = extension?.oauth ? adaptOAuth(extension.oauth) : base?.auth.oauth;
	if (!oauth) return undefined;
	const rawHeaders = configuredHeaders(config, extension);
	const authHeader = extension?.authHeader ?? config?.authHeader ?? false;
	return {
		...oauth,
		toAuth: async (credential) => {
			const auth = await oauth.toAuth(credential);
			const env = credential.env;
			const headers = await resolveHeadersOrThrow(
				rawHeaders,
				`provider "${providerId}"`,
				typeof env === "object" && env !== null ? (env as Record<string, string>) : undefined,
			);
			return withConfiguredAuth(auth, headers, authHeader);
		},
	};
}

function rawModelHeaders(
	model: AnyModel,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): Record<string, string> | undefined {
	// models.json definitions and overrides are chat-only. Extension definitions
	// are matched by operation and id so colliding models cannot share headers.
	const chatDefinition = isModelType(model, "chat")
		? config?.models?.find((entry) => entry.id === model.id)
		: undefined;
	const extensionModel = extension?.models?.find(
		(entry) => (entry.type ?? "chat") === (model.type ?? "chat") && entry.id === model.id,
	);
	const headers = {
		...(isModelType(model, "chat") ? config?.modelOverrides?.[model.id]?.headers : undefined),
		...chatDefinition?.headers,
		...extensionModel?.headers,
	};
	return Object.keys(headers).length > 0 ? headers : undefined;
}

function rawModelExtraBody(
	model: Model<Api>,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): Record<string, unknown> | undefined {
	const definition = config?.models?.find((entry) => entry.id === model.id);
	const extensionModel = findExtensionChatModel(extension, model.id);
	const extraBody = {
		...config?.modelOverrides?.[model.id]?.extraBody,
		...definition?.extraBody,
		...extensionModel?.extraBody,
	};
	return Object.keys(extraBody).length > 0 ? extraBody : undefined;
}

export function validateExtensionProvider(
	providerId: string,
	base: Provider | undefined,
	modelsConfig: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput,
): void {
	if (extension.streamSimple && !extension.api) {
		throw new Error(`Provider ${providerId}: "api" is required when registering streamSimple.`);
	}
	applyExtension(
		providerId,
		applyModelsJson(providerId, getAllProviderModels(base), modelsConfig, extension),
		extension,
		new Set((modelsConfig?.models ?? []).map((definition) => definition.id)),
	);
}

/** Compose built-in, models.json, and extension layers without reading credentials. */
export function composeModelProvider(
	providerId: string,
	base: Provider | undefined,
	modelConfig: ModelConfig,
	extension: ProviderConfigInput | undefined,
): Provider {
	const config = modelConfig.getProvider(providerId);
	let extensionOAuthCredential: OAuthCredentials | undefined;
	let refreshedExtensionModels: ProviderConfigInput["models"];
	const currentExtension = (): ProviderConfigInput | undefined =>
		extension && refreshedExtensionModels ? { ...extension, models: refreshedExtensionModels } : extension;
	// models.json modelOverrides are the topmost user-config layer: they apply once,
	// after custom-model upserts, extension model replacement, and legacy OAuth projection.
	const getAllModels = (): AnyModel[] => {
		let models = applyExtension(
			providerId,
			applyModelsJson(providerId, getAllProviderModels(base), config, currentExtension()),
			currentExtension(),
			new Set((config?.models ?? []).map((definition) => definition.id)),
		);
		if (extensionOAuthCredential && extension?.oauth?.modifyModels) {
			// The extension hook is chat-only; other model types pass through untouched.
			models = [
				...extension.oauth.modifyModels(
					models.filter((model) => isModelType(model, "chat")),
					extensionOAuthCredential,
				),
				...models.filter((model) => !isModelType(model, "chat")),
			];
		}
		return models.map((model) => {
			const override = config?.modelOverrides?.[model.id];
			return override && isModelType(model, "chat") ? applyModelOverride(model, override) : model;
		});
	};
	// Validate eagerly so registration/reload reports structural errors immediately.
	getAllModels();
	const apiKey = composeApiKeyAuth(providerId, base, config, extension);
	const oauth = composeOAuthAuth(providerId, base, config, extension);
	if (!apiKey && !oauth) throw new Error(`Provider ${providerId}: no authentication method configured.`);
	// The documented local `ollama` models.json catalog must not invoke the Cloud builtin's refresh with its
	const refreshBase = providerId === "ollama" && config?.models?.length ? undefined : base?.refreshModels?.bind(base);

	const supportsBaseApi = (model: Model<Api>) => base?.getModels().some((entry) => entry.api === model.api) ?? false;
	const streamWith = (
		model: Model<Api>,
		context: TranscriptContext,
		options: StreamOptions | undefined,
		simple: boolean,
	): AssistantMessageEventStream =>
		lazyStream(model, async () => {
			const format = getToolCallFormat(model);
			const tools = format ? getCurrentTools(context.messages) : [];
			if (format && tools.length > 0) {
				const protocol = getProtocol(format);
				const transformedContext = transformContext(context, protocol);
				const innerStream = streamWith(model, transformedContext, options, simple);
				return wrapStreamWithToolCallMiddleware(innerStream, protocol, tools);
			}
			if (extension?.streamSimple && model.api === extension.api) {
				return extension.streamSimple(model, context, options as SimpleStreamOptions);
			}
			if (base && supportsBaseApi(model)) {
				return simple
					? base.streamSimple(model, context, options as SimpleStreamOptions)
					: base.stream(model, context, options);
			}
			const api = getApiProvider(model.api);
			if (!api) {
				throw new Error(
					`No API provider registered for api: ${model.api} (model "${model.provider}/${model.id}"). ` +
						`Load the extension that implements this api, or fix the "api" value for provider "${providerId}" in models.json.`,
				);
			}
			return simple
				? api.streamSimple(model, context, options as SimpleStreamOptions)
				: api.stream(model, context, options);
		});

	const provider: Provider = {
		id: providerId,
		name: extension?.name ?? config?.name ?? base?.name ?? extension?.oauth?.name ?? providerId,
		baseUrl: extension?.baseUrl ?? config?.baseUrl ?? base?.baseUrl,
		headers: base?.headers,
		// Composed providers must not silently drop provider-declared retry profiles.
		retryPolicy: extension?.retryPolicy ?? base?.retryPolicy,
		auth: { ...(apiKey ? { apiKey } : {}), ...(oauth ? { oauth } : {}) },
		getModels: () => getAllModels().filter((model) => isModelType(model, "chat")),
		getAllModels,
		refreshModels:
			refreshBase || extension?.refreshModels || extension?.oauth?.modifyModels
				? async (context) => {
						await refreshBase?.(context);
						let refreshed: NonNullable<ProviderConfigInput["models"]> | undefined;
						if (extension?.refreshModels) refreshed = await extension.refreshModels(context);
						if (context.signal.aborted) return;
						const oauthCredential = context.credential?.type === "oauth" ? context.credential : undefined;
						await context.publish({
							update: () => {
								if (refreshed) {
									// Validate before publishing the new synchronous list.
									applyExtension(
										providerId,
										applyModelsJson(providerId, getAllProviderModels(base), config, extension),
										{
											...extension,
											models: refreshed,
										},
										new Set((config?.models ?? []).map((definition) => definition.id)),
									);
									refreshedExtensionModels = refreshed;
								}
								extensionOAuthCredential = oauthCredential;
							},
						});
					}
				: undefined,
		filterModels: base?.filterModels
			? (models, credential: Credential | undefined) => base.filterModels!(models, credential)
			: undefined,
		filterAllModels: base?.filterAllModels
			? (models, credential: Credential | undefined) => base.filterAllModels!(models, credential)
			: undefined,
		stream: (model, context, options) => streamWith(model, context, options, false),
		streamSimple: (model, context, options) => streamWith(model, context, options, true),
	};

	const fetchDeferred = base?.fetchDeferred;
	if (fetchDeferred) {
		provider.fetchDeferred = (model, handle, options) => fetchDeferred(model, handle, options);
	}
	const cancelDeferred = base?.cancelDeferred;
	if (cancelDeferred) {
		provider.cancelDeferred = (model, handle, options) => cancelDeferred(model, handle, options);
	}
	const extensionImages = extension?.images;
	const generateImages = base?.generateImages;
	if (generateImages || Object.keys(extensionImages ?? {}).length > 0) {
		provider.generateImages = (model, context, options) => {
			const implementation = extensionImages?.[model.api];
			if (implementation) return implementation.generateImages(model, context, options);
			if (generateImages) return generateImages(model, context, options);
			return Promise.resolve(
				imageErrorResult(model, new Error(`Provider ${providerId} has no image implementation for "${model.api}"`)),
			);
		};
	}
	const extensionClassifiers = extension?.classifiers;
	const classify = base?.classify;
	if (classify || Object.keys(extensionClassifiers ?? {}).length > 0) {
		provider.classify = (model, context, options) => {
			const implementation = extensionClassifiers?.[model.api];
			if (implementation) return implementation.classify(model, context, options);
			if (classify) return classify(model, context, options);
			return Promise.resolve(
				classifierErrorResult(
					model,
					new Error(`Provider ${providerId} has no classifier implementation for "${model.api}"`),
				),
			);
		};
	}

	return provider;
}

export function resolveConfiguredModelHeaders(
	model: AnyModel,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
	env?: Record<string, string>,
): Promise<Record<string, string> | undefined> {
	return resolveHeadersOrThrow(
		rawModelHeaders(model, config, extension),
		`model "${model.provider}/${model.id}"`,
		env,
	);
}

/**
 * Request shape a compatibility provider needs beside its credential. Headers are NOT
 * part of it: a configured header value can be a `!command`, and resolving one requires
 * a shell - see `resolveCompatibilityRequestHeaders`.
 */
export interface CompatibilityRequestConfig {
	extraBody?: Record<string, unknown>;
	upstreamModelId?: string;
	serviceTier?: "auto" | "flex" | "priority" | "ultrafast";
	authHeader: boolean;
}

/** Configured provider and model headers, resolved off the event loop. */
export async function resolveCompatibilityRequestHeaders(
	model: Model<Api>,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
	env?: Record<string, string>,
): Promise<ProviderHeaders | undefined> {
	const configured = await resolveHeadersOrThrow(
		{ ...configuredHeaders(config, extension), ...rawModelHeaders(model, config, extension) },
		`model "${model.provider}/${model.id}"`,
		env,
	);
	return model.headers || configured ? { ...model.headers, ...configured } : undefined;
}

export function resolveCompatibilityRequestConfig(
	model: Model<Api>,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): CompatibilityRequestConfig {
	const modelDefinition = config?.models?.find((entry) => entry.id === model.id);
	const extensionModel = findExtensionChatModel(extension, model.id);
	const configuredExtraBody = {
		...config?.extraBody,
		...extension?.extraBody,
		...rawModelExtraBody(model, config, extension),
	};
	return {
		extraBody: Object.keys(configuredExtraBody).length > 0 ? configuredExtraBody : undefined,
		upstreamModelId: extensionModel?.upstreamModelId ?? modelDefinition?.upstreamModelId ?? model.upstreamModelId,
		serviceTier: extensionModel?.serviceTier ?? modelDefinition?.serviceTier ?? model.serviceTier,
		authHeader: extension?.authHeader ?? config?.authHeader ?? false,
	};
}

export function configuredRequestAuthStatus(
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): AuthStatus | undefined {
	const value = configuredApiKey(config, extension);
	if (value === undefined) {
		return configuredHeaderAuthStatus(config?.headers, extension?.headers);
	}
	if (isCommandConfigValue(value)) return { configured: true, source: "models_json_command" };
	const names = getConfigValueEnvVarNames(value);
	if (names.length > 0) {
		return isConfigValueConfigured(value)
			? { configured: true, source: "environment", label: names.join(", ") }
			: { configured: false };
	}
	return { configured: true, source: extension?.apiKey !== undefined ? "fallback" : "models_json_key" };
}
