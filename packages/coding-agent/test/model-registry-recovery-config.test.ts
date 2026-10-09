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

	/**
	 * Resolve a model a `modelOverrides` fixture addresses, and say so plainly when the bundled
	 * catalog no longer carries it.
	 *
	 * An override only ever decorates a model the catalog already has, so a retired id makes
	 * `find` return undefined and every field assertion then reports `expected undefined to be X`
	 * - a message that names neither the provider nor the id. senpi#1945 was exactly that: the
	 * catalog dropped bare `anthropic/claude-opus-4` in favour of the `4.1`+ line, and the failure
	 * read as a recovery-config bug for long enough to produce two wrong published diagnoses.
	 * Fixtures that address the catalog go through here so the next retirement explains itself.
	 */
	function findCatalogModel(registry: Awaited<ReturnType<typeof createModelRegistry>>, provider: string, id: string) {
		const model = registry.find(provider, id);
		if (!model) {
			throw new Error(
				`fixture addresses a model the ${provider} catalog does not carry: "${id}". ` +
					`A modelOverrides entry only decorates an existing catalog model, so this fixture can never ` +
					`assert anything. Point it at an id the catalog still ships (see packages/ai/src/providers/data/${provider}.json).`,
			);
		}
		return model;
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
					// The true direction needs a model the catalog still ships: bare
					// `anthropic/claude-opus-4` was retired in favour of the 4.1+ line (senpi#1945).
					"anthropic/claude-opus-4.1": { recoverTextToolCalls: true },
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
		expect(findCatalogModel(registry, "openrouter", "anthropic/claude-sonnet-4").recoverTextToolCalls).toBe(false);
		expect(findCatalogModel(registry, "openrouter", "anthropic/claude-opus-4.1").recoverTextToolCalls).toBe(true);
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
