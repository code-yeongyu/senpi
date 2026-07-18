import { type Api, InMemoryCredentialStore, type Model, type Provider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";

/** Refused immediately so built-in remote catalogs fail fast without external network. */
const UNREACHABLE_CATALOG_BASE_URL = "http://127.0.0.1:1";

/** Llama-style dynamic provider: only a network-allowed refreshModels populates the catalog. */
function createDynamicProvider(id: string) {
	const refreshPolicies: boolean[] = [];
	const model: Model<Api> = {
		id: `${id}-model`,
		name: `${id}-model`,
		api: "openai-completions",
		provider: id,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
		baseUrl: UNREACHABLE_CATALOG_BASE_URL,
	};
	let models: readonly Model<Api>[] = [];
	const provider: Provider = {
		id,
		name: id,
		auth: {
			apiKey: {
				name: `${id} key`,
				resolve: async () => ({ auth: { apiKey: "test-key" }, source: "test" }),
			},
		},
		getModels: () => models,
		refreshModels: async (context) => {
			refreshPolicies.push(context.allowNetwork);
			if (!context.allowNetwork || context.signal?.aborted) return;
			models = [model];
		},
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
	return { provider, refreshPolicies };
}

describe("ModelRuntime post-startup provider registration", () => {
	it("loads a registered native provider's catalog under the runtime network policy without a manual refresh", async () => {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: true,
			catalogBaseUrl: UNREACHABLE_CATALOG_BASE_URL,
			modelRefreshTimeoutMs: 5_000,
		});
		const { provider, refreshPolicies } = createDynamicProvider("test-dynamic");

		// Registration resolves once the provider's bounded policy refresh has landed.
		await runtime.registerNativeProvider(provider);

		expect(refreshPolicies).toContain(true);
		expect(runtime.getModel("test-dynamic", "test-dynamic-model")).toBeDefined();
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "test-dynamic")).toBe(true);
	});

	it("keeps the registration refresh offline when the runtime disallows model network", async () => {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const { provider, refreshPolicies } = createDynamicProvider("test-dynamic");

		await runtime.registerNativeProvider(provider);

		expect(refreshPolicies.length).toBeGreaterThan(0);
		expect(refreshPolicies.every((allowNetwork) => allowNetwork === false)).toBe(true);
		expect(runtime.getModel("test-dynamic", "test-dynamic-model")).toBeUndefined();
	});
});
