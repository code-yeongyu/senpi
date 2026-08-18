import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AuthContext, Model, Provider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

let tempDir: string | undefined;
let modelsPath: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "senpi-composer-headers-auth-"));
	modelsPath = join(tempDir, "models.json");
	writeFileSync(
		modelsPath,
		JSON.stringify({
			providers: {
				"headers-only": {
					baseUrl: "https://example.invalid/v1",
					api: "openai-completions",
					headers: { "x-api-key": "header-key" },
					models: [{ id: "headers-model" }],
				},
				"metadata-only": {
					baseUrl: "https://example.invalid/v1",
					api: "openai-completions",
					headers: { "User-Agent": "senpi-test" },
					models: [{ id: "metadata-model" }],
				},
				"empty-headers": {
					baseUrl: "https://example.invalid/v1",
					api: "openai-completions",
					headers: {},
					models: [{ id: "empty-model" }],
				},
				"api-key": {
					baseUrl: "https://example.invalid/v1",
					api: "openai-completions",
					apiKey: "configured-api-key",
					models: [{ id: "api-key-model" }],
				},
				"auth-header": {
					authHeader: true,
				},
			},
		}),
	);
});

afterEach(() => {
	if (tempDir !== undefined) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function testModel(id: string, provider = "test-provider"): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

function requireModel(runtime: ModelRuntime, providerId: string, modelId: string): Model<"openai-completions"> {
	const model = runtime.getModel(providerId, modelId);
	expect(model).toBeDefined();
	if (!isOpenAICompletionsModel(model)) {
		throw new Error(`Missing test model ${providerId}/${modelId}`);
	}
	return model;
}

function isOpenAICompletionsModel(model: Model<Api> | undefined): model is Model<"openai-completions"> {
	return model?.api === "openai-completions";
}

describe("configured request header auth", () => {
	it("keeps registry availability, runtime auth, and streaming aligned for models.json headers", async () => {
		const registry = await createModelRegistry(AuthStorage.inMemory(), modelsPath);
		const runtime = getModelRuntime(registry);
		let capturedHeaders: Record<string, string | null> | undefined;
		runtime.registerProvider("headers-only", {
			api: "openai-completions",
			streamSimple: (_model, _context, options) => {
				capturedHeaders = options?.headers;
				throw new Error("captured");
			},
		});

		expect(registry.getProviderAuthStatus("headers-only")).toEqual({
			configured: true,
			source: "models_json_headers",
		});
		expect(registry.getAvailable().some((model) => model.provider === "headers-only")).toBe(true);
		expect(await runtime.checkAuth("headers-only")).toEqual({
			type: "api_key",
			source: "models.json headers",
		});
		expect(await runtime.getAuth("headers-only")).toEqual({
			auth: { headers: { "x-api-key": "header-key" } },
			source: "models.json headers",
		});

		await runtime.completeSimple(requireModel(runtime, "headers-only", "headers-model"), { messages: [] });
		expect(capturedHeaders).toEqual({ "x-api-key": "header-key" });
	});

	it("does not treat metadata or empty header maps as authentication", async () => {
		const registry = await createModelRegistry(AuthStorage.inMemory(), modelsPath);
		const runtime = getModelRuntime(registry);
		const availableProviders = new Set(registry.getAvailable().map((model) => model.provider));

		for (const providerId of ["metadata-only", "empty-headers"]) {
			expect(registry.getProviderAuthStatus(providerId)).toEqual({ configured: false });
			expect(availableProviders.has(providerId)).toBe(false);
			expect(await runtime.checkAuth(providerId)).toBeUndefined();
			expect(await runtime.getAuth(providerId)).toBeUndefined();
		}
	});

	it("supports extension-provided credential headers through the same runtime path", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		let capturedHeaders: Record<string, string | null> | undefined;
		runtime.registerProvider("extension-headers", {
			api: "openai-completions",
			headers: { Authorization: "Bearer extension-token" },
			streamSimple: (_model, _context, options) => {
				capturedHeaders = options?.headers;
				throw new Error("captured");
			},
			models: [testModel("extension-model")],
		});
		await runtime.refresh({ allowNetwork: false });

		expect(runtime.getProviderAuthStatus("extension-headers")).toEqual({
			configured: true,
			source: "extension_headers",
		});
		expect(await runtime.checkAuth("extension-headers")).toEqual({
			type: "api_key",
			source: "provider extension headers",
		});
		expect(await runtime.getAuth("extension-headers")).toEqual({
			auth: { headers: { Authorization: "Bearer extension-token" } },
			source: "provider extension headers",
		});
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "extension-headers")).toBe(true);

		await runtime.completeSimple(requireModel(runtime, "extension-headers", "extension-model"), { messages: [] });
		expect(capturedHeaders).toEqual({ Authorization: "Bearer extension-token" });
	});

	it("does not mark an OAuth provider configured from metadata headers alone", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerProvider("oauth-metadata", {
			headers: { "User-Agent": "senpi-test" },
			oauth: {
				name: "Test OAuth",
				login: async () => ({ refresh: "refresh", access: "access", expires: Date.now() + 60_000 }),
				refreshToken: async (credential) => credential,
				getApiKey: (credential) => credential.access,
			},
			models: [testModel("oauth-model")],
		});
		await runtime.refresh({ allowNetwork: false });

		expect(runtime.getProviderAuthStatus("oauth-metadata")).toEqual({ configured: false });
		expect(await runtime.checkAuth("oauth-metadata")).toBeUndefined();
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "oauth-metadata")).toBe(false);
	});

	it("preserves API-key status and authHeader missing-key behavior", async () => {
		const config = ModelConfig.loadSync(modelsPath);
		expect(
			ModelRuntime.createSync({ credentials: AuthStorage.inMemory(), modelsPath }).getProviderAuthStatus("api-key"),
		).toEqual({
			configured: true,
			source: "models_json_key",
		});

		const provider = composeModelProvider("auth-header", authHeaderBaseProvider(), config, undefined);
		const apiKey = provider.auth.apiKey;
		expect(apiKey).toBeDefined();
		if (!apiKey) throw new Error("Expected api-key auth");
		await expect(apiKey.resolve({ ctx: emptyAuthContext, signal: new AbortController().signal })).rejects.toThrow(
			"authHeader requires a resolved API key",
		);
	});
});

function authHeaderBaseProvider(): Provider {
	const model = testModel("auth-header-model", "auth-header");
	return {
		id: "auth-header",
		name: "Auth header",
		auth: {
			apiKey: {
				name: "Inherited auth",
				resolve: async () => ({ auth: {} }),
			},
		},
		getModels: () => [model],
		stream: () => {
			throw new Error("not used");
		},
		streamSimple: () => {
			throw new Error("not used");
		},
	};
}

const emptyAuthContext: AuthContext = {
	env: async () => undefined,
	fileExists: async () => false,
};
