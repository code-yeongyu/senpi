import { describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { builtinProviders } from "../src/providers/all.ts";

const API_KEY_PROVIDER_IDS = [
	"alibaba-coding-plan",
	"deepinfra",
	"firepass",
	"fugu",
	"litellm",
	"lm-studio",
	"nanogpt",
	"ollama",
	"ollama-cloud",
	"qianfan",
	"qwen-portal",
	"synthetic",
	"venice",
	"vllm",
	"zenmux",
] as const;

const API_KEY_ENV_VARS = {
	"alibaba-coding-plan": ["ALIBABA_CODING_PLAN_API_KEY"],
	deepinfra: ["DEEPINFRA_API_KEY"],
	firepass: ["FIREPASS_API_KEY"],
	fugu: ["FUGU_API_KEY"],
	litellm: ["LITELLM_API_KEY"],
	"lm-studio": ["LM_STUDIO_API_KEY"],
	nanogpt: ["NANO_GPT_API_KEY"],
	ollama: ["OLLAMA_API_KEY"],
	"ollama-cloud": ["OLLAMA_CLOUD_API_KEY"],
	qianfan: ["QIANFAN_API_KEY"],
	"qwen-portal": ["QWEN_OAUTH_TOKEN", "QWEN_PORTAL_API_KEY"],
	synthetic: ["SYNTHETIC_API_KEY"],
	venice: ["VENICE_API_KEY"],
	vllm: ["VLLM_API_KEY"],
	zenmux: ["ZENMUX_API_KEY"],
} as const satisfies Record<(typeof API_KEY_PROVIDER_IDS)[number], readonly string[]>;

const LOCAL_DUMMY_KEYS = {
	"lm-studio": "lm-studio-local",
	ollama: "ollama-local",
	vllm: "vllm-local",
} as const;

const SEARCH_ONLY_PROVIDER_IDS = ["kagi", "parallel", "tavily"] as const;

describe("Gajae API-key provider parity", () => {
	it("does not advertise search-only services as chat model providers", () => {
		// Given: the complete built-in model-provider catalog.
		const providerIds = builtinProviders().map((provider) => provider.id);

		// When: search-only integration identifiers are compared with model providers.
		const advertisedSearchProviders = SEARCH_ONLY_PROVIDER_IDS.filter((providerId) =>
			providerIds.includes(providerId),
		);

		// Then: none can route a coding-agent chat request to a search API.
		expect(advertisedSearchProviders).toEqual([]);
	});

	it("registers every provider with API-key auth and at least one model", async () => {
		const providers = new Map(builtinProviders().map((provider) => [provider.id, provider]));

		expect([...providers.keys()]).toEqual(expect.arrayContaining([...API_KEY_PROVIDER_IDS]));
		for (const providerId of API_KEY_PROVIDER_IDS) {
			const provider = providers.get(providerId);
			const apiKeyAuth = provider?.auth.apiKey;
			expect(apiKeyAuth).toBeDefined();
			expect(provider?.auth.oauth).toBeUndefined();
			expect(provider?.getModels().length).toBeGreaterThan(0);
			if (!provider || !apiKeyAuth) throw new Error(`Missing provider auth: ${providerId}`);

			const model = provider.getModels()[0];
			if (!model) throw new Error(`Missing provider model: ${providerId}`);
			const envVars: readonly string[] = API_KEY_ENV_VARS[providerId];
			const resolved = await apiKeyAuth.resolve({
				ctx: {
					env: async (name) => (envVars.includes(name) ? "test-key" : undefined),
					fileExists: async () => false,
				},
			});
			expect(resolved?.auth.apiKey).toBe("test-key");
		}
	});

	it("discovers every provider's documented environment variables", () => {
		for (const providerId of API_KEY_PROVIDER_IDS) {
			for (const envVar of API_KEY_ENV_VARS[providerId]) {
				const env = { [envVar]: "test-key" };
				expect(findEnvKeys(providerId, env)).toEqual([envVar]);
				expect(getEnvApiKey(providerId, env)).toBe("test-key");
			}
		}
	});

	it("uses dummy API keys for unauthenticated local servers", async () => {
		const providers = new Map(builtinProviders().map((provider) => [provider.id, provider]));
		for (const [providerId, dummyKey] of Object.entries(LOCAL_DUMMY_KEYS)) {
			expect(getEnvApiKey(providerId, {})).toBe(dummyKey);

			const provider = providers.get(providerId);
			const apiKeyAuth = provider?.auth.apiKey;
			const model = provider?.getModels()[0];
			if (!apiKeyAuth || !model) throw new Error(`Missing local provider: ${providerId}`);
			const resolved = await apiKeyAuth.resolve({
				ctx: { env: async () => undefined, fileExists: async () => false },
			});
			expect(resolved?.auth.apiKey).toBe(dummyKey);
		}
	});
});
