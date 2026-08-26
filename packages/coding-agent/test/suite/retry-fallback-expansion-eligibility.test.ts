import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { canonicalizeFallbackChains } from "../../src/core/retry-fallback/chains.ts";
import { DEFAULT_FALLBACK_CHAINS } from "../../src/core/retry-fallback/settings.ts";

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

/** Registry stand-in with a deterministic per-provider eligibility gate. */
function lookup(models: Model<Api>[], oauthProviders: string[] = [], ineligible: string[] = []) {
	return {
		getAll: () => models,
		isUsingOAuth: (candidate: Model<Api>) => oauthProviders.includes(candidate.provider),
		hasConfiguredAuth: () => true,
		isFallbackEligible: (candidate: Model<Api>) => !ineligible.includes(candidate.provider),
	};
}

const catalog = [
	model("anthropic", FABLE),
	model("anthropic", OPUS5),
	model("claude-sdk-oauth", OPUS5),
	model("cursor-cli-oauth", OPUS5),
	model("kimi-coding", "k3"),
];

describe("bare expansion eligibility gate", () => {
	it("excludes a provider whose registration declares the lane unusable, even with an OAuth credential", () => {
		// The regression shape: cursor-cli-oauth holds an OAuth credential (tier 0,
		// ranked first) but its unacknowledged --force gate guarantees a refusal.
		// Ranking alone would hand it a top expansion slot it can never serve.
		const chains = canonicalizeFallbackChains(
			DEFAULT_FALLBACK_CHAINS,
			lookup(catalog, ["cursor-cli-oauth"], ["cursor-cli-oauth"]),
		);

		const entries = chains[`anthropic/${FABLE}`] ?? [];
		expect(entries.length).toBeGreaterThan(0);
		expect(entries.some((entry) => entry.startsWith("cursor-cli-oauth/"))).toBe(false);
		// The freed slot goes to a provider that can actually serve.
		expect(entries.some((entry) => entry.includes(OPUS5))).toBe(true);
	});

	it("keeps every provider when the gate reports eligible", () => {
		const chains = canonicalizeFallbackChains(DEFAULT_FALLBACK_CHAINS, lookup(catalog, ["cursor-cli-oauth"]));

		const entries = chains[`anthropic/${FABLE}`] ?? [];
		expect(entries.some((entry) => entry.startsWith("cursor-cli-oauth/"))).toBe(true);
	});

	it("keeps providers when the registry exposes no eligibility gate", () => {
		const chains = canonicalizeFallbackChains(DEFAULT_FALLBACK_CHAINS, {
			getAll: () => catalog,
			isUsingOAuth: (candidate: Model<Api>) => candidate.provider === "cursor-cli-oauth",
		});

		const entries = chains[`anthropic/${FABLE}`] ?? [];
		expect(entries.some((entry) => entry.startsWith("cursor-cli-oauth/"))).toBe(true);
	});
});
