import { dirname, join } from "node:path";
import {
	type AnyModel,
	type Api,
	type ApiStreamOptions,
	type AssistantImages,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type AuthCheck,
	type AuthInteraction,
	type AuthOperationOptions,
	type AuthResult,
	type AuthType,
	type ClassifierApi,
	type ClassifierContext,
	type ClassifierModel,
	type ClassifierOptions,
	type ClassifierResult,
	type Context,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	clampThinkingLevel,
	createModels,
	type DeferredCancelOptions,
	type DeferredFetchOptions,
	type DeferredHandle,
	getCurrentTools,
	type ImageApi,
	type ImageModel,
	type ImagesContext,
	type ImagesOptions,
	isModelType,
	type LoginOptions,
	lazyStream,
	type Message,
	type Model,
	type Models,
	type ModelsApiStreamOptions,
	type ModelsClassifierOptions,
	type ModelsDeferredCancelOptions,
	type ModelsDeferredFetchOptions,
	ModelsError,
	type ModelsImagesOptions,
	type ModelsRefreshOptions,
	type ModelsRefreshResult,
	type ModelsRequestTransforms,
	type ModelsSimpleStreamOptions,
	type ModelsStore,
	type ModelThinkingLevel,
	type ModelType,
	type ModelTypeMap,
	type MutableModels,
	normalizeContext,
	normalizeProviderId,
	type Provider,
	type ProviderHeaders,
	type ProviderRequestOptions,
	providerNotConfiguredMessage,
	type SimpleStreamOptions,
	type StreamOptions,
	setWireIdentity,
	type TranscriptContext,
	wrapStreamWithModelRecovery,
} from "@earendil-works/pi-ai";
import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";
import { installClaudeCodeVersionFileStore } from "@earendil-works/pi-ai/utils/claude-code-version-cache";
import {
	assertChatModel,
	assertClassifierModel,
	assertImageModel,
	classifierErrorResult,
	imageErrorResult,
} from "@earendil-works/pi-ai/utils/model-operations";
import { APP_NAME, BRAND, getAgentDir } from "../config.ts";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import { AuthStorage as DefaultAuthStorage } from "./auth-storage.ts";
import { envValue } from "./brand.ts";
import { discoverEnvSlots } from "./credential-pool/env-slots.ts";
import { retryOnceOnRejectedToken } from "./credential-pool/rejected-token-retry.ts";
import type { RotationSources } from "./credential-pool/rotation-stream.ts";
import { ModelConfig } from "./model-config.ts";
import { FileModelsStore, InMemoryCodingAgentModelsStore } from "./models-store.ts";
import {
	type AuthStatus,
	type CompatibilityRequestConfig,
	composeModelProvider,
	configuredRequestAuthStatus,
	type ProviderConfigInput,
	resolveCompatibilityRequestConfig,
	resolveCompatibilityRequestHeaders,
	resolveConfiguredModelHeaders,
	validateExtensionProvider,
} from "./provider-composer.ts";
import { createProviderSemaphores } from "./provider-concurrency.ts";
import { remoteCatalogServesProvider, withRemoteCatalog } from "./remote-catalog-provider.ts";
import { RuntimeCredentials } from "./runtime-credentials.ts";
import type { SettingsManager } from "./settings-manager.ts";
import {
	createVirtualModel,
	findLatestResponse,
	isVirtualModel,
	type ModelRoute,
	type ModelRouteReason,
	type VirtualModelDefinition,
	withVirtualModels,
} from "./virtual-models.ts";

// The product's identity must ride outgoing requests. This lives here because the AI package
// is already part of this module's graph; the CLI bootstrap deliberately does not import it.
setWireIdentity(BRAND?.userAgent ?? APP_NAME);

interface RegisteredVirtualModel {
	model: Model<Api>;
	route: VirtualModelDefinition["route"];
}

/** A request resolved for one provider call (auth, headers, extraBody, env, upstream model id). */
interface PreparedRequest<TModel extends AnyModel, TOptions> {
	provider: Provider;
	model: TModel;
	options: Omit<TOptions, "transformHeaders"> & ProviderRequestOptions<TModel>;
	rejectableAccess?: string;
	rejectedTokenStatuses?: readonly number[];
}

interface ModelRuntimeSnapshot {
	all: readonly Model<Api>[];
	available: readonly Model<Api>[];
	configuredProviders: ReadonlySet<string>;
	storedProviders: ReadonlySet<string>;
	auth: ReadonlyMap<string, AuthCheck | undefined>;
}

/**
 * The Claude Code version the Anthropic OAuth fingerprint advertises is cached beside
 * models.json, so every runtime on this agent directory shares one background lookup per
 * six hours. An in-memory runtime (`modelsPath: null`) keeps pi-ai's bundled floor.
 */
function installClaudeCodeVersionCache(modelsPath: string | undefined): void {
	if (modelsPath === undefined) return;
	installClaudeCodeVersionFileStore({
		path: join(dirname(modelsPath), "claude-code-version.json"),
		offline: envValue("OFFLINE") !== undefined,
	});
}

export interface CreateModelRuntimeOptions {
	settingsManager?: SettingsManager;
	/** Credential storage. Defaults to the file at authPath. */
	credentials?: CredentialStore;
	authPath?: string;
	agentDir?: string;
	modelsPath?: string | null;
	modelsStore?: ModelsStore;
	modelsStorePath?: string;
	/** Allow create() to refresh model catalogs over the network. Defaults to false. */
	allowModelNetwork?: boolean;
	/** Timeout for the create-time network model refresh. */
	modelRefreshTimeoutMs?: number;
	catalogBaseUrl?: string;
	/** Optional caller cancellation for initial cache restoration and availability checks. */
	signal?: AbortSignal;
	/** Skip initial catalog and availability refresh. Static models remain available. */
	refreshOnCreate?: boolean;
}

export interface ModelRuntimeAuthOverrides extends AuthOperationOptions {
	apiKey?: string;
	env?: Record<string, string>;
	/** Require this much remaining OAuth-token validity; defaults to five minutes. */
	minOAuthValidityMs?: number;
	/** Resolve against one named slot of a pooled credential instead of the flat projection. */
	slotName?: string;
	/** An OAuth access token the provider just refused; a stored credential still carrying it is re-exchanged. */
	rejectedAccess?: string;
}

/**
 * Stream options plus the coding-agent-only affinity key. It is declared here
 * rather than widening the engine's `StreamOptions`: a stable key (the session
 * id) keeps one conversation on one credential slot, and its absence simply
 * distributes requests instead of concentrating them.
 */
export type CredentialRotationStreamOptions = StreamOptions & ModelsRequestTransforms & { affinityKey?: string };

function mightHoldCredentialPool(
	providerId: string,
	credential: Credential | undefined,
	env: (name: string) => string | undefined,
	policySlots?: Record<string, { env?: string; value?: string }>,
): boolean {
	if (credential) {
		const accounts = Object.entries(credential).find(([key]) => key === "accounts")?.[1];
		return (Array.isArray(accounts) && accounts.length > 1) || Object.keys(policySlots ?? {}).length > 0;
	}
	return discoverEnvSlots(providerId, env).length + Object.keys(policySlots ?? {}).length > 1;
}

export type CredentialSynchronizationOperation = "login" | "logout" | "setRuntimeApiKey" | "removeRuntimeApiKey";

/** Credentials changed successfully, but the local model/auth snapshot could not be synchronized. */
export class CredentialSynchronizationError extends Error {
	readonly providerId: string;
	readonly operation: CredentialSynchronizationOperation;
	readonly credential: Credential | undefined;

	constructor(
		providerId: string,
		operation: CredentialSynchronizationOperation,
		credential: Credential | undefined,
		options: ErrorOptions,
	) {
		super(`Credential ${operation} committed for ${providerId}, but local synchronization failed`, options);
		this.name = "CredentialSynchronizationError";
		this.providerId = providerId;
		this.operation = operation;
		this.credential = credential;
	}
}

function mergeHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

function withPayloadRequestMetadata(options: StreamOptions, model: Model<Api>): StreamOptions {
	if (!options.onPayload) return options;
	const onPayload = options.onPayload;
	return {
		...options,
		onPayload: async (payload, providerModel) =>
			await onPayload(payload, providerModel, {
				model,
				headers: options.headers ?? {},
			}),
	};
}

/** Configured pi-ai Models collection used by coding-agent and SDK consumers. */
export class ModelRuntime implements Models {
	private settingsManager: SettingsManager | undefined;
	private unsubscribeProviderSettings: (() => void) | undefined;
	private readonly providerSemaphores = createProviderSemaphores(
		(providerId) => this.settingsManager?.getProviderConcurrencyLimit(providerId) ?? Infinity,
	);

	setSettingsManager(settingsManager: SettingsManager): void {
		if (this.settingsManager === settingsManager) return;
		this.unsubscribeProviderSettings?.();
		this.settingsManager = settingsManager;
		const resize = () => {
			for (const provider of this.getProviders()) {
				this.providerSemaphores.resize(provider.id, settingsManager.getProviderConcurrencyLimit(provider.id));
			}
		};
		this.unsubscribeProviderSettings = settingsManager.subscribeToProviderSettings(resize);
		resize();
	}

	private readonly models: MutableModels;
	private readonly credentials: RuntimeCredentials;
	private readonly defaultBuiltins: ReadonlyMap<string, Provider>;
	private readonly builtins = new Map<string, Provider>();
	private readonly nativeExtensionProviders = new Map<string, Provider>();
	private readonly extensionProviders = new Map<string, ProviderConfigInput>();
	/** Virtual models by provider id, then model id. */
	private readonly virtualModels = new Map<string, Map<string, RegisteredVirtualModel>>();
	private readonly compositionErrors = new Map<string, string>();
	private readonly modelsPath: string | undefined;
	private readonly modelNetworkEnabled: boolean;
	private readonly modelRefreshTimeoutMs: number;
	private config: ModelConfig;
	private snapshot: ModelRuntimeSnapshot = {
		all: [],
		available: [],
		configuredProviders: new Set(),
		storedProviders: new Set(),
		auth: new Map(),
	};
	private availabilityInitialized = false;
	private availabilityRefreshSeq = 0;
	private availabilityErrorSeq = 0;
	private readonly providerAvailabilitySeq = new Map<string, number>();
	private availabilityError: string | undefined;
	private readonly credentialOperations = new Map<string, Promise<unknown>>();
	/**
	 * The credential pool is loaded lazily and only for a provider that actually
	 * has more than one slot. Importing it eagerly would pull the pool's schema
	 * validator - and its module-level global registry - into every consumer of
	 * ModelRuntime, which the import-graph guard forbids.
	 */
	private readonly poolStatePath: string | undefined;
	private credentialPoolModules:
		| Promise<{
				rotation: typeof import("./credential-pool/rotation-stream.ts");
				repository: InstanceType<typeof import("./credential-pool/state-store.ts").CredentialSlotRepository>;
		  }>
		| undefined;
	private constructor(
		credentials: RuntimeCredentials,
		config: ModelConfig,
		modelsPath: string | undefined,
		modelsStore: ModelsStore,
		providers: readonly Provider[],
		modelNetworkEnabled: boolean,
		modelRefreshTimeoutMs: number,
		poolStatePath?: string,
	) {
		this.credentials = credentials;
		this.poolStatePath = poolStatePath;
		this.config = config;
		this.modelsPath = modelsPath;
		this.modelNetworkEnabled = modelNetworkEnabled;
		this.modelRefreshTimeoutMs = modelRefreshTimeoutMs;
		this.defaultBuiltins = new Map(providers.map((provider) => [provider.id, provider]));
		for (const [providerId, provider] of this.defaultBuiltins) this.builtins.set(providerId, provider);
		this.models = createModels({ credentials, modelsStore });
		this.rebuildProviders();
	}

	static async create(options: CreateModelRuntimeOptions = {}): Promise<ModelRuntime> {
		const credentials = new RuntimeCredentials(options.credentials ?? DefaultAuthStorage.create(options.authPath));
		const modelsPath =
			options.modelsPath === null ? undefined : (options.modelsPath ?? join(getAgentDir(), "models.json"));
		installClaudeCodeVersionCache(modelsPath);
		const config = await ModelConfig.load(modelsPath);
		const modelsStore =
			options.modelsStore ??
			(modelsPath
				? new FileModelsStore(options.modelsStorePath ?? join(dirname(modelsPath), "models-store.json"))
				: new InMemoryCodingAgentModelsStore());
		const builtinModelDataGeneratedAt = builtinProviderCatalog.getBuiltinModelDataGeneratedAt();
		const providers = builtinProviderCatalog
			.builtinProviders()
			.map((provider) =>
				provider.refreshModels || !remoteCatalogServesProvider(provider.id, options.catalogBaseUrl)
					? provider
					: withRemoteCatalog(provider, options.catalogBaseUrl, builtinModelDataGeneratedAt),
			);
		const runtime = new ModelRuntime(
			credentials,
			config,
			modelsPath,
			modelsStore,
			providers,
			envValue("OFFLINE") === undefined && options.allowModelNetwork === true,
			options.modelRefreshTimeoutMs ?? 15_000,
			options.agentDir
				? join(options.agentDir, "credential-pool-state.json")
				: options.authPath
					? join(dirname(options.authPath), "credential-pool-state.json")
					: undefined,
		);
		runtime.rebuildProviders();
		if (options.settingsManager) runtime.setSettingsManager(options.settingsManager);
		const refreshFromNetwork = runtime.modelNetworkEnabled && options.allowModelNetwork === true;
		const controller =
			refreshFromNetwork && options.modelRefreshTimeoutMs !== undefined ? new AbortController() : undefined;
		const timeout = controller ? setTimeout(() => controller.abort(), options.modelRefreshTimeoutMs) : undefined;
		const signal = controller
			? options.signal
				? AbortSignal.any([options.signal, controller.signal])
				: controller.signal
			: options.signal;
		try {
			if (options.refreshOnCreate !== false) {
				await runtime.refresh({ allowNetwork: refreshFromNetwork, signal });
			}
		} finally {
			if (timeout) clearTimeout(timeout);
		}
		return runtime;
	}

	/** Synchronous compatibility constructor for legacy ModelRegistry callers. */
	static createSync(options: CreateModelRuntimeOptions = {}): ModelRuntime {
		const credentials = new RuntimeCredentials(options.credentials ?? DefaultAuthStorage.create(options.authPath));
		const modelsPath =
			options.modelsPath === null ? undefined : (options.modelsPath ?? join(getAgentDir(), "models.json"));
		installClaudeCodeVersionCache(modelsPath);
		const config = ModelConfig.loadSync(modelsPath);
		const modelsStore =
			options.modelsStore ??
			(modelsPath
				? new FileModelsStore(options.modelsStorePath ?? join(dirname(modelsPath), "models-store.json"))
				: new InMemoryCodingAgentModelsStore());
		const providers = builtinProviderCatalog
			.builtinProviders()
			.map((provider) =>
				provider.refreshModels || !remoteCatalogServesProvider(provider.id, options.catalogBaseUrl)
					? provider
					: withRemoteCatalog(provider, options.catalogBaseUrl),
			);
		const runtime = new ModelRuntime(
			credentials,
			config,
			modelsPath,
			modelsStore,
			providers,
			options.allowModelNetwork ?? false,
			options.modelRefreshTimeoutMs ?? 15_000,
			options.agentDir
				? join(options.agentDir, "credential-pool-state.json")
				: options.authPath
					? join(dirname(options.authPath), "credential-pool-state.json")
					: undefined,
		);
		runtime.rebuildProviders();
		if (options.settingsManager) runtime.setSettingsManager(options.settingsManager);
		return runtime;
	}

	private providerIds(): Set<string> {
		return new Set([
			...this.builtins.keys(),
			...this.nativeExtensionProviders.keys(),
			...this.config.getProviderIds(),
			...this.extensionProviders.keys(),
			...this.virtualModels.keys(),
		]);
	}

	/** Returns the provider without virtual models, or undefined when only virtual models define it. */
	private recomposeProvider(rawProviderId: string): Provider | undefined {
		// Read boundary (senpi#1989): compose under the canonical id so a legacy id
		// reaching this path (an extension registration, a stored overlay key) lands
		// on the same provider instead of composing a second, empty one.
		const providerId = normalizeProviderId(rawProviderId);
		if (this.config.isProviderDisabled(providerId)) {
			this.models.deleteProvider(providerId);
			this.compositionErrors.delete(providerId);
			return undefined;
		}
		const provider = this.composeProvider(providerId);
		const virtualModels = [...(this.virtualModels.get(providerId)?.values() ?? [])].map((entry) => entry.model);
		if (virtualModels.length > 0) this.models.setProvider(withVirtualModels(providerId, provider, virtualModels));
		else if (provider) this.models.setProvider(provider);
		else this.models.deleteProvider(providerId);
		return provider;
	}

	/** The provider without virtual models, or undefined when nothing defines it. */
	private composeProvider(providerId: string): Provider | undefined {
		const base = this.nativeExtensionProviders.get(providerId) ?? this.builtins.get(providerId);
		const extension = this.extensionProviders.get(providerId);
		if (!this.config.getProvider(providerId) && !extension) {
			// No overlays: use the builtin untouched so its auth/login/stream behavior is exact.
			this.compositionErrors.delete(providerId);
			return base;
		}
		try {
			const provider = composeModelProvider(providerId, base, this.config, extension);
			this.compositionErrors.delete(providerId);
			return provider;
		} catch (error) {
			this.compositionErrors.set(providerId, error instanceof Error ? error.message : String(error));
			return base;
		}
	}

	private rebuildProviders(): void {
		this.models.clearProviders();
		this.compositionErrors.clear();
		for (const providerId of this.providerIds()) this.recomposeProvider(providerId);
		this.updateModelSnapshot();
	}

	private updateModelSnapshot(): void {
		const all = [...this.models.getModels()];
		this.snapshot = {
			...this.snapshot,
			all,
			available: all.filter((model) => this.snapshot.configuredProviders.has(model.provider)),
		};
	}

	private async runAvailabilityRefresh(seq: number, errorSeq: number, signal: AbortSignal): Promise<void> {
		const providers = this.models.getProviders();
		const [available, checks, credentials] = await Promise.all([
			this.models.getAvailable(undefined, { signal }),
			Promise.all(
				providers.map(
					async (provider): Promise<[string, AuthCheck | undefined]> => [
						provider.id,
						await this.models.checkAuth(provider.id, { signal }),
					],
				),
			),
			this.credentials.list({ signal }),
		]);
		if (seq !== this.availabilityRefreshSeq) return;
		const auth = new Map(checks);
		const configuredProviders = new Set(
			checks
				.filter((entry): entry is [string, AuthCheck] => entry[1] !== undefined)
				.map(([providerId]) => providerId),
		);
		this.snapshot = {
			all: [...this.models.getModels()],
			available: [...available],
			configuredProviders,
			storedProviders: new Set(credentials.map((entry) => entry.providerId)),
			auth,
		};
		this.availabilityInitialized = true;
		if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
	}

	private queueAvailabilityRefresh(signal?: AbortSignal): Promise<void> {
		const seq = ++this.availabilityRefreshSeq;
		for (const [providerId, providerSeq] of this.providerAvailabilitySeq) {
			this.providerAvailabilitySeq.set(providerId, providerSeq + 1);
		}
		const errorSeq = ++this.availabilityErrorSeq;
		const effectiveSignal = operationSignal(signal);
		return this.runAvailabilityRefresh(seq, errorSeq, effectiveSignal).catch((error) => {
			if (errorSeq === this.availabilityErrorSeq && !effectiveSignal.aborted) {
				this.availabilityError = error instanceof Error ? error.message : String(error);
			}
			throw error;
		});
	}

	private async refreshProviderAvailability(providerId: string, signal: AbortSignal): Promise<void> {
		// Invalidate any full availability pass that started before this credential change.
		++this.availabilityRefreshSeq;
		const providerSeq = (this.providerAvailabilitySeq.get(providerId) ?? 0) + 1;
		this.providerAvailabilitySeq.set(providerId, providerSeq);
		const errorSeq = ++this.availabilityErrorSeq;
		try {
			const [available, auth, credential] = await Promise.all([
				this.models.getAvailable(providerId, { signal }),
				this.models.checkAuth(providerId, { signal }),
				this.credentials.read(providerId, { signal }),
			]);
			signal.throwIfAborted();
			if (this.providerAvailabilitySeq.get(providerId) !== providerSeq) return;
			const configuredProviders = new Set(this.snapshot.configuredProviders);
			const storedProviders = new Set(this.snapshot.storedProviders);
			const authByProvider = new Map(this.snapshot.auth);
			if (auth) {
				configuredProviders.add(providerId);
				authByProvider.set(providerId, auth);
			} else {
				configuredProviders.delete(providerId);
				authByProvider.delete(providerId);
			}
			if (credential) storedProviders.add(providerId);
			else storedProviders.delete(providerId);
			const all = [...this.models.getModels()];
			const availableById = new Map(
				[...this.snapshot.available.filter((model) => model.provider !== providerId), ...available].map((model) => [
					`${model.provider}\0${model.id}`,
					model,
				]),
			);
			this.snapshot = {
				all,
				available: all.flatMap((model) => availableById.get(`${model.provider}\0${model.id}`) ?? []),
				configuredProviders,
				storedProviders,
				auth: authByProvider,
			};
			if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
		} catch (error) {
			if (
				this.providerAvailabilitySeq.get(providerId) === providerSeq &&
				errorSeq === this.availabilityErrorSeq &&
				!signal.aborted
			) {
				this.availabilityError = error instanceof Error ? error.message : String(error);
			}
			throw error;
		}
	}

	getProviders(): readonly Provider[] {
		return this.models.getProviders();
	}
	getProvider(providerId: string): Provider | undefined {
		return this.models.getProvider(providerId);
	}
	getModels(providerId?: string): readonly Model<Api>[] {
		return this.models.getModels(providerId);
	}
	getModel(providerId: string, modelId: string): Model<Api> | undefined {
		return this.models.getModel(providerId, modelId);
	}

	getModelsOfType<TType extends ModelType>(type: TType, providerId?: string): readonly ModelTypeMap[TType][] {
		return this.models.getModelsOfType(type, providerId);
	}

	getModelOfType<TType extends ModelType>(
		type: TType,
		providerId: string,
		modelId: string,
	): ModelTypeMap[TType] | undefined {
		return this.models.getModelOfType(type, providerId, modelId);
	}

	getAllModels(providerId?: string): readonly AnyModel[] {
		return this.models.getAllModels(providerId);
	}

	getAvailableOfType<TType extends ModelType>(
		type: TType,
		providerId?: string,
		options?: AuthOperationOptions,
	): Promise<readonly ModelTypeMap[TType][]> {
		return this.models.getAvailableOfType(type, providerId, options);
	}

	getAllAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly AnyModel[]> {
		return this.models.getAllAvailable(providerId, options);
	}

	async checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined> {
		return this.models.checkAuth(providerId, options);
	}

	async getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
		if (providerId) {
			const errorSeq = ++this.availabilityErrorSeq;
			try {
				const available = await this.models.getAvailable(providerId, options);
				if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
				return available;
			} catch (error) {
				if (errorSeq === this.availabilityErrorSeq && !options?.signal?.aborted) {
					this.availabilityError = error instanceof Error ? error.message : String(error);
				}
				throw error;
			}
		}
		await this.queueAvailabilityRefresh(options?.signal);
		return this.snapshot.available;
	}

	getAvailableSnapshot(): readonly Model<Api>[] {
		return this.snapshot.available;
	}

	/** True only when the most recent availability refresh completed without error. */
	hasFreshAvailabilitySnapshot(): boolean {
		return this.availabilityInitialized && this.availabilityError === undefined;
	}

	hasAvailabilitySnapshot(): boolean {
		return this.availabilityInitialized;
	}

	/** Non-fatal models.json notices (e.g. renamed provider ids), rendered as warnings. */
	getWarnings(): readonly string[] {
		return this.config.getWarnings();
	}

	getError(): string | undefined {
		const errors: string[] = [];
		const configError = this.config.getError();
		if (configError) errors.push(configError);
		for (const [providerId, error] of this.compositionErrors) {
			errors.push(`Provider "${providerId}": ${error}`);
		}
		if (this.availabilityError) errors.push(`Availability refresh: ${this.availabilityError}`);
		return errors.length > 0 ? errors.join("\n\n") : undefined;
	}

	getRegisteredProviderConfig(providerId: string): ProviderConfigInput | undefined {
		return this.extensionProviders.get(providerId);
	}

	getRegisteredProviderIds(): readonly string[] {
		return [...new Set([...this.extensionProviders.keys(), ...this.nativeExtensionProviders.keys()])];
	}

	getRegisteredNativeProvider(providerId: string): Provider | undefined {
		return this.nativeExtensionProviders.get(providerId);
	}

	/** @internal Compatibility fallback for ModelRegistry when provider auth is unconfigured. */
	getCompatibilityRequestConfig(model: Model<Api>): CompatibilityRequestConfig {
		return resolveCompatibilityRequestConfig(
			model,
			this.config.getProvider(model.provider),
			this.extensionProviders.get(model.provider),
		);
	}

	/** @internal Configured headers for a request the provider could not authenticate. */
	getCompatibilityRequestHeaders(
		model: Model<Api>,
		env?: Record<string, string>,
	): Promise<ProviderHeaders | undefined> {
		return resolveCompatibilityRequestHeaders(
			model,
			this.config.getProvider(model.provider),
			this.extensionProviders.get(model.provider),
			env,
		);
	}

	isUsingOAuth(providerId: string): boolean {
		return this.snapshot.auth.get(providerId)?.type === "oauth";
	}

	isUsingSubscription(providerId: string): boolean {
		return this.isUsingOAuth(providerId) && this.models.getProvider(providerId)?.auth.oauth?.isSubscription === true;
	}

	hasConfiguredAuth(providerId: string): boolean {
		return this.snapshot.configuredProviders.has(providerId);
	}

	/**
	 * Deterministic fallback-expansion gate declared by the provider's own
	 * registration. Only a definitive `false` excludes; providers without the
	 * hook, and hooks that throw, stay eligible so expansion never shrinks on
	 * uncertainty.
	 */
	isFallbackEligible(providerId: string): boolean {
		const hook = this.extensionProviders.get(providerId)?.fallbackEligible;
		if (typeof hook !== "function") return true;
		try {
			return hook() !== false;
		} catch {
			return true;
		}
	}

	getAuth(providerId: string, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	getAuth(model: AnyModel, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | AnyModel,
		overrides: ModelRuntimeAuthOverrides = {},
	): Promise<AuthResult | undefined> {
		if (typeof providerOrModel === "string") return this.models.getAuth(providerOrModel, overrides);
		const resolution = await this.models.getAuth(providerOrModel, overrides);
		if (!resolution) return undefined;
		const configuredHeaders = await resolveConfiguredModelHeaders(
			providerOrModel,
			this.config.getProvider(providerOrModel.provider),
			this.extensionProviders.get(providerOrModel.provider),
			{ ...(resolution.env ?? {}), ...(overrides.env ?? {}) },
		);
		return {
			...resolution,
			auth: {
				...resolution.auth,
				headers: mergeHeaders(resolution.auth.headers, configuredHeaders),
			},
		};
	}

	/**
	 * Auth for a request a session makes outside the rotation stream (compaction,
	 * /btw, look-at, cache keepalive). Those callers send the resolved key directly,
	 * which bypasses rotation, so it must be the account the session's own turns
	 * use: the pin, else the session's rendezvous winner among accounts the pool has
	 * not blocked, exactly as `streamWithCredentialRotation` selects. A failure of
	 * that account is reported, never answered from another account. A provider
	 * without a pool, a runtime key override, or rotation disabled by policy keeps
	 * `getAuth(model)`.
	 */
	async getSessionAuth(model: Model<Api>, sessionId: string): Promise<AuthResult | undefined> {
		const slotAuth = await this.sessionSlotAuth(model, sessionId);
		return slotAuth === undefined ? this.getAuth(model) : this.getAuth(model, slotAuth);
	}

	private async sessionSlotAuth(
		model: Model<Api>,
		sessionId: string,
	): Promise<{ apiKey?: string; slotName?: string } | undefined> {
		// The policy gates of couldRotateCredentials, read directly: its fast path consults
		// an availability snapshot that a runtime which has not refreshed yet does not hold.
		if (this.credentials.hasRuntimeApiKey(model.provider)) return undefined;
		if (this.config.getProvider(model.provider)?.credentials?.rotation === false) return undefined;
		const sources = await this.credentialRotationSources(model, undefined);
		if (!sources) return undefined;
		const { rotation } = await this.loadCredentialPool();
		const slot = rotation.selectSessionSlot(
			await rotation.listRotationSlots(sources, { acquireLeases: false }),
			sessionId,
			sources.policy?.affinity !== false,
		);
		if (!slot) return undefined;
		return slot.lane === "env" ? { apiKey: slot.envKey } : { slotName: slot.name };
	}

	private enqueueCredentialOperation<T>(providerId: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
		const previous = this.credentialOperations.get(providerId) ?? Promise.resolve();
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const operation = (async () => {
			await previous.catch(() => {});
			signal.throwIfAborted();
			markStarted?.();
			return task();
		})();
		const tail = operation.catch(() => {});
		this.credentialOperations.set(providerId, tail);
		void tail.then(() => {
			if (this.credentialOperations.get(providerId) === tail) this.credentialOperations.delete(providerId);
		});
		return raceWithAbortSignal(started, signal).then(() => operation);
	}

	private async synchronizeCredentialState(
		providerId: string,
		operation: CredentialSynchronizationOperation,
		credential: Credential | undefined,
		signal: AbortSignal,
	): Promise<void> {
		try {
			signal.throwIfAborted();
			this.recomposeProvider(providerId);
			const compositionError = this.compositionErrors.get(providerId);
			if (compositionError) throw new Error(compositionError);
			const result = await this.models.refresh({
				allowNetwork: false,
				providers: [providerId],
				signal,
			});
			if (result.aborted) signal.throwIfAborted();
			const refreshError = result.errors.get(providerId);
			if (refreshError) throw refreshError;
			this.updateModelSnapshot();
			await this.refreshProviderAvailability(providerId, signal);
		} catch (cause) {
			throw new CredentialSynchronizationError(providerId, operation, credential, { cause });
		}
	}

	setRuntimeApiKey(providerId: string, apiKey: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = operationSignal(options.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			this.credentials.setRuntimeApiKey(providerId, apiKey);
			await this.synchronizeCredentialState(
				providerId,
				"setRuntimeApiKey",
				{ type: "api_key", key: apiKey },
				signal,
			);
		});
	}

	removeRuntimeApiKey(providerId: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = operationSignal(options.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			this.credentials.removeRuntimeApiKey(providerId);
			await this.synchronizeCredentialState(providerId, "removeRuntimeApiKey", undefined, signal);
		});
	}

	listCredentials(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		return this.credentials.list(options);
	}

	getProviderAuthStatus(providerId: string): AuthStatus {
		if (this.credentials.hasRuntimeApiKey(providerId)) return { configured: true, source: "runtime" };
		if (this.snapshot.storedProviders.has(providerId)) return { configured: true, source: "stored" };
		const configured = configuredRequestAuthStatus(
			this.config.getProvider(providerId),
			this.extensionProviders.get(providerId),
		);
		if (configured) return configured;
		const check = this.snapshot.auth.get(providerId);
		if (!check) return { configured: false };
		return {
			configured: true,
			source: "environment",
			label: check.source,
			...(check.ambient ? { ambient: true } : {}),
		};
	}

	private async prepareRequest<
		TModel extends AnyModel,
		TOptions extends ProviderRequestOptions<TModel> & ModelsRequestTransforms,
	>(
		model: TModel,
		options: TOptions | undefined,
		slotAuth?: { apiKey?: string; slotName?: string; rejectedAccess?: string },
	): Promise<PreparedRequest<TModel, TOptions>> {
		const provider = this.models.getProvider(model.provider);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		const resolution = await this.getAuth(model, {
			apiKey: slotAuth?.apiKey ?? options?.apiKey,
			env: options?.env,
			signal: options?.signal,
			...(slotAuth?.slotName === undefined ? {} : { slotName: slotAuth.slotName }),
			...(slotAuth?.rejectedAccess === undefined ? {} : { rejectedAccess: slotAuth.rejectedAccess }),
		});
		if (!resolution) throw new ModelsError("auth", providerNotConfiguredMessage(model.provider));

		const { transformHeaders, ...rawProviderOptions } = options ?? {};
		const providerOptions = rawProviderOptions as Omit<TOptions, "transformHeaders"> &
			ProviderRequestOptions<TModel> & { extraBody?: Record<string, unknown> };
		let headers = mergeHeaders(resolution.auth.headers, providerOptions.headers);
		if (transformHeaders) headers = await transformHeaders(headers ?? {});
		// Configured compatibility (extraBody, upstream model id) applies to chat models only.
		const compatibility: Partial<CompatibilityRequestConfig> = isModelType(model, "chat")
			? this.getCompatibilityRequestConfig(model)
			: {};
		const extraBody =
			compatibility.extraBody || providerOptions.extraBody
				? { ...compatibility.extraBody, ...providerOptions.extraBody }
				: undefined;
		const env =
			resolution.env || providerOptions.env
				? { ...(resolution.env ?? {}), ...(providerOptions.env ?? {}) }
				: undefined;
		const upstreamModelId = compatibility.upstreamModelId;
		const requestModel: TModel =
			resolution.auth.baseUrl || upstreamModelId
				? {
						...model,
						...(upstreamModelId ? { id: upstreamModelId } : {}),
						...(resolution.auth.baseUrl ? { baseUrl: resolution.auth.baseUrl } : {}),
					}
				: model;
		const rejectedTokenStatuses = provider.auth.oauth?.rejectedTokenStatuses;
		const storedOAuthAccess =
			resolution.source === "OAuth" && (slotAuth?.apiKey ?? providerOptions.apiKey) === undefined
				? resolution.auth.apiKey
				: undefined;
		return {
			...(rejectedTokenStatuses !== undefined && storedOAuthAccess !== undefined
				? { rejectableAccess: storedOAuthAccess, rejectedTokenStatuses }
				: {}),
			provider,
			model: requestModel,
			options: {
				...providerOptions,
				apiKey: slotAuth?.apiKey ?? providerOptions.apiKey ?? resolution.auth.apiKey,
				headers,
				extraBody,
				env,
			} as Omit<TOptions, "transformHeaders"> & ProviderRequestOptions<TModel>,
		};
	}

	/**
	 * Rotation engages only for a provider that actually holds more than one
	 * credential slot and only when nothing pins the request to one credential
	 * (a runtime key or an explicit per-request apiKey). Every single-credential
	 * user therefore keeps byte-identical request behavior.
	 */
	private loadCredentialPool(): NonNullable<typeof this.credentialPoolModules> {
		this.credentialPoolModules ??= (async () => {
			const [rotation, stateStore] = await Promise.all([
				import("./credential-pool/rotation-stream.ts"),
				import("./credential-pool/state-store.ts"),
			]);
			return {
				rotation,
				repository: new stateStore.CredentialSlotRepository(this.poolStatePath),
			};
		})();
		return this.credentialPoolModules;
	}

	/**
	 * Fully synchronous admission check. A provider that cannot possibly hold a
	 * pool must not even reach the async rotation path: awaiting an async method
	 * costs a microtask hop, which would reorder an ordinary request's provider
	 * call relative to the untouched `streamSimple` path.
	 */
	private couldRotateCredentials(model: Model<Api>, options: CredentialRotationStreamOptions | undefined): boolean {
		if (options?.apiKey !== undefined) return false;
		if (this.credentials.hasRuntimeApiKey(model.provider)) return false;
		if (this.config.getProvider(model.provider)?.credentials?.rotation === false) return false;
		const env = (name: string) => options?.env?.[name] ?? process.env[name];
		if (this.snapshot.storedProviders.has(model.provider)) return true;
		const policySlots = this.config.getProvider(model.provider)?.credentials?.slots;
		return discoverEnvSlots(model.provider, env).length + Object.keys(policySlots ?? {}).length > 1;
	}

	private async credentialRotationSources(
		model: Model<Api>,
		options: CredentialRotationStreamOptions | undefined,
	): Promise<RotationSources | undefined> {
		const env = (name: string) => options?.env?.[name] ?? process.env[name];
		const credential = await this.credentials.read(model.provider, {
			signal: options?.signal,
		});
		const policy = this.config.getProvider(model.provider)?.credentials;
		if (!mightHoldCredentialPool(model.provider, credential, env, policy?.slots)) return undefined;
		const pool = await this.loadCredentialPool();
		const sources: RotationSources = {
			providerId: model.provider,
			credential,
			env,
			repository: pool.repository,
			policy,
		};
		const slots = await pool.rotation.listRotationSlots(sources, { acquireLeases: false });
		return slots.length > 1 ? sources : undefined;
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		const transcript = normalizeContext(context);
		return lazyStream(model, async () => {
			assertChatModel(model);
			const streamOptions = options as CredentialRotationStreamOptions | undefined;
			const sources = this.couldRotateCredentials(model, streamOptions)
				? await this.credentialRotationSources(model, streamOptions)
				: undefined;
			if (sources) {
				const { rotation } = await this.loadCredentialPool();
				return rotation.streamWithCredentialRotation({
					sources,
					...(streamOptions?.affinityKey !== undefined
						? { affinityKey: streamOptions.affinityKey }
						: streamOptions?.sessionId !== undefined
							? { affinityKey: streamOptions.sessionId }
							: {}),
					runAttempt: (slot) =>
						this.attemptWithTokenRecovery(
							model,
							streamOptions,
							slot.lane === "env"
								? {
										...(slot.envKey === undefined ? {} : { apiKey: slot.envKey }),
									}
								: { slotName: slot.name },
							(prepared) =>
								prepared.provider.stream(
									prepared.model as Model<TApi>,
									transcript,
									withPayloadRequestMetadata(prepared.options, prepared.model) as ApiStreamOptions<TApi>,
								),
							transcript,
						),
				});
			}
			return this.attemptWithTokenRecovery(
				model,
				streamOptions,
				undefined,
				(prepared) =>
					prepared.provider.stream(
						prepared.model as Model<TApi>,
						transcript,
						withPayloadRequestMetadata(prepared.options, prepared.model) as ApiStreamOptions<TApi>,
					),
				transcript,
			);
		});
	}

	/**
	 * One provider request with the #2297 recovery: a stored OAuth token the provider
	 * refuses before any output is re-exchanged once and the request re-sent.
	 */
	private attemptWithTokenRecovery<TOptions extends ProviderRequestOptions & ModelsRequestTransforms>(
		model: Model<Api>,
		options: TOptions | undefined,
		slotAuth: { apiKey?: string; slotName?: string } | undefined,
		send: (prepared: PreparedRequest<Model<Api>, TOptions>) => AssistantMessageEventStream,
		transcript: TranscriptContext,
	): Promise<AsyncIterable<AssistantMessageEvent>> {
		return retryOnceOnRejectedToken(async (rejectedAccess) => {
			const prepared = await this.prepareRequest(
				model,
				options,
				rejectedAccess === undefined ? slotAuth : { ...slotAuth, rejectedAccess },
			);
			const inner = await this.providerSemaphores.bracket(prepared.model.provider, prepared.options.signal, () =>
				send(prepared),
			);
			return {
				stream: wrapStreamWithModelRecovery(inner, model, getCurrentTools(transcript.messages)),
				...(prepared.rejectableAccess === undefined ? {} : { rejectableAccess: prepared.rejectableAccess }),
				...(prepared.rejectedTokenStatuses === undefined
					? {}
					: { rejectedTokenStatuses: prepared.rejectedTokenStatuses }),
			};
		});
	}
	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		const transcript = normalizeContext(context);
		if (isVirtualModel(model)) {
			// Requests outside the agent loop are routed here. Callers sized them before routing, so
			// cap the output budget to the routed model.
			return lazyStream(model, async () => {
				const route = await this.resolveModel(model, transcript.messages, {
					reason: "direct",
					thinkingLevel: options?.reasoning ?? "off",
					signal: options?.signal,
				});
				const { maxTokens: limit } = route.model;
				const maxTokens = options?.maxTokens && limit > 0 ? Math.min(options.maxTokens, limit) : options?.maxTokens;
				const reasoning = route.thinkingLevel === "off" ? undefined : route.thinkingLevel;
				// Caller credentials were resolved for the virtual model's provider. Another provider
				// resolves its own, so they are not sent to the wrong vendor.
				const { apiKey, headers, env, ...rest } = options ?? {};
				const auth = route.model.provider === model.provider ? { apiKey, headers, env } : {};
				return this.streamSimple(route.model, context, { ...rest, ...auth, maxTokens, reasoning });
			});
		}
		return lazyStream(model, async () => {
			assertChatModel(model);
			const streamOptions = options as CredentialRotationStreamOptions | undefined;
			const sources = this.couldRotateCredentials(model, streamOptions)
				? await this.credentialRotationSources(model, streamOptions)
				: undefined;
			if (sources) {
				const { rotation } = await this.loadCredentialPool();
				return rotation.streamWithCredentialRotation({
					sources,
					...(streamOptions?.sessionId === undefined ? {} : { affinityKey: streamOptions.sessionId }),
					runAttempt: (slot) =>
						this.attemptWithTokenRecovery(
							model,
							streamOptions,
							slot.lane === "env" ? { apiKey: slot.envKey } : { slotName: slot.name },
							(prepared) =>
								prepared.provider.streamSimple(
									prepared.model,
									transcript,
									withPayloadRequestMetadata(prepared.options, prepared.model) as SimpleStreamOptions,
								),
							transcript,
						),
				});
			}
			return this.attemptWithTokenRecovery(
				model,
				options,
				undefined,
				(prepared) =>
					prepared.provider.streamSimple(
						prepared.model,
						transcript,
						withPayloadRequestMetadata(prepared.options, prepared.model) as SimpleStreamOptions,
					),
				transcript,
			);
		});
	}
	/**
	 * Resolve auth, headers, `extraBody`, env, and the upstream model id exactly as a
	 * single-credential `streamSimple` request does, without sending it. The session-start
	 * prompt-cache prewarm (senpi#2096) builds its request from this so its prefix matches
	 * the first turn's.
	 */
	async prepareSimpleRequest(
		model: Model<Api>,
		options?: ModelsSimpleStreamOptions,
	): Promise<{ model: Model<Api>; options: SimpleStreamOptions }> {
		const prepared = await this.prepareRequest(model, options);
		return {
			model: prepared.model,
			options: withPayloadRequestMetadata(prepared.options, prepared.model) as SimpleStreamOptions,
		};
	}
	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}

	streamDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			assertChatModel(model);
			const prepared = await this.prepareRequest(model, options);
			if (!prepared.provider.fetchDeferred) {
				throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
			}
			return prepared.provider.fetchDeferred(prepared.model, handle, prepared.options as DeferredFetchOptions);
		});
	}

	async fetchDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): Promise<AssistantMessage> {
		return this.streamDeferred(model, handle, options).result();
	}

	async cancelDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredCancelOptions,
	): Promise<void> {
		assertChatModel(model);
		const prepared = await this.prepareRequest(model, options);
		if (!prepared.provider.cancelDeferred) {
			throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
		}
		await prepared.provider.cancelDeferred(prepared.model, handle, prepared.options as DeferredCancelOptions);
	}

	async generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ModelsImagesOptions,
	): Promise<AssistantImages> {
		try {
			assertImageModel(model);
			const prepared = await this.prepareRequest(model, options);
			if (!prepared.provider.generateImages) {
				throw new ModelsError("provider", `Provider ${model.provider} does not support image generation`);
			}
			return await prepared.provider.generateImages(prepared.model, context, prepared.options as ImagesOptions);
		} catch (error) {
			return imageErrorResult(model, error, options?.signal?.aborted);
		}
	}

	async classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	): Promise<ClassifierResult> {
		try {
			assertClassifierModel(model);
			const prepared = await this.prepareRequest(model, options);
			if (!prepared.provider.classify) {
				throw new ModelsError("provider", `Provider ${model.provider} does not support classification`);
			}
			return await prepared.provider.classify(prepared.model, context, prepared.options as ClassifierOptions);
		} catch (error) {
			return classifierErrorResult(model, error, options?.signal?.aborted);
		}
	}

	login(
		providerId: string,
		type: AuthType,
		interaction: AuthInteraction,
		options?: LoginOptions,
	): Promise<Credential> {
		const signal = operationSignal(interaction.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			const credential = await this.models.login(providerId, type, { ...interaction, signal }, options);
			await this.synchronizeCredentialState(providerId, "login", credential, signal);
			return credential;
		});
	}

	logout(providerId: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = operationSignal(options.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			await this.models.logout(providerId, { signal });
			await this.synchronizeCredentialState(providerId, "logout", undefined, signal);
		});
	}

	async reloadConfig(): Promise<void> {
		await this.refresh({ allowNetwork: this.modelNetworkEnabled });
	}

	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		this.config = await ModelConfig.load(this.modelsPath);
		if (options.providers) {
			for (const providerId of new Set(options.providers)) this.recomposeProvider(providerId);
			this.updateModelSnapshot();
		} else {
			this.rebuildProviders();
		}
		const refreshOptions = {
			...options,
			allowNetwork: options.allowNetwork ?? this.modelNetworkEnabled,
		};
		// Published pi-ai builds before ModelsStore returned void and accepted a provider ID.
		// The fallback keeps source-mode CLI tests working without rebuilding workspace dependencies.
		const result = ((await this.models.refresh(refreshOptions)) as ModelsRefreshResult | undefined) ?? {
			aborted: refreshOptions.signal?.aborted ?? false,
			errors: new Map(),
		};
		const errors = new Map(result.errors);
		this.updateModelSnapshot();
		if (options.providers) {
			await Promise.all(
				[...new Set(options.providers)].map(async (providerId) => {
					try {
						await this.refreshProviderAvailability(providerId, operationSignal(options.signal));
					} catch (error) {
						if (!options.signal?.aborted) {
							errors.set(providerId, error instanceof Error ? error : new Error(String(error)));
						}
					}
				}),
			);
		} else {
			try {
				await this.queueAvailabilityRefresh(options.signal);
			} catch {
				// Availability errors are recorded by the latest pass; refreshed models remain usable.
			}
		}
		return {
			aborted: result.aborted || (options.signal?.aborted ?? false),
			errors,
		};
	}

	/**
	 * Providers registered after startup missed the create() refresh. Load their catalogs
	 * under the runtime network policy, bounded like startup, so newly registered models are
	 * usable without a manual refresh. Offline policy restores from the store only and never
	 * touches the network.
	 */
	private shouldSkipRegistrationRefresh(providerId: string): boolean {
		return (
			this.hasFreshAvailabilitySnapshot() &&
			(this.nativeExtensionProviders.has(providerId) || this.extensionProviders.has(providerId))
		);
	}

	private refreshAfterRegistration(): Promise<ModelsRefreshResult> {
		if (!this.modelNetworkEnabled) return this.refresh({ allowNetwork: false });
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.modelRefreshTimeoutMs);
		return this.refresh({
			allowNetwork: true,
			signal: controller.signal,
		}).finally(() => clearTimeout(timeout));
	}

	registerNativeProvider(provider: Provider, options?: { refresh?: boolean }): Promise<ModelsRefreshResult> {
		if (!provider.id.trim()) throw new Error("Provider id must not be empty.");
		const alreadyFresh = this.shouldSkipRegistrationRefresh(provider.id);
		this.extensionProviders.delete(provider.id);
		this.nativeExtensionProviders.set(provider.id, provider);
		this.recomposeProvider(provider.id);
		const composedOAuth = this.models.getProvider(provider.id)?.auth.oauth;
		if (composedOAuth) this.credentials.registerOAuthProvider(provider.id, composedOAuth);
		else this.credentials.unregisterOAuthProvider(provider.id);
		this.updateModelSnapshot();
		if (alreadyFresh || options?.refresh === false) {
			return Promise.resolve({ aborted: false, errors: new Map() });
		}
		return this.refreshAfterRegistration();
	}

	registerProvider(
		providerId: string,
		config: ProviderConfigInput,
		options?: { refresh?: boolean },
	): Promise<ModelsRefreshResult> {
		// Validate the incoming registration on its own, like the legacy registry:
		// a broken re-registration must throw without touching the stored config.
		validateExtensionProvider(providerId, this.builtins.get(providerId), this.config.getProvider(providerId), config);
		const alreadyFresh = this.shouldSkipRegistrationRefresh(providerId);
		this.nativeExtensionProviders.delete(providerId);
		// Re-registration merges defined values over the previous registration and
		// preserves undefined ones, matching the legacy ModelRegistry contract.
		const previous = this.extensionProviders.get(providerId);
		const effective: ProviderConfigInput = { ...previous };
		for (const [key, value] of Object.entries(config)) {
			if (value !== undefined) (effective as Record<string, unknown>)[key] = value;
		}
		this.extensionProviders.set(providerId, effective);
		this.recomposeProvider(providerId);
		const composedOAuth = this.models.getProvider(providerId)?.auth.oauth;
		if (composedOAuth) this.credentials.registerOAuthProvider(providerId, composedOAuth);
		else this.credentials.unregisterOAuthProvider(providerId);
		this.updateModelSnapshot();
		if (
			this.snapshot.storedProviders.has(providerId) ||
			configuredRequestAuthStatus(this.config.getProvider(providerId), effective)?.configured
		) {
			const configuredProviders = new Set(this.snapshot.configuredProviders).add(providerId);
			const auth = new Map(this.snapshot.auth);
			// Provisional entry until the async refresh lands; never clobber a real check result.
			if (!auth.get(providerId)) {
				auth.set(providerId, {
					type: effective.oauth && !effective.apiKey ? "oauth" : "api_key",
					source: "configured provider",
				});
			}
			this.snapshot = {
				...this.snapshot,
				auth,
				configuredProviders,
				available: this.snapshot.all.filter((model) => configuredProviders.has(model.provider)),
			};
		}
		if (alreadyFresh || options?.refresh === false) {
			return Promise.resolve({ aborted: false, errors: new Map() });
		}
		return this.refreshAfterRegistration();
	}

	unregisterProvider(providerId: string): void {
		this.extensionProviders.delete(providerId);
		this.nativeExtensionProviders.delete(providerId);
		this.recomposeProvider(providerId);
		this.credentials.unregisterOAuthProvider(providerId);
		this.updateModelSnapshot();
		void this.refresh({ allowNetwork: false });
	}

	/**
	 * Register a virtual model under `definition.provider`, which may also list physical models or
	 * several virtual models. Re-registering the same provider and id replaces the virtual model.
	 * Throws when the id belongs to a physical model of that provider.
	 */
	registerVirtualModel(definition: VirtualModelDefinition): void {
		const { provider: providerId, id } = definition;
		if (!providerId.trim() || !id.trim()) throw new Error("Virtual model provider and id must not be empty.");
		const existing = this.models.getModel(providerId, id);
		if (existing && !isVirtualModel(existing)) {
			throw new Error(`Virtual model ${providerId}/${id} conflicts with a physical model.`);
		}
		const models = this.virtualModels.get(providerId) ?? new Map<string, RegisteredVirtualModel>();
		models.set(id, { model: createVirtualModel(definition), route: (request) => definition.route(request) });
		this.virtualModels.set(providerId, models);
		if (!this.recomposeProvider(providerId) && !this.snapshot.configuredProviders.has(providerId)) {
			// A provider of only virtual models needs no credentials. Mark it configured now: session
			// restore checks auth before the refresh below lands.
			const auth = new Map(this.snapshot.auth).set(providerId, { type: "api_key", source: "virtual" });
			const configuredProviders = new Set(this.snapshot.configuredProviders).add(providerId);
			this.snapshot = { ...this.snapshot, auth, configuredProviders };
		}
		this.updateModelSnapshot();
		void this.refresh({ allowNetwork: false });
	}

	unregisterVirtualModel(providerId: string, id: string): void {
		const models = this.virtualModels.get(providerId);
		if (!models?.delete(id)) return;
		if (models.size === 0) this.virtualModels.delete(providerId);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot();
		void this.refresh({ allowNetwork: false });
	}

	/**
	 * Ask a virtual model's router for the model and thinking level of one request. The router must
	 * return a physical catalog model whose provider has credentials; the thinking level is clamped
	 * to that model. Throws when routing fails.
	 *
	 * `previous` reports the latest successful response in `messages`. A retry passes the failed
	 * response as `options.failed`; `messages` no longer contains it. `options.state` is the router
	 * state stored by the caller, which also stores the returned state.
	 */
	async resolveModel(
		model: Model<Api>,
		messages: readonly Message[],
		options: {
			reason: ModelRouteReason;
			thinkingLevel: ModelThinkingLevel;
			signal?: AbortSignal;
			failed?: AssistantMessage;
			state?: unknown;
		},
	): Promise<ModelRoute> {
		const name = `Virtual model ${model.provider}/${model.id}`;
		const virtual = this.virtualModels.get(model.provider)?.get(model.id);
		if (!virtual) throw new Error(`${name} is not registered.`);
		const { failed, ...request } = options;
		const latest = findLatestResponse(messages);
		const previousModel = latest && this.getPhysicalModel(latest.provider, latest.model);
		// A failed routing attempt names the virtual model; there is no physical request to report.
		const failedModel = failed && this.getPhysicalModel(failed.provider, failed.model);
		const route = await virtual.route({
			...request,
			model,
			previous: previousModel && { model: previousModel, thinkingLevel: latest?.thinkingLevel },
			failed: failedModel && failed && { model: failedModel, thinkingLevel: failed.thinkingLevel, message: failed },
			messages,
		});
		const target = this.getPhysicalModel(route.model.provider, route.model.id);
		const routed = `${name} routed to ${route.model.provider}/${route.model.id}`;
		if (!target) throw new Error(`${routed}, which is not a physical model.`);
		if (!this.hasConfiguredAuth(target.provider)) throw new Error(`${routed}, which has no credentials.`);
		return { model: target, thinkingLevel: clampThinkingLevel(target, route.thinkingLevel), state: route.state };
	}

	/** A catalog chat model that is not virtual. */
	getPhysicalModel(providerId: string, modelId: string): Model<Api> | undefined {
		const model = this.models.getModel(providerId, modelId);
		return model && !isVirtualModel(model) ? model : undefined;
	}
}
