import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelConfig, type ModelsJsonProvider } from "../src/core/model-config.ts";
import {
	composeModelProvider,
	type ProviderConfigInput,
	validateExtensionProvider,
} from "../src/core/provider-composer.ts";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir !== undefined) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

const extension = {
	api: "claude-sdk-oauth",
	baseUrl: "claude-sdk-oauth",
	streamSimple: vi.fn(),
	models: [
		{
			id: "claude-opus-5",
			name: "Claude Opus 5",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
			contextWindow: 200000,
			maxTokens: 32000,
		},
		{
			id: "claude-sonnet-5",
			name: "Claude Sonnet 5",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			contextWindow: 200000,
			maxTokens: 16000,
		},
	],
} satisfies ProviderConfigInput;

function configFor(
	provider: string,
	models?: readonly { id: string; name?: string }[],
	visibility?: ModelsJsonProvider,
) {
	tempDir = mkdtempSync(join(tmpdir(), "senpi-composer-extension-models-json-"));
	const modelsPath = join(tempDir, "models.json");
	const providers = models === undefined && visibility === undefined ? {} : { [provider]: { models, ...visibility } };
	writeFileSync(modelsPath, JSON.stringify({ providers }));
	return ModelConfig.loadSync(modelsPath);
}

function baseProvider(models: readonly Model<"anthropic-messages">[]): Provider {
	return {
		id: "anthropic",
		name: "Anthropic",
		auth: { apiKey: { name: "Inherited auth", resolve: async () => ({ auth: {} }) } },
		getModels: () => models,
		stream: vi.fn(),
		streamSimple: vi.fn(),
	};
}

function catalogModel(id: string): Model<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

function modelById(provider: ReturnType<typeof composeModelProvider>, id: string): Model<"anthropic-subscription"> {
	const model = provider.getModels().find((entry) => entry.id === id);
	if (model === undefined) throw new Error(`Expected model ${id}`);
	return model as Model<"anthropic-subscription">;
}

describe("models.json custom models under extension providers", () => {
	it.each([
		{ whitelist: ["paid"] },
		{ blacklist: ["free-image", "free-classifier"] },
		{ hideFreeModels: true },
	] satisfies ModelsJsonProvider[])("filters non-chat extension models with %j", (visibility) => {
		const config = configFor("extension-provider", undefined, visibility);
		const provider = composeModelProvider("extension-provider", undefined, config, {
			api: "anthropic-messages",
			baseUrl: "https://example.invalid/v1",
			apiKey: "test-key",
			models: [
				catalogModel("paid"),
				{
					id: "free-image",
					name: "Free image",
					type: "image",
					api: "test-image",
					input: ["text"],
					output: ["image"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
				{
					id: "free-classifier",
					name: "Free classifier",
					type: "classifier",
					api: "test-classifier",
					input: ["text"],
					contextWindow: 1000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			],
		});

		expect(provider.getAllModels?.().map((model) => model.id)).toEqual(["paid"]);
		expect(provider.getModels().map((model) => model.id)).toEqual(["paid"]);
	});

	describe.each(["declared", "refreshed", "oauth"] as const)("%s catalog visibility", (source) => {
		it.each([
			{ name: "whitelist", visibility: { whitelist: ["paid"] }, expected: ["paid"] },
			{ name: "blacklist", visibility: { blacklist: ["free"] }, expected: ["paid"] },
			{ name: "hideFreeModels", visibility: { hideFreeModels: true }, expected: ["paid"] },
			{ name: "empty whitelist", visibility: { whitelist: [] }, expected: [] },
			{
				name: "blacklist over whitelist",
				visibility: { whitelist: ["paid", "free"], blacklist: ["free"] },
				expected: ["paid"],
			},
			{
				name: "disabled hideFreeModels",
				visibility: { hideFreeModels: false },
				expected: ["paid", "free"],
			},
			{
				name: "hideFreeModels before cost overrides",
				visibility: {
					hideFreeModels: true,
					modelOverrides: { paid: { cost: { input: 0, output: 0 } }, free: { cost: { input: 1 } } },
				},
				expected: ["paid"],
			},
		] satisfies { name: string; visibility: ModelsJsonProvider; expected: string[] }[])(
			"applies $name to the final model list",
			async ({ visibility, expected }) => {
				const config = configFor("extension-provider", undefined, visibility);
				const models = [
					{ ...catalogModel("paid"), provider: "extension-provider" },
					{
						...catalogModel("free"),
						provider: "extension-provider",
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				];
				const provider = composeModelProvider("extension-provider", undefined, config, {
					api: "anthropic-messages",
					baseUrl: "https://example.invalid/v1",
					apiKey: "test-key",
					models: source === "declared" ? models : [],
					...(source === "refreshed" ? { refreshModels: async () => models } : {}),
					...(source === "oauth"
						? {
								oauth: {
									name: "Test OAuth",
									login: vi.fn(),
									refreshToken: async (credential) => credential,
									getApiKey: (credential) => credential.access,
									modifyModels: () => models,
								},
							}
						: {}),
				});

				if (source !== "declared") {
					if (!provider.refreshModels) throw new Error("Expected refreshModels");
					await provider.refreshModels({
						allowNetwork: false,
						signal: new AbortController().signal,
						credential: { type: "oauth", access: "test-access", refresh: "test-refresh", expires: 0 },
						publish: async (publication) => {
							publication.update?.();
							return true;
						},
					});
				}

				expect(provider.getAllModels?.().map((model) => model.id)).toEqual(expected);
				expect(provider.getModels().map((model) => model.id)).toEqual(expected);
			},
		);
	});

	it("inherits extension api and baseUrl and validates the composed provider", () => {
		const config = configFor("anthropic-subscription", [{ id: "claude-fable-5-1" }]);
		const provider = composeModelProvider("anthropic-subscription", undefined, config, extension);

		const model = modelById(provider, "claude-fable-5-1");
		expect(model.api).toBe("claude-sdk-oauth");
		expect(model.baseUrl).toBe("claude-sdk-oauth");
		expect(() =>
			validateExtensionProvider(
				"anthropic-subscription",
				undefined,
				config.getProvider("anthropic-subscription"),
				extension,
			),
		).not.toThrow();
	});

	it("preserves extension catalog models and gives extension definitions precedence", () => {
		const config = configFor("anthropic-subscription", [
			{ id: "claude-fable-5-1" },
			{ id: "claude-opus-5", name: "custom-name" },
		]);
		const provider = composeModelProvider("anthropic-subscription", undefined, config, extension);
		const models = provider.getModels();

		expect(models.map((model) => model.id)).toEqual(["claude-opus-5", "claude-sonnet-5", "claude-fable-5-1"]);
		expect(modelById(provider, "claude-opus-5").name).toBe("Claude Opus 5");
	});

	it("replaces a builtin catalog instead of leaking undeclared builtin models", () => {
		const first = catalogModel("builtin-first");
		const second = catalogModel("builtin-second");
		const config = configFor("anthropic");
		const provider = composeModelProvider("anthropic", baseProvider([first, second]), config, {
			...extension,
			models: [
				{
					...extension.models[0],
					id: first.id,
				},
			],
		});

		expect(provider.getModels().map((model) => model.id)).toEqual([first.id]);
	});

	it("keeps models.json custom models alongside a builtin replacement catalog", () => {
		const first = catalogModel("builtin-first");
		const second = catalogModel("builtin-second");
		const config = configFor("anthropic", [{ id: "custom-x" }]);
		const provider = composeModelProvider("anthropic", baseProvider([first, second]), config, {
			...extension,
			models: [
				{
					...extension.models[0],
					id: first.id,
				},
			],
		});

		expect(provider.getModels().map((model) => model.id)).toEqual([first.id, "custom-x"]);
		expect(modelById(provider, "custom-x").api).toBe("claude-sdk-oauth");
		expect(modelById(provider, "custom-x").baseUrl).toBe("claude-sdk-oauth");
	});

	it("keeps the existing missing api error", () => {
		const config = configFor("kiro-like", [{ id: "custom-model" }]);
		expect(() => composeModelProvider("kiro-like", undefined, config, undefined)).toThrow(
			'Provider kiro-like, model custom-model: no "api" specified. Set at provider or model level.',
		);
	});

	it("keeps the existing missing baseUrl error", () => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-composer-extension-models-json-"));
		const modelsPath = join(tempDir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({ providers: { "kiro-like": { api: "kiro-api", models: [{ id: "custom-model" }] } } }),
		);
		const config = ModelConfig.loadSync(modelsPath);

		expect(() => composeModelProvider("kiro-like", undefined, config, undefined)).toThrow(
			'Provider kiro-like: "baseUrl" is required when defining custom models.',
		);
	});
});
