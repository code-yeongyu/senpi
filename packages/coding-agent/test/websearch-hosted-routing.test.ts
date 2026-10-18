import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/index.ts";
import { createWebSearchTool } from "../src/core/extensions/builtin/websearch/websearch/tool.ts";
import type {
	SearchProgressDetails,
	SearchProviderEntry,
	WebsearchConfig,
} from "../src/core/extensions/builtin/websearch/websearch/types.ts";
import type { ExtensionContext, ExtensionToolContext } from "../src/core/extensions/types.ts";
import { ModelRegistry, type ResolvedRequestAuth } from "../src/core/model-registry.ts";
import { createInMemoryExtensionSessionSettings } from "./helpers/extension-session-settings.ts";
import { createTempAgentDir } from "./support/temp-agent-dir.ts";

const AGENT_DIR = createTempAgentDir();
const SUBSCRIPTION_URL = "https://chatgpt.com/backend-api/codex/responses";

function model(provider: string, id: string, api: Api, baseUrl: string, headers?: Record<string, string>): Model<Api> {
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
		...(headers ? { headers } : {}),
	};
}

const subscriptionModel = (id = "gpt-5.5", headers?: Record<string, string>) =>
	model("chatgpt-subscription", id, "openai-codex-responses", "https://chatgpt.com/backend-api", headers);
const googleModel = (id = "gemini-2.5-pro") =>
	model("google", id, "google-generative-ai", "https://generativelanguage.googleapis.com/v1beta");
const anthropicModel = () =>
	model("anthropic", "claude-sonnet-4-20250514", "anthropic-messages", "https://anthropic.example.com");

function toolContext(active: Model<Api> | undefined, modelRegistry: ModelRegistry): ExtensionContext {
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

interface Harness {
	authProviders: string[];
	requests: Array<{ url: string; headers: Headers; body: string }>;
	progress: SearchProgressDetails[];
	run(active: Model<Api> | undefined, providers: SearchProviderEntry[]): Promise<void>;
}

function harness(available: Model<Api>[], auth: (model: Model<Api>) => ResolvedRequestAuth): Harness {
	const state: Harness = {
		authProviders: [],
		requests: [],
		progress: [],
		async run(active, providers) {
			const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
			vi.spyOn(modelRegistry, "getApiKeyAndHeaders").mockImplementation(async (requested) => {
				state.authProviders.push(requested.provider);
				return auth(requested);
			});
			vi.spyOn(modelRegistry, "getAvailable").mockReturnValue(available);
			const config: WebsearchConfig = { strategy: "priority", fallback: true, auto: true, providers };
			const tool = createWebSearchTool(() => ({ ok: true, config, source: "test" }));
			await tool.execute(
				"hosted-routing",
				{ query: "hosted routing" },
				undefined,
				(update) => {
					if (update.details && "phase" in update.details && update.details.phase === "searching") {
						state.progress.push(update.details);
					}
				},
				{ ...toolContext(active, modelRegistry) } as ExtensionToolContext,
			);
		},
	};
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input, init) => {
			const body = typeof init?.body === "string" ? init.body : "";
			state.requests.push({ url: String(input), headers: new Headers(init?.headers), body });
			return new Response("{}", { status: 200 });
		}),
	);
	return state;
}

const FREE = { id: "free", provider: "duckduckgo-html" } as const satisfies SearchProviderEntry;
const okKey = (apiKey: string, headers?: Record<string, string | null>): ResolvedRequestAuth => ({
	ok: true,
	apiKey,
	...(headers ? { headers } : {}),
});

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("websearch hosted routes follow the session provider", () => {
	it("#given an active ChatGPT subscription session #when searching #then routes chatgpt-subscription/native first with the credential's headers", async () => {
		// given
		const active = subscriptionModel("gpt-5.5", { "x-catalog": "catalog", "x-suppressed": "catalog" });
		const h = harness([], () => okKey("subscription-token", { "x-registry": "registry", "x-suppressed": null }));

		// when
		await h.run(active, [FREE]);

		// then
		expect(h.progress[0]?.providerLabels).toEqual(["chatgpt-subscription/native", "duckduckgo-html/free"]);
		const first = h.requests[0];
		expect(first?.url).toBe(SUBSCRIPTION_URL);
		expect(first?.headers.get("authorization")).toBe("Bearer subscription-token");
		expect(first?.headers.get("x-catalog")).toBe("catalog");
		expect(first?.headers.get("x-registry")).toBe("registry");
		expect(first?.headers.get("x-suppressed")).toBeNull();
	});

	it.each([
		["a Google API-key session", googleModel("gemini-2.5-pro")],
		[
			"a Vertex API-key session",
			model("google-vertex", "gemini-2.5-flash", "google-vertex", "https://{location}-aiplatform.googleapis.com"),
		],
	])(
		"#given %s and no google entry in websearch.json #when searching #then adds no Google Search grounding route",
		async (_label, active) => {
			// given
			const h = harness([googleModel()], () => okKey("google-session-key"));

			// when
			await h.run(active, [FREE]);

			// then
			expect(h.progress[0]?.providerLabels).toEqual(["duckduckgo-html/free"]);
			expect(h.authProviders).toEqual([]);
			expect(h.requests.some((request) => request.url.includes("googleapis.com"))).toBe(false);
		},
	);

	it("#given a Google session with a google entry listed without apiKey #when searching #then grounds through the session's Google login", async () => {
		// given
		const h = harness([], () => okKey("google-session-key"));

		// when
		await h.run(googleModel("gemini-2.5-pro"), [{ id: "listed", provider: "google" }, FREE]);

		// then
		expect(h.progress[0]?.providerLabels).toEqual(["google/listed", "duckduckgo-html/free"]);
		expect(h.requests[0]?.url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
		);
		expect(h.requests[0]?.headers.get("x-goog-api-key")).toBe("google-session-key");
	});

	it("#given an unrelated session with subscription and Google logins available #when searching #then adds neither hosted route", async () => {
		// given
		const h = harness([subscriptionModel(), googleModel()], (requested) => okKey(`${requested.provider}-key`));

		// when
		await h.run(anthropicModel(), [FREE]);

		// then
		expect(h.progress[0]?.providerLabels).toEqual(["anthropic/native", "duckduckgo-html/free"]);
		expect(h.authProviders).toEqual(["anthropic"]);
		expect(h.requests.some((request) => request.url.startsWith("https://chatgpt.com/"))).toBe(false);
		expect(h.requests.some((request) => request.url.includes("generativelanguage"))).toBe(false);
	});

	it.each([
		["a small subscription model", subscriptionModel("gpt-5.3-codex-spark")],
		["an open-weight Google model", googleModel("gemma-4-31b-it")],
	])("#given %s #when searching #then adds no hosted route", async (_label, active) => {
		// given
		const h = harness([], () => okKey("key"));

		// when
		await h.run(active, [FREE]);

		// then
		expect(h.progress[0]?.providerLabels).toEqual(["duckduckgo-html/free"]);
	});
});

describe("websearch hosted routes listed in websearch.json", () => {
	it("#given a listed chatgpt-subscription entry and an unrelated session #when searching #then resolves the subscription login for that entry", async () => {
		// given
		const h = harness([subscriptionModel("gpt-5.3-codex-spark"), subscriptionModel("gpt-5.5")], () =>
			okKey("listed-subscription-token"),
		);

		// when
		await h.run(anthropicModel(), [{ id: "listed", provider: "chatgpt-subscription" }]);

		// then
		expect(h.progress[0]?.providerLabels).toEqual(["anthropic/native", "chatgpt-subscription/listed"]);
		const subscriptionRequest = h.requests.find((request) => request.url === SUBSCRIPTION_URL);
		expect(subscriptionRequest?.headers.get("authorization")).toBe("Bearer listed-subscription-token");
		expect(JSON.parse(subscriptionRequest?.body ?? "{}").model).toBe("gpt-5.5");
	});

	it("#given a listed google entry with its own apiKey #when searching #then uses that key without the session login", async () => {
		// given
		const h = harness([googleModel()], () => okKey("session-google-key"));

		// when
		await h.run(anthropicModel(), [{ id: "listed", provider: "google", apiKey: "listed-google-key" }]);

		// then
		const googleRequest = h.requests.find((request) => request.url.includes("generativelanguage"));
		expect(googleRequest?.url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
		);
		expect(googleRequest?.headers.get("x-goog-api-key")).toBe("listed-google-key");
		expect(h.authProviders).toEqual(["anthropic"]);
	});

	it("#given a listed chatgpt-subscription entry and no subscription login #when searching #then skips that entry and keeps the others", async () => {
		// given
		const h = harness([], () => okKey("unused"));

		// when
		await h.run(anthropicModel(), [{ id: "listed", provider: "chatgpt-subscription" }, FREE]);

		// then
		expect(h.progress[0]?.providerLabels).toEqual(["anthropic/native", "duckduckgo-html/free"]);
		expect(h.requests.some((request) => request.url === SUBSCRIPTION_URL)).toBe(false);
	});
});
