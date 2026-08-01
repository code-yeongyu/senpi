import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/index.ts";
import { createWebSearchTool } from "../src/core/extensions/builtin/websearch/websearch/tool.ts";
import type {
	SearchProgressDetails,
	WebsearchConfig,
} from "../src/core/extensions/builtin/websearch/websearch/types.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createInMemoryExtensionSessionSettings } from "./helpers/extension-session-settings.ts";

function nativeModel(provider: string, id: string, api: Api, baseUrl: string): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

function toolContext(model: Model<Api>, modelRegistry: ModelRegistry): ExtensionContext {
	return {
		ui: Object.create(null) as ExtensionContext["ui"],
		mode: "print",
		hasUI: false,
		cwd: process.cwd(),
		sessionManager: Object.create(null) as ExtensionContext["sessionManager"],
		modelRegistry,
		model,
		serviceTier: undefined,
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => undefined,
		getCompactionSettings: () => DEFAULT_COMPACTION_SETTINGS,
		getLookAtSettings: () => ({ enabled: true, models: undefined }),
		getImageSettings: () => ({ autoResize: true, blockImages: false }),
		sessionSettings: createInMemoryExtensionSessionSettings(),
		compact: vi.fn(),
		getMessageRevision: () => 0,
		applyCompaction: async () => ({ applied: false, reason: "rejected" }),
		getSystemPrompt: () => "",
	};
}

function autoConfig(): WebsearchConfig {
	return {
		strategy: "priority",
		fallback: true,
		auto: true,
		providers: [
			{ id: "configured-first", provider: "duckduckgo-html" },
			{ id: "configured-second", provider: "z-ai", apiKey: "configured-key" },
		],
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("vendored websearch provider-aware native routing", () => {
	it("#given a custom active provider and unrelated models #when native routes are discovered #then excludes every non-matching provider candidate", async () => {
		// given
		const activeModel = nativeModel(
			"quotio-openai",
			"gpt-5.6-sol-fast",
			"openai-responses",
			"https://quotio.example.com/v1",
		);
		const authProviders: string[] = [];
		const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
		vi.spyOn(modelRegistry, "getApiKeyAndHeaders").mockImplementation(async (model) => {
			authProviders.push(model.provider);
			return { ok: true, apiKey: `${model.provider}-native-key` };
		});
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([
			nativeModel("openai", "gpt-5.5", "openai-responses", "https://api.openai.com/v1"),
			nativeModel("anthropic", "claude-sonnet-4-20250514", "anthropic-messages", "https://api.anthropic.com"),
			nativeModel("z-ai", "glm-4.6", "openai-completions", "https://api.z.ai/api/paas/v4"),
		]);
		const progress: SearchProgressDetails[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 })),
		);
		const tool = createWebSearchTool(() => ({ ok: true, config: autoConfig(), source: "test" }));

		// when
		await tool.execute(
			"custom-native-exclusions",
			{ query: "custom native exclusions" },
			undefined,
			(update) => {
				if (update.details && "phase" in update.details && update.details.phase === "searching") {
					progress.push(update.details);
				}
			},
			toolContext(activeModel, modelRegistry),
		);

		// then
		expect(progress[0]?.providerLabels).toEqual([
			"quotio-openai/native",
			"duckduckgo-html/configured-first",
			"z-ai/configured-second",
		]);
		expect(authProviders).toEqual(["quotio-openai"]);
	});

	it("#given an active z-ai model and z-ai candidates #when native routes are discovered #then keeps the matching z-ai/native route first", async () => {
		// given
		const activeModel = nativeModel("z-ai", "glm-5.2", "openai-completions", "https://api.z.ai/api/paas/v4");
		const authProviders: string[] = [];
		const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
		vi.spyOn(modelRegistry, "getApiKeyAndHeaders").mockImplementation(async (model) => {
			authProviders.push(model.provider);
			return { ok: true, apiKey: `${model.provider}-native-key` };
		});
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([
			nativeModel("z-ai", "glm-4.6", "openai-completions", "https://api.z.ai/api/paas/v4"),
			nativeModel("deepseek", "deepseek-v4-flash", "openai-completions", "https://api.deepseek.com/v1"),
		]);
		const progress: SearchProgressDetails[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 })),
		);
		const tool = createWebSearchTool(() => ({ ok: true, config: autoConfig(), source: "test" }));

		// when
		await tool.execute(
			"matching-z-ai-native",
			{ query: "matching z-ai native" },
			undefined,
			(update) => {
				if (update.details && "phase" in update.details && update.details.phase === "searching") {
					progress.push(update.details);
				}
			},
			toolContext(activeModel, modelRegistry),
		);

		// then
		expect(progress[0]?.providerLabels).toEqual([
			"z-ai/native",
			"duckduckgo-html/configured-first",
			"z-ai/configured-second",
		]);
		expect(progress[1]?.currentProvider).toBe("z-ai/native");
		expect(authProviders).toEqual(["z-ai"]);
	});

	it("#given an active deepseek model and deepseek candidates #when native routes are discovered #then keeps the matching deepseek/native route first", async () => {
		// given
		const activeModel = nativeModel(
			"deepseek",
			"deepseek-v4-flash",
			"openai-completions",
			"https://api.deepseek.com",
		);
		const authProviders: string[] = [];
		const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
		vi.spyOn(modelRegistry, "getApiKeyAndHeaders").mockImplementation(async (model) => {
			authProviders.push(model.provider);
			return { ok: true, apiKey: `${model.provider}-native-key` };
		});
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([
			nativeModel("deepseek", "deepseek-v4-pro", "openai-completions", "https://api.deepseek.com"),
		]);
		const progress: SearchProgressDetails[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 })),
		);
		const tool = createWebSearchTool(() => ({ ok: true, config: autoConfig(), source: "test" }));

		// when
		await tool.execute(
			"matching-deepseek-native",
			{ query: "matching deepseek native" },
			undefined,
			(update) => {
				if (update.details && "phase" in update.details && update.details.phase === "searching") {
					progress.push(update.details);
				}
			},
			toolContext(activeModel, modelRegistry),
		);

		// then
		expect(progress[0]?.providerLabels).toEqual([
			"deepseek/native",
			"duckduckgo-html/configured-first",
			"z-ai/configured-second",
		]);
		expect(progress[1]?.currentProvider).toBe("deepseek/native");
		expect(authProviders).toEqual(["deepseek"]);
	});

	it.each([
		{
			provider: "openai",
			id: "gpt-5.5",
			api: "openai-responses" as const,
			baseUrl: "https://api.openai.com/v1",
			expected: "openai/native",
		},
		{
			provider: "anthropic",
			id: "claude-sonnet-4-20250514",
			api: "anthropic-messages" as const,
			baseUrl: "https://api.anthropic.com",
			expected: "anthropic/native",
		},
	])(
		"#given an active $provider provider #when the real tool is executed #then keeps the matching first-party native route first",
		async ({ provider, id, api, baseUrl, expected }) => {
			// given
			const activeModel = nativeModel(provider, id, api, baseUrl);
			const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
			vi.spyOn(modelRegistry, "getApiKeyAndHeaders").mockResolvedValue({
				ok: true,
				apiKey: `${provider}-native-key`,
			});
			vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([]);
			const progress: SearchProgressDetails[] = [];
			vi.stubGlobal(
				"fetch",
				vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 })),
			);
			const tool = createWebSearchTool(() => ({ ok: true, config: autoConfig(), source: "test" }));

			// when
			await tool.execute(
				`matching-${provider}-native`,
				{ query: `matching ${provider} native` },
				undefined,
				(update) => {
					if (update.details && "phase" in update.details && update.details.phase === "searching") {
						progress.push(update.details);
					}
				},
				toolContext(activeModel, modelRegistry),
			);

			// then
			expect(progress[0]?.providerLabels[0]).toBe(expected);
			expect(progress[1]?.currentProvider).toBe(expected);
		},
	);
});
