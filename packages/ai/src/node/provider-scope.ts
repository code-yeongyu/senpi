import { AsyncLocalStorage } from "node:async_hooks";
import {
	installProviderScopeAccessor,
	type ProviderScopeAccess,
	setProviderScopeStrictMode as setRegistryProviderScopeStrictMode,
} from "../api-registry.ts";
import {
	type ImagesProviderScopeAccess,
	installImagesProviderScopeAccessor,
	setImagesProviderScopeStrictMode,
} from "../images-api-registry.ts";

const providerScopeStorage = new AsyncLocalStorage<ProviderScope>();

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

installProviderScopeAccessor(() => providerScopeStorage.getStore());
installImagesProviderScopeAccessor(() => providerScopeStorage.getStore());

export function setProviderScopeStrictMode(enabled: boolean): void {
	setRegistryProviderScopeStrictMode(enabled);
	setImagesProviderScopeStrictMode(enabled);
}

export function runWithProviderScope<T>(scope: ProviderScope, fn: () => T): T {
	if (scope.state === "closed") throw new Error("Provider scope is closed");
	return providerScopeStorage.run(scope, fn);
}

export function bindToProviderScope<TArgs extends unknown[], TResult>(
	fn: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
	const scope = providerScopeStorage.getStore();
	if (!scope) throw new Error("No active provider scope to bind");
	return (...args) => runWithProviderScope(scope, () => fn(...args));
}
