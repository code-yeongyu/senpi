import { getRegisteredFauxProvider } from "./providers/faux.ts";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "./types.ts";

export type ApiStreamFunction = (
	model: Model<Api>,
	context: Context,
	options?: StreamOptions,
) => AssistantMessageEventStream;

export type ApiStreamSimpleFunction = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface ApiProvider<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> {
	api: TApi;
	stream: StreamFunction<TApi, TOptions>;
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}

export interface ApiProviderInternal {
	api: Api;
	stream: ApiStreamFunction;
	streamSimple: ApiStreamSimpleFunction;
}

export type RegisteredApiProvider = {
	provider: ApiProviderInternal;
	sourceId?: string;
};

/** Browser-neutral shape installed by the node-only provider-scope subpath. */
export interface ProviderScopeAccess {
	state: "active" | "closed";
	overlay: Map<string, RegisteredApiProvider>;
}

const apiProviderRegistry = new Map<string, RegisteredApiProvider>();
const builtinApiProviderRegistry = new Map<string, RegisteredApiProvider>();
let getProviderScope: () => ProviderScopeAccess | undefined = () => undefined;
let providerScopeStrictMode = false;

/** Installs the optional node-only scope lookup without importing node APIs here. */
export function installProviderScopeAccessor(accessor: () => ProviderScopeAccess | undefined): void {
	getProviderScope = accessor;
}

export function setProviderScopeStrictMode(enabled: boolean): void {
	providerScopeStrictMode = enabled;
}

function getActiveProviderScope(): ProviderScopeAccess | undefined {
	const scope = getProviderScope();
	if (scope?.state === "closed") throw new Error("Provider scope is closed");
	if (!scope && providerScopeStrictMode) throw new Error("Provider scope is required in strict mode");
	return scope;
}

function wrapStream<TApi extends Api, TOptions extends StreamOptions>(
	api: TApi,
	stream: StreamFunction<TApi, TOptions>,
): ApiStreamFunction {
	return (model, context, options) => {
		if (model.api !== api) throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		return stream(model as Model<TApi>, context, options as TOptions);
	};
}

function wrapStreamSimple<TApi extends Api>(
	api: TApi,
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>,
): ApiStreamSimpleFunction {
	return (model, context, options) => {
		if (model.api !== api) throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		return streamSimple(model as Model<TApi>, context, options);
	};
}

function createRegisteredProvider<TApi extends Api, TOptions extends StreamOptions>(
	provider: ApiProvider<TApi, TOptions>,
	sourceId?: string,
): RegisteredApiProvider {
	return {
		provider: {
			api: provider.api,
			stream: wrapStream(provider.api, provider.stream),
			streamSimple: wrapStreamSimple(provider.api, provider.streamSimple),
		},
		sourceId,
	};
}

export function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
	provider: ApiProvider<TApi, TOptions>,
	sourceId?: string,
): void {
	const scope = getActiveProviderScope();
	const registry = scope ? scope.overlay : apiProviderRegistry;
	registry.set(provider.api, createRegisteredProvider(provider, sourceId));
}

/** Registers a builtin once, retaining its immutable identity for active scopes. */
export function registerBuiltinApiProvider<TApi extends Api, TOptions extends StreamOptions>(
	provider: ApiProvider<TApi, TOptions>,
): void {
	const registered = builtinApiProviderRegistry.get(provider.api) ?? createRegisteredProvider(provider);
	builtinApiProviderRegistry.set(provider.api, registered);
	if (!apiProviderRegistry.has(provider.api)) apiProviderRegistry.set(provider.api, registered);
}

export function getBuiltinApiProvider(api: Api): ApiProviderInternal | undefined {
	return builtinApiProviderRegistry.get(api)?.provider;
}

export function getApiProvider(api: Api): ApiProviderInternal | undefined {
	const scope = getActiveProviderScope();
	if (scope) return scope.overlay.get(api)?.provider ?? builtinApiProviderRegistry.get(api)?.provider;

	const faux = getRegisteredFauxProvider(api);
	if (faux) {
		return {
			api: faux.api,
			stream: wrapStream(faux.api, faux.stream),
			streamSimple: wrapStreamSimple(faux.api, faux.streamSimple),
		};
	}
	return apiProviderRegistry.get(api)?.provider;
}

export function getApiProviders(): ApiProviderInternal[] {
	const scope = getActiveProviderScope();
	if (scope) {
		const providers = new Map(builtinApiProviderRegistry);
		for (const [api, entry] of scope.overlay) providers.set(api, entry);
		return Array.from(providers.values(), (entry) => entry.provider);
	}
	return Array.from(apiProviderRegistry.values(), (entry) => entry.provider);
}

export function unregisterApiProviders(sourceId: string): void {
	const scope = getActiveProviderScope();
	const registry = scope ? scope.overlay : apiProviderRegistry;
	for (const [api, entry] of registry.entries()) {
		if (entry.sourceId === sourceId) registry.delete(api);
	}
}

export function clearApiProviders(): void {
	const scope = getActiveProviderScope();
	(scope ? scope.overlay : apiProviderRegistry).clear();
}
