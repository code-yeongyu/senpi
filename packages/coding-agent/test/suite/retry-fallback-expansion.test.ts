import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { canonicalizeFallbackChains } from "../../src/core/retry-fallback/chains.ts";
import { DEFAULT_FALLBACK_CHAINS, resolveRetryFallbackSettings } from "../../src/core/retry-fallback/settings.ts";

function model(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "faux",
		baseUrl: "https://models.example.test/v1",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		input: ["text"],
		contextWindow: 1,
		maxTokens: 1,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

const FABLE = "claude-fable-5";
const OPUS5 = "claude-opus-5";
const OPUS48 = "claude-opus-4-8";

/** Registry stand-in: `oauthProviders` marks which providers hold an OAuth credential. */
function lookup(models: Model<Api>[], oauthProviders: string[] = [], unauthenticated: string[] = []) {
	return {
		getAll: () => models,
		isUsingOAuth: (candidate: Model<Api>) => oauthProviders.includes(candidate.provider),
		hasConfiguredAuth: (candidate: Model<Api>) => !unauthenticated.includes(candidate.provider),
	} as {
		getAll(): Model<Api>[];
		isUsingOAuth(model: Model<Api>): boolean;
		hasConfiguredAuth(model: Model<Api>): boolean;
	};
}

const sdkAndAnthropic = [
	model("claude-sdk-oauth", FABLE),
	model("claude-sdk-oauth", OPUS5),
	model("claude-sdk-oauth", OPUS48),
	model("anthropic", FABLE),
	model("anthropic", OPUS5),
	model("anthropic", OPUS48),
	model("kimi-coding", "k3"),
	model("kimi-coding", "k3-256k"),
];

describe("bare model-id family expansion", () => {
	it("ships a provider-agnostic default chain with bare model ids", () => {
		expect(DEFAULT_FALLBACK_CHAINS).toEqual({
			[FABLE]: ["k3:max", `${OPUS5}:xhigh`, `${OPUS48}:xhigh`],
		});
	});

	it("expands a bare key into one canonical key per serving provider", () => {
		const chains = canonicalizeFallbackChains(DEFAULT_FALLBACK_CHAINS, lookup(sdkAndAnthropic));

		expect(Object.keys(chains).sort()).toEqual([`anthropic/${FABLE}`, `claude-sdk-oauth/${FABLE}`]);
	});

	it("ranks OAuth-credential providers ahead of API-key providers for bare candidates", () => {
		const chains = canonicalizeFallbackChains(DEFAULT_FALLBACK_CHAINS, lookup(sdkAndAnthropic, ["anthropic"]));

		// anthropic holds the OAuth credential here, so it outranks the sdk provider
		// even though the tie-break table would otherwise prefer claude-sdk-oauth.
		expect(chains[`claude-sdk-oauth/${FABLE}`]?.slice(0, 3)).toEqual([
			"kimi-coding/k3:max",
			`anthropic/${OPUS5}:xhigh`,
			`claude-sdk-oauth/${OPUS5}:xhigh`,
		]);
	});

	it("breaks ties with the fixed provider table when no provider holds OAuth", () => {
		const chains = canonicalizeFallbackChains(DEFAULT_FALLBACK_CHAINS, lookup(sdkAndAnthropic));

		expect(chains[`anthropic/${FABLE}`]).toEqual([
			"kimi-coding/k3:max",
			`claude-sdk-oauth/${OPUS5}:xhigh`,
			`anthropic/${OPUS5}:xhigh`,
			`claude-sdk-oauth/${OPUS48}:xhigh`,
			`anthropic/${OPUS48}:xhigh`,
		]);
	});

	it("keeps model-major ordering so every provider for one model precedes the next model", () => {
		const chains = canonicalizeFallbackChains(DEFAULT_FALLBACK_CHAINS, lookup(sdkAndAnthropic));
		const entries = chains[`anthropic/${FABLE}`] ?? [];
		const lastOpus5 = entries.findLastIndex((entry) => entry.includes(OPUS5));
		const firstOpus48 = entries.findIndex((entry) => entry.includes(OPUS48));

		expect(lastOpus5).toBeLessThan(firstOpus48);
	});

	it("prefers the exact model id over a longer family variant inside one provider", () => {
		const chains = canonicalizeFallbackChains(DEFAULT_FALLBACK_CHAINS, lookup(sdkAndAnthropic));

		expect(chains[`anthropic/${FABLE}`]?.[0]).toBe("kimi-coding/k3:max");
		expect(chains[`anthropic/${FABLE}`]).not.toContain("kimi-coding/k3-256k:max");
	});

	it("matches namespaced provider ids by family without substring false positives", () => {
		const models = [
			model("amazon-bedrock", `global.anthropic.${FABLE}`),
			model("amazon-bedrock", `global.anthropic.${OPUS5}`),
			model("other", `not-${FABLE}`),
		];
		const chains = canonicalizeFallbackChains(DEFAULT_FALLBACK_CHAINS, lookup(models));

		expect(Object.keys(chains)).toEqual([`amazon-bedrock/global.anthropic.${FABLE}`]);
		expect(chains[`amazon-bedrock/global.anthropic.${FABLE}`]).toEqual([
			`amazon-bedrock/global.anthropic.${OPUS5}:xhigh`,
		]);
	});

	it("never expands a bare selector onto openrouter", () => {
		const models = [
			model("openrouter", `anthropic/${FABLE}`),
			model("openrouter", `anthropic/${OPUS5}`),
			model("anthropic", FABLE),
			model("anthropic", OPUS5),
		];
		const chains = canonicalizeFallbackChains(DEFAULT_FALLBACK_CHAINS, lookup(models));

		expect(Object.keys(chains)).toEqual([`anthropic/${FABLE}`]);
		expect(chains[`anthropic/${FABLE}`]).toEqual([`anthropic/${OPUS5}:xhigh`]);
	});

	it("still honors an explicit openrouter selector written by the user", () => {
		const models = [model("anthropic", FABLE), model("openrouter", "qwen/qwen3-coder:exacto")];
		const chains = canonicalizeFallbackChains(
			{ [`anthropic/${FABLE}`]: ["openrouter/qwen/qwen3-coder:exacto:max"] },
			lookup(models),
		);

		expect(chains).toEqual({ [`anthropic/${FABLE}`]: ["openrouter/qwen/qwen3-coder:exacto:max"] });
	});

	it("drops a bare key whose family no provider serves", () => {
		const chains = canonicalizeFallbackChains(DEFAULT_FALLBACK_CHAINS, lookup([model("openai", "gpt-5.4")]));

		expect(chains).toEqual({});
	});

	it("never lists the key model itself as its own candidate", () => {
		const chains = canonicalizeFallbackChains({ [FABLE]: [FABLE, `${OPUS5}:xhigh`] }, lookup(sdkAndAnthropic));

		for (const [key, entries] of Object.entries(chains)) {
			expect(entries).not.toContain(key);
		}
	});
});

describe("bare-key opt-out tombstones", () => {
	it("removes the shipped default when the user empties the bare key", () => {
		const resolved = resolveRetryFallbackSettings({ fallbackChains: { [FABLE]: [] } });

		expect(canonicalizeFallbackChains(resolved.chains, lookup(sdkAndAnthropic))).toEqual({});
	});

	it("removes only one provider variant when the user empties a canonical key", () => {
		const resolved = resolveRetryFallbackSettings({ fallbackChains: { [`anthropic/${FABLE}`]: [] } });
		const chains = canonicalizeFallbackChains(resolved.chains, lookup(sdkAndAnthropic));

		expect(Object.keys(chains)).toEqual([`claude-sdk-oauth/${FABLE}`]);
	});

	it("lets an explicit canonical chain override the expanded default for that provider only", () => {
		const resolved = resolveRetryFallbackSettings({
			fallbackChains: { [`anthropic/${FABLE}`]: [`anthropic/${OPUS48}:max`] },
		});
		const chains = canonicalizeFallbackChains(resolved.chains, lookup(sdkAndAnthropic));

		expect(chains[`anthropic/${FABLE}`]).toEqual([`anthropic/${OPUS48}:max`]);
		expect(chains[`claude-sdk-oauth/${FABLE}`]?.[0]).toBe("kimi-coding/k3:max");
	});
});

describe("expansion stays scoped to models the user can actually use", () => {
	const catalog = [
		model("claude-sdk-oauth", FABLE),
		model("claude-sdk-oauth", OPUS5),
		model("anthropic", FABLE),
		model("anthropic", OPUS5),
		model("github-copilot", FABLE),
		model("github-copilot", OPUS5),
		model("opencode", FABLE),
		model("opencode", OPUS5),
		model("cloudflare-ai-gateway", FABLE),
		model("cloudflare-ai-gateway", OPUS5),
		model("kimi-coding", "k3"),
	];

	it("prefers authenticated providers over unauthenticated ones for bare candidates", () => {
		const unauthenticated = ["github-copilot", "opencode", "cloudflare-ai-gateway"];
		const chains = canonicalizeFallbackChains(DEFAULT_FALLBACK_CHAINS, lookup(catalog, [], unauthenticated));

		// Ranking, never filtering: an unauthenticated provider must not outrank a
		// configured one, but the chain still exists when availability is unknown.
		for (const entries of Object.values(chains)) {
			for (const provider of unauthenticated) {
				expect(entries.some((entry) => entry.startsWith(`${provider}/`))).toBe(false);
			}
		}
	});

	it("still expands when no provider reports configured auth yet", () => {
		const chains = canonicalizeFallbackChains(
			DEFAULT_FALLBACK_CHAINS,
			lookup(
				catalog,
				[],
				catalog.map((m) => m.provider),
			),
		);

		expect(Object.keys(chains).length).toBeGreaterThan(0);
	});

	it("caps how many providers one bare candidate fans out to", () => {
		const chains = canonicalizeFallbackChains(DEFAULT_FALLBACK_CHAINS, lookup(catalog));
		const entries = chains[`anthropic/${FABLE}`] ?? [];
		const opus5Providers = entries.filter((entry) => entry.includes(OPUS5));

		// A shipped default must stay a short, readable chain rather than every
		// provider in the builtin catalog that happens to publish the model.
		expect(opus5Providers.length).toBeLessThanOrEqual(2);
		expect(entries.length).toBeLessThanOrEqual(5);
	});
});
