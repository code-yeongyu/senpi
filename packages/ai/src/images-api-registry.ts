import type { AssistantImages, ImagesApi, ImagesContext, ImagesFunction, ImagesModel, ImagesOptions } from "./types.ts";

export type ImagesApiFunction = (
	model: ImagesModel<ImagesApi>,
	context: ImagesContext,
	options?: ImagesOptions,
) => Promise<AssistantImages>;

export interface ImagesApiProvider<TApi extends ImagesApi = ImagesApi, TOptions extends ImagesOptions = ImagesOptions> {
	api: TApi;
	generateImages: ImagesFunction<TApi, TOptions>;
}

export interface ImagesApiProviderInternal {
	api: ImagesApi;
	generateImages: ImagesApiFunction;
}

export type RegisteredImagesApiProvider = {
	provider: ImagesApiProviderInternal;
	sourceId?: string;
};

/** Browser-neutral shape installed by the node-only provider-scope subpath. */
export interface ImagesProviderScopeAccess {
	state: "active" | "closed";
	imagesOverlay: Map<string, RegisteredImagesApiProvider>;
}

const imagesApiProviderRegistry = new Map<string, RegisteredImagesApiProvider>();
const builtinImagesApiProviderRegistry = new Map<string, RegisteredImagesApiProvider>();
let getImagesProviderScope: () => ImagesProviderScopeAccess | undefined = () => undefined;
let imagesProviderScopeStrictMode = false;

/** Installs the optional node-only scope lookup without importing node APIs here. */
export function installImagesProviderScopeAccessor(accessor: () => ImagesProviderScopeAccess | undefined): void {
	getImagesProviderScope = accessor;
}

export function setImagesProviderScopeStrictMode(enabled: boolean): void {
	imagesProviderScopeStrictMode = enabled;
}

function getActiveImagesProviderScope(): ImagesProviderScopeAccess | undefined {
	const scope = getImagesProviderScope();
	if (scope?.state === "closed") throw new Error("Provider scope is closed");
	if (!scope && imagesProviderScopeStrictMode) throw new Error("Provider scope is required in strict mode");
	return scope;
}

function wrapGenerateImages<TApi extends ImagesApi, TOptions extends ImagesOptions>(
	api: TApi,
	generateImages: ImagesFunction<TApi, TOptions>,
): ImagesApiFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return generateImages(model as ImagesModel<TApi>, context, options as TOptions);
	};
}

function createRegisteredImagesApiProvider<TApi extends ImagesApi, TOptions extends ImagesOptions>(
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

export function registerImagesApiProvider<TApi extends ImagesApi, TOptions extends ImagesOptions>(
	provider: ImagesApiProvider<TApi, TOptions>,
	sourceId?: string,
): void {
	const scope = getActiveImagesProviderScope();
	const registry = scope ? scope.imagesOverlay : imagesApiProviderRegistry;
	registry.set(provider.api, createRegisteredImagesApiProvider(provider, sourceId));
}

/** Registers a builtin once, retaining its immutable identity for active scopes. */
export function registerBuiltinImagesApiProvider<TApi extends ImagesApi, TOptions extends ImagesOptions>(
	provider: ImagesApiProvider<TApi, TOptions>,
): void {
	const registered = builtinImagesApiProviderRegistry.get(provider.api) ?? createRegisteredImagesApiProvider(provider);
	builtinImagesApiProviderRegistry.set(provider.api, registered);
	if (!imagesApiProviderRegistry.has(provider.api)) imagesApiProviderRegistry.set(provider.api, registered);
}

export function getImagesApiProvider(api: ImagesApi): ImagesApiProviderInternal | undefined {
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
