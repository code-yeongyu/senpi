import { isActiveScopeWith, lookupProviderScopeRegistry } from "./provider-scope-registry.ts";
import { getRegisteredFauxProvider } from "./providers/faux.ts";
import type {
	Api,
	AssistantMessageEventStream,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TranscriptContext,
} from "./types.ts";

export type ApiStreamFunction = (
	model: Model<Api>,
	context: TranscriptContext,
	options?: StreamOptions,
) => AssistantMessageEventStream;

export type ApiStreamSimpleFunction = (
	model: Model<Api>,
	context: TranscriptContext,
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
	/** Kept by `clearApiProviders()`; removed only through `unregisterApiProviders(sourceId)`. */
	survivesClear?: boolean;
};

/** Browser-neutral shape of the scope object the node-only provider-scope subpath places in the realm's registry. */
export interface ProviderScopeAccess {
	state: "active" | "closed";
	overlay: Map<string, RegisteredApiProvider>;
}

const apiProviderRegistry = new Map<string, RegisteredApiProvider>();
const builtinApiProviderRegistry = new Map<string, RegisteredApiProvider>();
// Strict mode this copy was given while the realm had no provider-scope instance. It stays in force for this copy
// until this copy sets it again; once an instance exists, every set goes to the instance (omo#12965).
let strictModeBeforeRegistry = false;

export function setProviderScopeStrictMode(enabled: boolean): void {
	const registry = lookupProviderScopeRegistry();
	strictModeBeforeRegistry = registry === undefined && enabled;
	registry?.setStrictMode(enabled);
}

function isProviderScopeAccess(scope: unknown): scope is ProviderScopeAccess {
	return isActiveScopeWith(scope, "overlay");
}

/**
 * The active scope any pi-ai copy in this realm entered, read structurally. `"closed"` covers a closed scope and one
 * whose members another copy shaped differently: both refuse.
 */
function currentProviderScope(): ProviderScopeAccess | "closed" | undefined {
	const scope: unknown = lookupProviderScopeRegistry()?.current();
	if (scope === undefined) return undefined;
	return isProviderScopeAccess(scope) ? scope : "closed";
}

function getActiveProviderScope(): ProviderScopeAccess | undefined {
	const scope = currentProviderScope();
	if (scope === "closed") throw new Error("Provider scope is closed");
	if (scope !== undefined) return scope;
	// A strict mode that is not a boolean (a newer copy's value) reads as on.
	const strict = strictModeBeforeRegistry || (lookupProviderScopeRegistry()?.strictMode() ?? false) !== false;
	if (strict) throw new Error("Provider scope is required in strict mode");
	return undefined;
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
	survivesClear?: boolean,
): RegisteredApiProvider {
	return {
		provider: {
			api: provider.api,
			stream: wrapStream(provider.api, provider.stream),
			streamSimple: wrapStreamSimple(provider.api, provider.streamSimple),
		},
		sourceId,
		...(survivesClear ? { survivesClear } : {}),
	};
}

export function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
	provider: ApiProvider<TApi, TOptions>,
	sourceId?: string,
	options?: { survivesClear?: boolean },
): void {
	const scope = getActiveProviderScope();
	const registry = scope ? scope.overlay : apiProviderRegistry;
	registry.set(provider.api, createRegisteredProvider(provider, sourceId, options?.survivesClear));
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
	return resolveApiProvider(api, getActiveProviderScope());
}

/**
 * `getApiProvider` for the built-in registration a module runs while it evaluates: the same resolution, but it never
 * throws. Strict mode is shared by every copy in the realm, so a copy evaluated while it is on must still load
 * (omo#12965); a closed scope reads as no scope. Every runtime lookup keeps `getApiProvider`.
 */
export function getApiProviderAtEvaluation(api: Api): ApiProviderInternal | undefined {
	const scope = currentProviderScope();
	return resolveApiProvider(api, scope === "closed" ? undefined : scope);
}

function resolveApiProvider(api: Api, scope: ProviderScopeAccess | undefined): ApiProviderInternal | undefined {
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
		if (entry.sourceId !== sourceId) continue;
		registry.delete(api);
		// A scope overlay already falls back to the builtin; the global registry must get it back.
		const builtin = builtinApiProviderRegistry.get(api);
		if (!scope && builtin) registry.set(api, builtin);
	}
}

export function clearApiProviders(): void {
	const scope = getActiveProviderScope();
	const registry = scope ? scope.overlay : apiProviderRegistry;
	for (const [api, entry] of registry) {
		if (!entry.survivesClear) registry.delete(api);
	}
}
