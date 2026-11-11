/**
 * omo#12965: provider strict mode and the active provider scope are a realm registry (`provider-scope/v1`), so a second
 * copy of pi-ai in the same realm enforces the strict mode and sees the scope another copy set, for text and images
 * providers. Provider entries stay per copy by design. `vi.resetModules()` between imports gives copy B its own module
 * graph while both share the realm's `globalThis`. Design: approved #12965 class fix, test T-B (provider scope).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiProvider } from "../src/api-registry.ts";

const nodeCopy = async () => ({
	scope: await import("../src/node/provider-scope.ts"),
	api: await import("../src/api-registry.ts"),
	images: await import("../src/images-api-registry.ts"),
});
const registryOnlyCopy = async () => ({
	api: await import("../src/api-registry.ts"),
	images: await import("../src/images-api-registry.ts"),
});

async function nextCopy<T>(load: () => Promise<T>): Promise<T> {
	vi.resetModules();
	return load();
}

function provider(api: string): ApiProvider {
	const never = () => {
		throw new Error("not streamed in this test");
	};
	return { api, stream: never, streamSimple: never };
}

let restore: (() => void) | undefined;
afterEach(() => {
	restore?.();
	restore = undefined;
});

describe("T-B provider strict mode and scope across two pi-ai copies (omo#12965)", () => {
	it("enforces strict mode set in one copy in another, for text and images providers", async () => {
		const a = await nextCopy(nodeCopy);
		const b = await nextCopy(nodeCopy);
		a.scope.setProviderScopeStrictMode(true);
		restore = () => a.scope.setProviderScopeStrictMode(false);

		expect(() => b.api.getApiProvider("x12965-strict")).toThrow("Provider scope is required in strict mode");
		expect(() => b.images.getImagesApiProvider("x12965-strict")).toThrow("Provider scope is required in strict mode");
	});

	it("shows a scope run in one copy to another copy, for text and images providers", async () => {
		const a = await nextCopy(nodeCopy);
		const b = await nextCopy(nodeCopy);
		const scope = new a.scope.ProviderScope();
		const entry = { provider: { ...provider("x12965-scoped"), stream: () => {}, streamSimple: () => {} } };
		scope.overlay.set("x12965-scoped", entry);
		const imagesEntry = { provider: { api: "x12965-scoped-images", generateImages: async () => ({}) } };
		scope.imagesOverlay.set("x12965-scoped-images", imagesEntry);

		const seen = a.scope.runWithProviderScope(scope, () => ({
			active: b.scope.activeProviderScope(),
			text: b.api.getApiProvider("x12965-scoped"),
			images: b.images.getImagesApiProvider("x12965-scoped-images"),
		}));
		expect(seen.active).toBe(scope);
		expect(seen.text).toBe(entry.provider);
		expect(seen.images).toBe(imagesEntry.provider);
	});

	it("lets a copy whose node provider-scope module never evaluated see another copy's strict mode and scope", async () => {
		const a = await nextCopy(nodeCopy);
		const b = await nextCopy(registryOnlyCopy);
		const scope = new a.scope.ProviderScope();
		const entry = { provider: { ...provider("x12965-bare"), stream: () => {}, streamSimple: () => {} } };
		scope.overlay.set("x12965-bare", entry);

		expect(a.scope.runWithProviderScope(scope, () => b.api.getApiProvider("x12965-bare"))).toBe(entry.provider);
		a.scope.setProviderScopeStrictMode(true);
		restore = () => a.scope.setProviderScopeStrictMode(false);
		expect(() => b.api.getApiProvider("x12965-bare")).toThrow("Provider scope is required in strict mode");
	});

	it("keeps provider entries per copy outside a scope (control)", async () => {
		const a = await nextCopy(nodeCopy);
		const b = await nextCopy(nodeCopy);
		a.api.registerApiProvider(provider("x12965-only-a"));
		expect(a.api.getApiProvider("x12965-only-a")).toBeDefined();
		expect(b.api.getApiProvider("x12965-only-a")).toBeUndefined();
		a.api.unregisterApiProviders("x12965-only-a");
	});

	// Two cold evaluations of the whole compat graph are this case's cost, not its subject: its own budget is the bound.
	it(
		"loads a copy evaluated while strict mode is on, outside and inside a scope, and registers its built-ins globally (control)",
		{
			timeout: 180_000,
		},
		async () => {
			const a = await nextCopy(nodeCopy);
			a.scope.setProviderScopeStrictMode(true);
			restore = () => a.scope.setProviderScopeStrictMode(false);
			vi.resetModules();
			const outside = await import("../src/compat.ts");
			const inScope = new a.scope.ProviderScope();
			vi.resetModules();
			const inside = await a.scope.runWithProviderScope(inScope, () => import("../src/compat.ts"));

			const builtins = await a.scope.runWithProviderScope(new a.scope.ProviderScope(), async () => ({
				outside: outside.getApiProvider("anthropic-messages"),
				inside: inside.getApiProvider("anthropic-messages"),
			}));
			expect(builtins.outside).toBeDefined();
			expect(builtins.inside).toBeDefined();
			expect(inScope.overlay.size).toBe(0);
		},
	);

	it("(payload) reads an ill-typed scope as a closed scope and a non-boolean strict mode as on", async () => {
		const b = await nextCopy(registryOnlyCopy);
		await nextCopy(nodeCopy);
		const registry = Reflect.get(globalThis, Symbol.for("@code-yeongyu/senpi/provider-scope/v1")) as {
			run: (scope: unknown, fn: () => unknown) => unknown;
			setStrictMode: (enabled: unknown) => void;
		};
		registry.setStrictMode(1);
		restore = () => registry.setStrictMode(false);
		expect(() => b.api.getApiProvider("x12965-non-boolean")).toThrow("Provider scope is required in strict mode");
		expect(() => registry.run({ state: "active" }, () => b.api.getApiProvider("x12965-ill-typed"))).toThrow(
			"Provider scope is closed",
		);
		expect(() =>
			registry.run({ state: "active", overlay: new Map() }, () => b.images.getImagesApiProvider("x12965-ill-typed")),
		).toThrow("Provider scope is closed");
	});
});
