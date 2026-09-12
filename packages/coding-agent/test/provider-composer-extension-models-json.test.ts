import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
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

function configFor(provider: string, models?: readonly { id: string; name?: string }[]) {
	tempDir = mkdtempSync(join(tmpdir(), "senpi-composer-extension-models-json-"));
	const modelsPath = join(tempDir, "models.json");
	const providers = models === undefined ? {} : { [provider]: { models } };
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

function modelById(provider: ReturnType<typeof composeModelProvider>, id: string): Model<"claude-sdk-oauth"> {
	const model = provider.getModels().find((entry) => entry.id === id);
	if (model === undefined) throw new Error(`Expected model ${id}`);
	return model as Model<"claude-sdk-oauth">;
}

describe("models.json custom models under extension providers", () => {
	it("inherits extension api and baseUrl and validates the composed provider", () => {
		const config = configFor("claude-sdk-oauth", [{ id: "claude-fable-5-1" }]);
		const provider = composeModelProvider("claude-sdk-oauth", undefined, config, extension);

		const model = modelById(provider, "claude-fable-5-1");
		expect(model.api).toBe("claude-sdk-oauth");
		expect(model.baseUrl).toBe("claude-sdk-oauth");
		expect(() =>
			validateExtensionProvider("claude-sdk-oauth", undefined, config.getProvider("claude-sdk-oauth"), extension),
		).not.toThrow();
	});

	it("preserves extension catalog models and gives extension definitions precedence", () => {
		const config = configFor("claude-sdk-oauth", [
			{ id: "claude-fable-5-1" },
			{ id: "claude-opus-5", name: "custom-name" },
		]);
		const provider = composeModelProvider("claude-sdk-oauth", undefined, config, extension);
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
