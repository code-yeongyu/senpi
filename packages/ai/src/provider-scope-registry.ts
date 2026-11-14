import { hasFunctions, realmRegistryLookup } from "@earendil-works/pi-realm-registry";

export const PROVIDER_SCOPE_REGISTRY_KEY = "@code-yeongyu/senpi/provider-scope/v1";

/**
 * Provider strict mode and the active provider scope of every pi-ai copy in this realm (omo#12965).
 *
 * A realm can hold more than one copy of pi-ai (the bundled engine next to the SDK graph a plugin imports). Strict mode
 * set in one copy and a scope entered by one copy must hold in all of them, or a second copy resolves providers from
 * its global registry while the first one refuses. Only `node/provider-scope.ts` creates the instance, because only it
 * may build an `AsyncLocalStorage`; this browser-neutral module looks the instance up and never creates one.
 *
 * Provider entries are not shared: each copy keeps its own maps. Inside a scope the entries live in the scope object,
 * which every copy reads structurally. Values that cross copies are validated by the reader: a scope missing a member
 * reads as closed, and a strict mode that is not a boolean reads as on.
 */
export interface ProviderScopeRegistry {
	strictMode(): unknown;
	setStrictMode(enabled: boolean): void;
	imagesStrictMode(): unknown;
	setImagesStrictMode(enabled: boolean): void;
	run<T>(scope: object, fn: () => T): T;
	current(): unknown;
}

export function isProviderScopeRegistry(value: unknown): value is ProviderScopeRegistry {
	return hasFunctions(value, [
		"strictMode",
		"setStrictMode",
		"imagesStrictMode",
		"setImagesStrictMode",
		"run",
		"current",
	]);
}

/** The realm's instance, or `undefined` while no copy's `node/provider-scope` module has evaluated. */
export function lookupProviderScopeRegistry(): ProviderScopeRegistry | undefined {
	return realmRegistryLookup(PROVIDER_SCOPE_REGISTRY_KEY, isProviderScopeRegistry);
}

/** Whether a scope object another copy may have placed is active and carries `overlayName` as a `Map`. */
export function isActiveScopeWith(scope: unknown, overlayName: "overlay" | "imagesOverlay"): boolean {
	return (
		typeof scope === "object" &&
		scope !== null &&
		Reflect.get(scope, "state") === "active" &&
		Reflect.get(scope, overlayName) instanceof Map
	);
}
