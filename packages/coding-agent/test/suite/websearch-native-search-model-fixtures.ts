import type { Api, Model } from "@earendil-works/pi-ai";
import { vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import { createWebSearchTool } from "../../src/core/extensions/builtin/websearch/websearch/tool.ts";
import type { SearchDetails, WebsearchConfig } from "../../src/core/extensions/builtin/websearch/websearch/types.ts";
import type { ExtensionContext, ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { createInMemoryExtensionSessionSettings } from "../helpers/extension-session-settings.ts";
import { createTempAgentDir } from "../support/temp-agent-dir.ts";

const AGENT_DIR = createTempAgentDir();
export const PROXY_BASE_URL = "https://claude-proxy.example.com";
export const PROXY_MESSAGES_URL = `${PROXY_BASE_URL}/v1/messages`;

export function model(
	provider: string,
	id: string,
	api: Api,
	baseUrl: string,
	input: number,
	output: number,
): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input, output, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
	};
}

export const sessionOpus = model("claude-proxy", "claude-opus-4-5", "anthropic-messages", PROXY_BASE_URL, 5, 25);
export const proxyHaiku = model("claude-proxy", "claude-haiku-4-5", "anthropic-messages", PROXY_BASE_URL, 1, 5);
export const proxySonnet = model("claude-proxy", "claude-sonnet-4-5", "anthropic-messages", PROXY_BASE_URL, 3, 15);
export const otherProviderLuna = model(
	"openai-proxy",
	"gpt-5.6-luna",
	"openai-responses",
	"https://openai-proxy.example.com/v1",
	0.2,
	1.2,
);

export function anthropicSearchResponse(url: string): Response {
	return new Response(
		JSON.stringify({
			content: [
				{
					type: "web_search_tool_result",
					content: [{ type: "web_search_result", title: "Result", url }],
				},
			],
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

export function emptyAnthropicResponse(): Response {
	return new Response(JSON.stringify({ content: [{ type: "text", text: "nothing found" }] }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

export function toolContext(active: Model<Api> | undefined, modelRegistry: ModelRegistry): ExtensionContext {
	return {
		ui: Object.create(null) as ExtensionContext["ui"],
		mode: "print",
		hasUI: false,
		cwd: process.cwd(),
		agentDir: AGENT_DIR,
		sessionManager: Object.create(null) as ExtensionContext["sessionManager"],
		modelRegistry,
		model: active,
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

export function registryWith(available: Model<Api>[]): ModelRegistry {
	const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
	vi.spyOn(registry, "getApiKeyAndHeaders").mockResolvedValue({ ok: true, apiKey: "proxy-session-key" });
	vi.spyOn(registry, "getAvailable").mockReturnValue(available);
	return registry;
}

export function config(nativeModel?: string): WebsearchConfig {
	return {
		strategy: "priority",
		fallback: true,
		auto: true,
		...(nativeModel === undefined ? {} : { nativeModel }),
		providers: [{ id: "free", provider: "duckduckgo-html" }],
	};
}

export interface CapturedRequest {
	url: string;
	model: unknown;
	apiKey: string | null;
}

export function captureFetch(responses: Array<() => Response>): {
	requests: CapturedRequest[];
	fetchMock: typeof fetch;
} {
	const requests: CapturedRequest[] = [];
	const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: unknown }) : {};
		const headers = new Headers(init?.headers);
		requests.push({ url: String(input), model: body.model, apiKey: headers.get("x-api-key") });
		const next = responses[requests.length - 1];
		if (!next) throw new Error(`unexpected request ${requests.length}`);
		return next();
	});
	return { requests, fetchMock };
}

export async function runSearch(
	cfg: WebsearchConfig,
	registry: ModelRegistry,
	active: Model<Api> | undefined = sessionOpus,
): Promise<{ details: SearchDetails; text: string }> {
	const tool = createWebSearchTool(() => ({ ok: true, config: cfg, source: "test" }));
	const result = await tool.execute("native-search-model", { query: "senpi release" }, undefined, undefined, {
		...toolContext(active, registry),
	} as ExtensionToolContext);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	return { details: result.details as SearchDetails, text };
}
