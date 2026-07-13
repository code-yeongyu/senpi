import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthStorage } from "../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/index.ts";
import {
	buildNativeEntries,
	type NativeModelInfo,
	type NativeModelRegistry,
} from "../src/core/extensions/builtin/websearch/websearch/native.ts";
import { createWebSearchTool } from "../src/core/extensions/builtin/websearch/websearch/tool.ts";
import type {
	SearchProgressDetails,
	WebsearchConfig,
} from "../src/core/extensions/builtin/websearch/websearch/types.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

type DiscoveryRegistry = NativeModelRegistry & {
	getAvailable(): NativeModelInfo[];
};

function anthropicAliases(baseUrl: string): NativeModelInfo[] {
	return Array.from({ length: 8 }, (_value, index) => ({
		provider: "anthropic",
		id: index === 0 ? "claude-opus-4" : `claude-opus-4-${index}`,
		baseUrl,
	}));
}

function zAiAliases(baseUrl: string): NativeModelInfo[] {
	return Array.from({ length: 6 }, (_value, index) => ({
		provider: "z-ai",
		id: `glm-4.6-${index}`,
		baseUrl,
	}));
}

function successfulSearchResponse(): Response {
	return new Response(
		JSON.stringify({
			output: [
				{
					type: "web_search_call",
					action: { sources: [{ url: "https://results.example.com/native" }] },
				},
			],
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

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

function toolContext(model: Model<Api> | undefined, modelRegistry: ModelRegistry): ExtensionContext {
	return {
		ui: Object.create(null) as ExtensionContext["ui"],
		mode: "print",
		hasUI: false,
		cwd: process.cwd(),
		sessionManager: Object.create(null) as ExtensionContext["sessionManager"],
		modelRegistry,
		model,
		serviceTier: undefined,
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => undefined,
		getCompactionSettings: () => DEFAULT_COMPACTION_SETTINGS,
		compact: vi.fn(),
		getMessageRevision: () => 0,
		applyCompaction: async () => ({ applied: false, reason: "rejected" }),
		getSystemPrompt: () => "",
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("vendored websearch native route discovery", () => {
	it("#given fourteen aliases across two endpoints #when discovering native entries #then emits one opaque entry per route", async () => {
		// given
		const authModels: string[] = [];
		const modelRegistry: DiscoveryRegistry = {
			async getApiKeyAndHeaders(model) {
				authModels.push(model.id);
				return { ok: true, apiKey: "native-test" };
			},
			getAvailable() {
				return [
					...anthropicAliases("https://gateway.example.com/v1"),
					...zAiAliases("https://gateway.example.com/v1"),
				];
			},
		};

		// when
		const firstEntries = await buildNativeEntries(undefined, modelRegistry);
		const secondEntries = await buildNativeEntries(undefined, modelRegistry);

		// then
		expect(firstEntries).toHaveLength(2);
		expect(firstEntries.map((entry) => entry.id)).toEqual(secondEntries.map((entry) => entry.id));
		expect(firstEntries[0]?.id).toMatch(/^native-anthropic-[0-9a-f]{16}$/);
		expect(firstEntries[1]?.id).toMatch(/^native-z-ai-[0-9a-f]{16}$/);
		expect(firstEntries.map((entry) => entry.id).join(" ")).not.toContain("gateway-example");
		expect(authModels).toEqual(["claude-opus-4", "glm-4.6-0", "claude-opus-4", "glm-4.6-0"]);
	});

	it("#given active route auth fails #when a discovered alias shares the route #then does not retry auth through the alias", async () => {
		// given
		const activeModel: NativeModelInfo = {
			provider: "openai",
			id: "gpt-5.5",
			baseUrl: "https://gateway.example.com/v1",
		};
		const authModels: string[] = [];
		const modelRegistry: DiscoveryRegistry = {
			async getApiKeyAndHeaders(model) {
				authModels.push(model.id);
				return model.id === activeModel.id
					? { ok: false, error: "active unavailable" }
					: { ok: true, apiKey: "alias-key" };
			},
			getAvailable() {
				return [{ provider: "openai", id: "gpt-4.1", baseUrl: "https://gateway.example.com/v1" }];
			},
		};

		// when
		const entries = await buildNativeEntries(activeModel, modelRegistry);

		// then
		expect(entries).toEqual([]);
		expect(authModels).toEqual(["gpt-5.5"]);
	});

	it("#given unavailable aliases on one route #when discovering native entries #then resolves auth for only the first alias", async () => {
		// given
		const authModels: string[] = [];
		const modelRegistry: DiscoveryRegistry = {
			async getApiKeyAndHeaders(model) {
				authModels.push(model.id);
				return { ok: false, error: "unavailable" };
			},
			getAvailable() {
				return anthropicAliases("https://gateway.example.com/v1");
			},
		};

		// when
		const entries = await buildNativeEntries(undefined, modelRegistry);

		// then
		expect(entries).toEqual([]);
		expect(authModels).toEqual(["claude-opus-4"]);
	});

	it("#given one provider on distinct endpoints #when discovering native entries #then preserves both route candidates", async () => {
		// given
		const authModels: string[] = [];
		const modelRegistry: DiscoveryRegistry = {
			async getApiKeyAndHeaders(model) {
				authModels.push(model.id);
				return { ok: true, apiKey: "native-test" };
			},
			getAvailable() {
				return [
					{ provider: "openai", id: "gpt-4.1", baseUrl: "https://openai-a.example.com/v1" },
					{ provider: "openai", id: "gpt-5.5", baseUrl: "https://openai-b.example.com/v1" },
				];
			},
		};

		// when
		const entries = await buildNativeEntries(undefined, modelRegistry);

		// then
		expect(entries).toHaveLength(2);
		expect(entries.map((entry) => entry.baseUrl)).toEqual([
			"https://openai-a.example.com/v1/responses",
			"https://openai-b.example.com/v1/responses",
		]);
		expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
		expect(authModels).toEqual(["gpt-4.1", "gpt-5.5"]);
	});

	it("#given query auth and fragment aliases #when building the endpoint #then preserves query and dedupes fragments", async () => {
		// given
		const authModels: string[] = [];
		const modelRegistry: DiscoveryRegistry = {
			async getApiKeyAndHeaders(model) {
				authModels.push(model.id);
				return { ok: true, apiKey: "native-test" };
			},
			getAvailable() {
				return [
					{
						provider: "openai",
						id: "gpt-5.5",
						baseUrl: "https://gateway.example.com/v1?token=secret#first",
					},
					{
						provider: "openai",
						id: "gpt-4.1",
						baseUrl: "https://gateway.example.com/v1?token=secret#second",
					},
				];
			},
		};

		// when
		const entries = await buildNativeEntries(undefined, modelRegistry);

		// then
		expect(entries).toHaveLength(1);
		expect(entries[0]?.baseUrl).toBe("https://gateway.example.com/v1/responses?token=secret");
		expect(entries[0]?.id).toMatch(/^native-openai-[0-9a-f]{16}$/);
		expect(entries[0]?.id).not.toContain("secret");
		expect(authModels).toEqual(["gpt-5.5"]);
	});

	it("#given an active native model and same-route aliases #when the real tool is executed #then orders native routes before configured providers without duplication", async () => {
		// given
		const activeModel = nativeModel("openai", "gpt-5.5", "openai-responses", "https://gateway.example.com/v1");
		const authModels: string[] = [];
		const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
		vi.spyOn(modelRegistry, "getApiKeyAndHeaders").mockImplementation(async (model) => {
			authModels.push(model.id);
			return { ok: true, apiKey: `${model.provider}-native-key` };
		});
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([
			nativeModel("openai", "gpt-4o-2025-06-01", "openai-responses", "https://gateway.example.com/v1"),
			nativeModel("openai", "gpt-4.1", "openai-responses", "https://gateway.example.com/v1"),
			nativeModel("anthropic", "claude-sonnet-4-20250514", "anthropic-messages", "https://anthropic.example.com"),
		]);
		const config: WebsearchConfig = {
			strategy: "priority",
			fallback: true,
			auto: true,
			providers: [
				{ id: "configured-first", provider: "duckduckgo-html" },
				{ id: "configured-second", provider: "z-ai", apiKey: "configured-key" },
			],
		};
		const progress: SearchProgressDetails[] = [];
		const fetchMock = vi.fn<typeof fetch>(async () => successfulSearchResponse());
		vi.stubGlobal("fetch", fetchMock);
		const tool = createWebSearchTool(() => ({ ok: true, config, source: "test" }));

		// when
		await tool.execute(
			"native-route-order",
			{ query: "native route order" },
			undefined,
			(update) => {
				if (update.details && "phase" in update.details && update.details.phase === "searching") {
					progress.push(update.details);
				}
			},
			toolContext(activeModel, modelRegistry),
		);

		// then
		expect(progress).toHaveLength(1);
		const providerLabels = progress[0]?.providerLabels ?? [];
		expect(providerLabels).toHaveLength(4);
		expect(providerLabels[0]).toBe("native/openai");
		expect(providerLabels[1]).toMatch(/^native-anthropic-[0-9a-f]{16}\/anthropic$/);
		expect(providerLabels[2]).toBe("configured-first/duckduckgo-html");
		expect(providerLabels[3]).toBe("configured-second/z-ai");
		expect(providerLabels.filter((label) => label.endsWith("/openai"))).toEqual(["native/openai"]);
		expect(authModels).toEqual(["gpt-5.5", "claude-sonnet-4-20250514"]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("#given a pre-aborted signal #when the real tool is executed #then propagates the reason before fetch or fallback", async () => {
		// given
		const config: WebsearchConfig = {
			strategy: "priority",
			fallback: true,
			auto: false,
			providers: [
				{ id: "first", provider: "duckduckgo-html" },
				{ id: "second", provider: "z-ai", apiKey: "configured-key" },
			],
		};
		const abortReason = new DOMException("cancelled by test", "AbortError");
		const controller = new AbortController();
		controller.abort(abortReason);
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);
		const tool = createWebSearchTool(() => ({ ok: true, config, source: "test" }));
		const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());

		// when
		const execution = tool.execute(
			"pre-aborted",
			{ query: "should not search" },
			controller.signal,
			undefined,
			toolContext(undefined, modelRegistry),
		);

		// then
		await expect(execution).rejects.toBe(abortReason);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
