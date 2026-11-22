import { isActiveScopeWith, lookupProviderScopeRegistry } from "./provider-scope-registry.ts";
import type { AssistantImages, ImageApi, ImageModel, ImagesContext, ImagesFunction, ImagesOptions } from "./types.ts";

export type ImagesApiFunction = (
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: ImagesOptions,
) => Promise<AssistantImages>;

export interface ImagesApiProvider<TApi extends ImageApi = ImageApi, TOptions extends ImagesOptions = ImagesOptions> {
	api: TApi;
	generateImages: ImagesFunction<TOptions>;
}

export interface ImagesApiProviderInternal {
	api: ImageApi;
	generateImages: ImagesApiFunction;
}

export type RegisteredImagesApiProvider = {
	provider: ImagesApiProviderInternal;
	sourceId?: string;
};

/** Browser-neutral shape of the scope object the node-only provider-scope subpath places in the realm's registry. */
export interface ImagesProviderScopeAccess {
	state: "active" | "closed";
	imagesOverlay: Map<string, RegisteredImagesApiProvider>;
}

const imagesApiProviderRegistry = new Map<string, RegisteredImagesApiProvider>();
const builtinImagesApiProviderRegistry = new Map<string, RegisteredImagesApiProvider>();
// Strict mode this copy was given while the realm had no provider-scope instance. It stays in force for this copy
// until this copy sets it again; once an instance exists, every set goes to the instance (omo#12965).
let strictModeBeforeRegistry = false;

export function setImagesProviderScopeStrictMode(enabled: boolean): void {
	const registry = lookupProviderScopeRegistry();
	strictModeBeforeRegistry = registry === undefined && enabled;
	registry?.setImagesStrictMode(enabled);
}

function isImagesProviderScopeAccess(scope: unknown): scope is ImagesProviderScopeAccess {
	return isActiveScopeWith(scope, "imagesOverlay");
}

/**
 * The active scope any pi-ai copy in this realm entered, read structurally: a closed scope and one whose members
 * another copy shaped differently both refuse. Outside a scope, a strict mode that is not a boolean reads as on.
 */
function getActiveImagesProviderScope(): ImagesProviderScopeAccess | undefined {
	const registry = lookupProviderScopeRegistry();
	const scope: unknown = registry?.current();
	if (scope !== undefined) {
		if (!isImagesProviderScopeAccess(scope)) throw new Error("Provider scope is closed");
		return scope;
	}
	const strict = strictModeBeforeRegistry || (registry?.imagesStrictMode() ?? false) !== false;
	if (strict) throw new Error("Provider scope is required in strict mode");
	return undefined;
}

function wrapGenerateImages<TOptions extends ImagesOptions>(
	api: ImageApi,
	generateImages: ImagesFunction<TOptions>,
): ImagesApiFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return generateImages(model, context, options as TOptions);
	};
}

function createRegisteredImagesApiProvider<TApi extends ImageApi, TOptions extends ImagesOptions>(
	provider: ImagesApiProvider<TApi, TOptions>,
	sourceId?: string,
): RegisteredImagesApiProvider {
	return {
		provider: {
			api: provider.api,
			generateImages: wrapGenerateImages(provider.api, provider.generateImages),
		},
		sourceId,
	};
}

export function registerImagesApiProvider<TApi extends ImageApi, TOptions extends ImagesOptions>(
	provider: ImagesApiProvider<TApi, TOptions>,
	sourceId?: string,
): void {
	const scope = getActiveImagesProviderScope();
	const registry = scope ? scope.imagesOverlay : imagesApiProviderRegistry;
	registry.set(provider.api, createRegisteredImagesApiProvider(provider, sourceId));
}

/** Registers a builtin once, retaining its immutable identity for active scopes. */
export function registerBuiltinImagesApiProvider<TApi extends ImageApi, TOptions extends ImagesOptions>(
	provider: ImagesApiProvider<TApi, TOptions>,
): void {
	const registered = builtinImagesApiProviderRegistry.get(provider.api) ?? createRegisteredImagesApiProvider(provider);
	builtinImagesApiProviderRegistry.set(provider.api, registered);
	if (!imagesApiProviderRegistry.has(provider.api)) imagesApiProviderRegistry.set(provider.api, registered);
}

export function getImagesApiProvider(api: ImageApi): ImagesApiProviderInternal | undefined {
	const scope = getActiveImagesProviderScope();
	if (scope) return scope.imagesOverlay.get(api)?.provider ?? builtinImagesApiProviderRegistry.get(api)?.provider;
	return imagesApiProviderRegistry.get(api)?.provider;
}

export function getImagesApiProviders(): ImagesApiProviderInternal[] {
	const scope = getActiveImagesProviderScope();
	if (scope) {
		const providers = new Map(builtinImagesApiProviderRegistry);
		for (const [api, entry] of scope.imagesOverlay) providers.set(api, entry);
		return Array.from(providers.values(), (entry) => entry.provider);
	}
	return Array.from(imagesApiProviderRegistry.values(), (entry) => entry.provider);
}

export function unregisterImagesApiProviders(sourceId: string): void {
	const scope = getActiveImagesProviderScope();
	const registry = scope ? scope.imagesOverlay : imagesApiProviderRegistry;
	for (const [api, entry] of registry.entries()) {
		if (entry.sourceId === sourceId) registry.delete(api);
	}
}

export function clearImagesApiProviders(): void {
	const scope = getActiveImagesProviderScope();
	(scope ? scope.imagesOverlay : imagesApiProviderRegistry).clear();
}

export function resetImagesApiProviders(): void {
	const scope = getActiveImagesProviderScope();
	if (scope) {
		scope.imagesOverlay.clear();
		return;
	}
	imagesApiProviderRegistry.clear();
	for (const [api, entry] of builtinImagesApiProviderRegistry) imagesApiProviderRegistry.set(api, entry);
}
