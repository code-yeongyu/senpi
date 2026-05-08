import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";
import { getModelNarrowingPatterns, resolveModelScope } from "../../../src/core/model-resolver.js";
import { createAgentSession } from "../../../src/core/sdk.js";
import { SettingsManager } from "../../../src/core/settings-manager.js";

function registerOpenAiModels(registry: ModelRegistry, ids: string[]): void {
	registry.registerProvider("openai", {
		baseUrl: "https://example.test/v1",
		apiKey: "test-openai-key",
		api: "openai-responses",
		models: ids.map((id) => ({
			id,
			name: id,
			api: "openai-responses",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 8192,
		})),
	});
}

describe("model configuration controls", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-model-config-controls-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("filters providers and provider models from models.json", () => {
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify(
				{
					disabledProviders: ["openai"],
					providers: {
						anthropic: { whitelist: ["claude-sonnet-4-5"] },
						openrouter: { disabled: true },
					},
				},
				null,
				2,
			),
			"utf-8",
		);

		const registry = ModelRegistry.create(AuthStorage.inMemory(), join(agentDir, "models.json"));
		const allModels = registry.getAll();

		expect(allModels.some((model) => model.provider === "openai")).toBe(false);
		expect(allModels.some((model) => model.provider === "openrouter")).toBe(false);
		expect(allModels.filter((model) => model.provider === "anthropic").map((model) => model.id)).toEqual([
			"claude-sonnet-4-5",
		]);
	});

	it("replaces configured thinking variants instead of merging them", () => {
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify(
				{
					providers: {
						openai: {
							modelOverrides: {
								"gpt-5.4": {
									reasoning: true,
									thinkingLevelMapMode: "replace",
									thinkingLevelMap: {
										off: null,
										minimal: null,
										low: "low",
										medium: null,
										high: null,
										xhigh: null,
										max: null,
									},
								},
							},
						},
					},
				},
				null,
				2,
			),
			"utf-8",
		);

		const registry = ModelRegistry.create(AuthStorage.inMemory(), join(agentDir, "models.json"));
		const model = registry.find("openai", "gpt-5.4");

		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["low"]);
	});

	it("cycles only favorite models and reloads favorite model settings", async () => {
		const authStorage = AuthStorage.inMemory({
			anthropic: { type: "api_key", key: "test-anthropic-key" },
			openai: { type: "api_key", key: "test-openai-key" },
		});
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const settingsManager = SettingsManager.inMemory({
			favoriteModels: ["anthropic/claude-sonnet-4-5", "openai/gpt-5.4"],
		});
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			modelRegistry,
			settingsManager,
		});

		expect(session.scopedModels).toEqual([]);
		expect(session.favoriteModels.map((favorite) => `${favorite.model.provider}/${favorite.model.id}`)).toEqual([
			"anthropic/claude-sonnet-4-5",
			"openai/gpt-5.4",
		]);

		const firstCycle = await session.cycleModel();
		expect(firstCycle?.model.provider).toBe("anthropic");
		expect(firstCycle?.model.id).toBe("claude-sonnet-4-5");
		const secondCycle = await session.cycleModel();
		expect(secondCycle?.model.provider).toBe("openai");
		expect(secondCycle?.model.id).toBe("gpt-5.4");

		settingsManager.setFavoriteModels(["anthropic/claude-sonnet-4-5"]);
		await settingsManager.flush();
		await session.reload();

		expect(session.scopedModels).toEqual([]);
		expect(session.favoriteModels.map((favorite) => `${favorite.model.provider}/${favorite.model.id}`)).toEqual([
			"anthropic/claude-sonnet-4-5",
		]);
		expect(await session.cycleModel()).toBeUndefined();
	});

	it("keeps exact favorite model ids that end in -fast", async () => {
		const authStorage = AuthStorage.inMemory({ openai: { type: "api_key", key: "test-openai-key" } });
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		registerOpenAiModels(modelRegistry, ["gpt-5-4-mini-fast", "gpt-5.4"]);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const scopedModels = await resolveModelScope(["openai/gpt-5-4-mini-fast", "openai/gpt-5.4"], modelRegistry);

		expect(scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`)).toEqual([
			"openai/gpt-5-4-mini-fast",
			"openai/gpt-5.4",
		]);
		expect(scopedModels[0]?.serviceTier).toBeUndefined();
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("uses legacy enabledModels for global narrowing but not Ctrl+P favorites", async () => {
		const authStorage = AuthStorage.inMemory({ openai: { type: "api_key", key: "test-openai-key" } });
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		registerOpenAiModels(modelRegistry, ["gpt-5-4-mini-fast", "gpt-5.4"]);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			modelRegistry,
			settingsManager: SettingsManager.inMemory({
				enabledModels: ["openai/gpt-5-4-mini-fast", "openai/gpt-5.4"],
			}),
		});

		expect(session.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`)).toEqual([
			"openai/gpt-5-4-mini-fast",
			"openai/gpt-5.4",
		]);
		expect(session.favoriteModels).toEqual([]);
		expect(await session.cycleModel()).toBeUndefined();
	});

	it("uses cli patterns before legacy model narrowing settings", () => {
		expect(
			getModelNarrowingPatterns({
				cliPatterns: ["cli-model"],
				legacyEnabledPatterns: ["legacy-model"],
			}),
		).toEqual(["cli-model"]);
		expect(getModelNarrowingPatterns({ legacyEnabledPatterns: ["legacy-model"] })).toEqual(["legacy-model"]);
		expect(getModelNarrowingPatterns({})).toEqual([]);
	});

	it("does not cycle when no favorite models are configured", async () => {
		const authStorage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "test-anthropic-key" } });
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			modelRegistry: ModelRegistry.inMemory(authStorage),
			settingsManager: SettingsManager.inMemory(),
		});

		expect(session.favoriteModels).toEqual([]);
		expect(await session.cycleModel()).toBeUndefined();
	});
});
