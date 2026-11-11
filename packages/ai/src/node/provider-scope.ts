import { AsyncLocalStorage } from "node:async_hooks";
import { realmRegistry } from "@earendil-works/pi-realm-registry";
import {
	type ProviderScopeAccess,
	setProviderScopeStrictMode as setRegistryProviderScopeStrictMode,
} from "../api-registry.ts";
import { type ImagesProviderScopeAccess, setImagesProviderScopeStrictMode } from "../images-api-registry.ts";
import {
	isActiveScopeWith,
	isProviderScopeRegistry,
	PROVIDER_SCOPE_REGISTRY_KEY,
	type ProviderScopeRegistry,
} from "../provider-scope-registry.ts";

// The one place that creates the realm's provider-scope instance (omo#12965): the storage and both strict modes live
// in this closure, and every pi-ai copy in the realm reads them through the instance.
const providerScopes = realmRegistry(
	PROVIDER_SCOPE_REGISTRY_KEY,
	(): ProviderScopeRegistry => {
		const storage = new AsyncLocalStorage<object>();
		let strict: unknown = false;
		let imagesStrict: unknown = false;
		return {
			strictMode: () => strict,
			setStrictMode: (enabled) => {
				strict = enabled;
			},
			imagesStrictMode: () => imagesStrict,
			setImagesStrictMode: (enabled) => {
				imagesStrict = enabled;
			},
			run: (scope, fn) => storage.run(scope, fn),
			current: () => storage.getStore(),
		};
	},
	isProviderScopeRegistry,
);

export class ProviderScope implements ProviderScopeAccess, ImagesProviderScopeAccess {
	readonly overlay = new Map();
	readonly imagesOverlay = new Map();
	state: "active" | "closed" = "active";

	close(): void {
		this.state = "closed";
		this.overlay.clear();
		this.imagesOverlay.clear();
	}
}

/** A scope object any pi-ai copy in this realm entered: the same members, whichever copy's class built it. */
function isProviderScope(scope: unknown): scope is ProviderScope {
	if (typeof scope !== "object" || scope === null) return false;
	const state: unknown = Reflect.get(scope, "state");
	return (
		(state === "active" || state === "closed") &&
		Reflect.get(scope, "overlay") instanceof Map &&
		Reflect.get(scope, "imagesOverlay") instanceof Map &&
		typeof Reflect.get(scope, "close") === "function"
	);
}

export function setProviderScopeStrictMode(enabled: boolean): void {
	setRegistryProviderScopeStrictMode(enabled);
	setImagesProviderScopeStrictMode(enabled);
}

/** The scope the caller is running in, or undefined outside any scope. */
export function activeProviderScope(): ProviderScope | undefined {
	const scope: unknown = providerScopes.current();
	return isProviderScope(scope) ? scope : undefined;
}

export function runWithProviderScope<T>(scope: ProviderScope, fn: () => T): T {
	if (scope.state === "closed") throw new Error("Provider scope is closed");
	return providerScopes.run(scope, fn);
}

export function bindToProviderScope<TArgs extends unknown[], TResult>(
	fn: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
	const scope: unknown = providerScopes.current();
	if (typeof scope !== "object" || scope === null) throw new Error("No active provider scope to bind");
	return (...args) => {
		// A scope another copy shaped differently refuses, as a closed one does.
		if (!isActiveScopeWith(scope, "overlay")) throw new Error("Provider scope is closed");
		return providerScopes.run(scope, () => fn(...args));
	};
}
