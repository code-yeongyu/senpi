/**
 * omo#12965 re-read, F5c: a strict mode set while the realm has no provider-scope instance stays with the copy that set
 * it (it is not carried into an instance created later). Each test file has its own realm, so no instance exists yet.
 */
import { describe, expect, it } from "vitest";

describe("strict mode set before the realm has a provider-scope instance", () => {
	it("is enforced by the copy that set it, also once the node subpath creates the instance, until set again", async () => {
		const api = await import("../src/api-registry.ts");
		const images = await import("../src/images-api-registry.ts");
		expect(() => api.getApiProvider("x12965-f5c")).not.toThrow();
		api.setProviderScopeStrictMode(true);
		images.setImagesProviderScopeStrictMode(true);
		expect(() => api.getApiProvider("x12965-f5c")).toThrow("Provider scope is required in strict mode");
		expect(() => images.getImagesApiProvider("x12965-f5c")).toThrow("Provider scope is required in strict mode");

		await import("../src/node/provider-scope.ts");
		expect(() => api.getApiProvider("x12965-f5c")).toThrow("Provider scope is required in strict mode");
		expect(() => images.getImagesApiProvider("x12965-f5c")).toThrow("Provider scope is required in strict mode");

		api.setProviderScopeStrictMode(false);
		images.setImagesProviderScopeStrictMode(false);
		expect(() => api.getApiProvider("x12965-f5c")).not.toThrow();
		expect(() => images.getImagesApiProvider("x12965-f5c")).not.toThrow();
	});
});
