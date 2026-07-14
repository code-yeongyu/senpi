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

function successfulSearchResponse(): Response {
	return new Response(
		JSON.stringify({
			output: [{ type: "web_search_call", action: { sources: [{ url: "https://results.example.com/native" }] } }],
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

describe("vendored websearch native tool", () => {
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
			nativeModel("openai", "gpt-4o-2025-06-01", "openai-responses", "https://gateway.example.com./v1"),
			nativeModel("openai", "gpt-4.1", "openai-responses", "https://gateway.example.com/v1"),
			nativeModel("anthropic", "claude-sonnet-4-20250514", "anthropic-messages", "https://anthropic.example.com"),
		]);
		const progress: SearchProgressDetails[] = [];
		const fetchMock = vi.fn<typeof fetch>(async () => successfulSearchResponse());
		vi.stubGlobal("fetch", fetchMock);
		const tool = createWebSearchTool(() => ({ ok: true, config: autoConfig(), source: "test" }));

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
		expect(providerLabels[1]?.endsWith("/anthropic")).toBe(true);
		expect(providerLabels[1]).not.toContain("claude");
		expect(providerLabels[2]).toBe("configured-first/duckduckgo-html");
		expect(providerLabels[3]).toBe("configured-second/z-ai");
		expect(providerLabels.filter((label) => label.endsWith("/openai"))).toEqual(["native/openai"]);
		expect(authModels).toEqual(["gpt-5.5", "claude-sonnet-4-20250514"]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("#given auto discovery and a pre-aborted signal #when the real tool is executed #then skips native auth and fetch", async () => {
		// given
		const abortReason = new DOMException("cancelled by test", "AbortError");
		const controller = new AbortController();
		controller.abort(abortReason);
		const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
		const authMock = vi.spyOn(modelRegistry, "getApiKeyAndHeaders");
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);
		const tool = createWebSearchTool(() => ({ ok: true, config: autoConfig(), source: "test" }));
		const activeModel = nativeModel("openai", "gpt-5.5", "openai-responses", "https://gateway.example.com/v1");

		// when
		const execution = tool.execute(
			"pre-aborted",
			{ query: "should not search" },
			controller.signal,
			undefined,
			toolContext(activeModel, modelRegistry),
		);

		// then
		await expect(execution).rejects.toBe(abortReason);
		expect(authMock).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("#given native auth is pending #when the search is aborted #then rejects without waiting for auth", async () => {
		// given
		let markAuthStarted: (() => void) | undefined;
		const authStarted = new Promise<void>((resolve) => {
			markAuthStarted = resolve;
		});
		const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
		vi.spyOn(modelRegistry, "getApiKeyAndHeaders").mockImplementation(async () => {
			markAuthStarted?.();
			return new Promise(() => {});
		});
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);
		const tool = createWebSearchTool(() => ({ ok: true, config: autoConfig(), source: "test" }));
		const activeModel = nativeModel("openai", "gpt-5.5", "openai-responses", "https://gateway.example.com/v1");
		const controller = new AbortController();
		const abortReason = new DOMException("cancelled during auth", "AbortError");

		// when
		const execution = tool.execute(
			"abort-during-auth",
			{ query: "should stop" },
			controller.signal,
			undefined,
			toolContext(activeModel, modelRegistry),
		);
		await authStarted;
		controller.abort(abortReason);

		// then
		await expect(execution).rejects.toBe(abortReason);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
