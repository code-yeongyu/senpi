import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { clearApiKeyCache } from "../src/core/model-registry.ts";
import type { ProviderModelConfig } from "../src/index.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

describe("ModelRegistry recovery configuration", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-model-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		clearApiKeyCache();
		vi.restoreAllMocks();
	});

	function writeRawModelsJson(providers: Record<string, unknown>) {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	test("applies recoverTextToolCalls from custom definitions and model overrides", async () => {
		writeRawModelsJson({
			custom: {
				api: "openai-completions",
				baseUrl: "https://custom.example.com/v1",
				models: [{ id: "custom-recovery", recoverTextToolCalls: true }, { id: "custom-recovery-unset" }],
			},
			openrouter: {
				modelOverrides: {
					"anthropic/claude-sonnet-4": { recoverTextToolCalls: false },
					"anthropic/claude-opus-4": { recoverTextToolCalls: true },
					"unknown/recovery-model": { recoverTextToolCalls: true },
				},
			},
		});

		const extensionModels = [
			{
				id: "extension-recovery-true",
				name: "Extension Recovery True",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
				recoverTextToolCalls: true,
			},
			{
				id: "extension-recovery-false",
				name: "Extension Recovery False",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
				recoverTextToolCalls: false,
			},
			{
				id: "extension-recovery-unset",
				name: "Extension Recovery Unset",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		] satisfies ProviderModelConfig[];

		const registry = await createModelRegistry(authStorage, modelsJsonPath);
		expect(registry.find("custom", "custom-recovery")?.recoverTextToolCalls).toBe(true);
		expect(registry.find("custom", "custom-recovery-unset")?.recoverTextToolCalls).toBeUndefined();
		expect(registry.find("openrouter", "anthropic/claude-sonnet-4")?.recoverTextToolCalls).toBe(false);
		expect(registry.find("openrouter", "anthropic/claude-opus-4")?.recoverTextToolCalls).toBe(true);
		expect(registry.find("openrouter", "unknown/recovery-model")).toBeUndefined();

		registry.registerProvider("extension-provider", {
			baseUrl: "https://extension.example.com/v1",
			apiKey: "test-key",
			api: "openai-completions",
			models: extensionModels,
		});
		expect(registry.find("extension-provider", "extension-recovery-true")?.recoverTextToolCalls).toBe(true);
		expect(registry.find("extension-provider", "extension-recovery-false")?.recoverTextToolCalls).toBe(false);
		expect(registry.find("extension-provider", "extension-recovery-unset")?.recoverTextToolCalls).toBeUndefined();
	});

	test("preserves unset and explicit false recoverTextToolCalls values", async () => {
		writeRawModelsJson({
			custom: {
				api: "openai-completions",
				baseUrl: "https://custom.example.com/v1",
				models: [{ id: "recovery-unset" }, { id: "recovery-disabled", recoverTextToolCalls: false }],
			},
		});

		const registry = await createModelRegistry(authStorage, modelsJsonPath);
		expect(registry.find("custom", "recovery-unset")?.recoverTextToolCalls).toBeUndefined();
		expect(registry.find("custom", "recovery-disabled")?.recoverTextToolCalls).toBe(false);
	});

	test("rejects non-boolean recoverTextToolCalls values", async () => {
		writeRawModelsJson({
			custom: {
				api: "openai-completions",
				baseUrl: "https://custom.example.com/v1",
				models: [{ id: "invalid-recovery", recoverTextToolCalls: "true" }],
			},
		});

		const registry = await createModelRegistry(authStorage, modelsJsonPath);
		expect(registry.getError()).toContain("providers.custom.models.0.recoverTextToolCalls");
		expect(registry.getError()).toContain("boolean");
		expect(registry.find("custom", "invalid-recovery")).toBeUndefined();
	});
});
