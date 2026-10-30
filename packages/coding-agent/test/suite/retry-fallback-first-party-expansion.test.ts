import type { Api, Model } from "@earendil-works/pi-ai";
import { getProviders } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { canonicalizeFallbackChains } from "../../src/core/retry-fallback/chains.ts";
import * as expansion from "../../src/core/retry-fallback/expansion.ts";

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

/**
 * Registry stand-in. `oauth` providers hold an OAuth credential (tier 0), `apiKey`
 * providers a configured key (tier 1); everything else has no credential.
 */
function lookup(models: Model<Api>[], oauth: string[], apiKey: string[] = []) {
	return {
		getAll: () => models,
		isUsingOAuth: (candidate: Model<Api>) => oauth.includes(candidate.provider),
		hasConfiguredAuth: (candidate: Model<Api>) =>
			oauth.includes(candidate.provider) || apiKey.includes(candidate.provider),
	};
}

/** Every provider serving `id`, the way the builtin catalog republishes popular models. */
function servedBy(id: string, providers: string[]): Model<Api>[] {
	return providers.map((provider) => model(provider, provider === "amazon-bedrock" ? `global.anthropic.${id}` : id));
}

const OPUS55 = "claude-opus-5-5";
const OPUS5 = "claude-opus-5";

const CLAUDE_RESELLERS = ["github-copilot", "amazon-bedrock", "opencode", "venice", "my-custom-proxy"];

const claudeCatalog = [
	...servedBy(OPUS55, ["anthropic-subscription", "anthropic", ...CLAUDE_RESELLERS]),
	...servedBy(OPUS5, ["anthropic-subscription", "anthropic", ...CLAUDE_RESELLERS]),
];

function providersOf(entries: readonly string[] | undefined): string[] {
	return (entries ?? []).map((entry) => entry.slice(0, entry.indexOf("/")));
}

describe("bare fallback entries expand only to the model vendor's first-party providers", () => {
	it("keeps an anthropic-subscription session's bare rung on Anthropic, subscription before API key", () => {
		// Resellers hold OAuth credentials too, so OAuth-first ranking alone would pick them.
		const chains = canonicalizeFallbackChains(
			{ [`anthropic-subscription/${OPUS55}`]: [`${OPUS5}:max`] },
			lookup(
				claudeCatalog,
				["anthropic-subscription", "github-copilot", "my-custom-proxy"],
				["anthropic", "venice"],
			),
		);

		expect(chains[`anthropic-subscription/${OPUS55}`]).toEqual([
			`anthropic-subscription/${OPUS5}:max`,
			`anthropic/${OPUS5}:max`,
		]);
	});

	it("never lands a bare Claude rung on a reseller, gateway or user-added provider", () => {
		const chains = canonicalizeFallbackChains(
			{ [OPUS55]: [`${OPUS5}:max`] },
			lookup(claudeCatalog, CLAUDE_RESELLERS, ["anthropic"]),
		);

		for (const entries of Object.values(chains)) {
			for (const provider of providersOf(entries)) {
				expect(["anthropic-subscription", "anthropic"]).toContain(provider);
			}
		}
	});

	it("attaches a bare chain key only to first-party sessions of that vendor", () => {
		const chains = canonicalizeFallbackChains(
			{ [OPUS55]: [`${OPUS5}:max`] },
			lookup(claudeCatalog, CLAUDE_RESELLERS, ["anthropic"]),
		);

		expect(Object.keys(chains).sort()).toEqual([`anthropic-subscription/${OPUS55}`, `anthropic/${OPUS55}`]);
	});

	it.each([
		{
			vendor: "OpenAI",
			key: "gpt-6-luna",
			entry: "gpt-5.6-sol",
			firstParty: ["chatgpt-subscription", "openai"],
			others: ["github-copilot", "azure-openai-responses", "openrouter", "opencode"],
		},
		{
			vendor: "Google",
			key: "gemini-3.6-flash",
			entry: "gemini-3.1-pro-preview",
			firstParty: ["google", "google-vertex"],
			others: ["github-copilot", "venice", "opencode-go"],
		},
		{
			vendor: "Moonshot",
			key: "kimi-k3.1-pro",
			entry: "kimi-k3",
			firstParty: ["moonshotai"],
			others: ["fireworks", "opencode-go", "venice", "together"],
		},
		{
			vendor: "Z.ai",
			key: "glm-5.3",
			entry: "glm-5.2",
			firstParty: ["zai"],
			others: ["fireworks", "qwen-token-plan", "openrouter"],
		},
	])("scopes a bare $vendor rung to $firstParty", ({ key, entry, firstParty, others }) => {
		const catalog = [...servedBy(key, [...firstParty, ...others]), ...servedBy(entry, [...firstParty, ...others])];
		const chains = canonicalizeFallbackChains(
			{ [`${firstParty[0]}/${key}`]: [entry] },
			lookup(catalog, others, firstParty),
		);

		expect(providersOf(chains[`${firstParty[0]}/${key}`]).sort()).toEqual([...firstParty].sort().slice(0, 2));
	});

	it("still honors a reseller the user names explicitly", () => {
		const chains = canonicalizeFallbackChains(
			{ [`anthropic-subscription/${OPUS55}`]: [`github-copilot/${OPUS5}:max`, `${OPUS5}:max`] },
			lookup(claudeCatalog, ["anthropic-subscription"]),
		);

		expect(chains[`anthropic-subscription/${OPUS55}`]).toEqual([
			`github-copilot/${OPUS5}:max`,
			`anthropic-subscription/${OPUS5}:max`,
			`anthropic/${OPUS5}:max`,
		]);
	});

	describe("a model whose vendor has no first-party entry", () => {
		const catalog = [
			...servedBy("acme-coder-2", ["acme", "my-gateway"]),
			...servedBy("acme-coder-1", ["acme", "my-gateway", "other-reseller"]),
			model("anthropic", OPUS55),
		];

		it("stays on the session's own provider", () => {
			const chains = canonicalizeFallbackChains(
				{ "acme-coder-2": ["acme-coder-1"] },
				lookup(catalog, ["other-reseller"], ["acme", "my-gateway"]),
			);

			expect(chains).toEqual({
				"acme/acme-coder-2": ["acme/acme-coder-1"],
				"my-gateway/acme-coder-2": ["my-gateway/acme-coder-1"],
			});
		});

		it("adds no rung when the session's provider does not serve it", () => {
			const chains = canonicalizeFallbackChains(
				{ [`anthropic/${OPUS55}`]: ["acme-coder-1"] },
				lookup(catalog, ["other-reseller"], ["acme"]),
			);

			expect(chains).toEqual({});
		});
	});

	it("names only providers the builtin catalog or a builtin extension registers", () => {
		const table = (expansion as { FIRST_PARTY_PROVIDERS?: readonly { providers: readonly string[] }[] })
			.FIRST_PARTY_PROVIDERS;
		const known = new Set<string>([...getProviders(), "anthropic-subscription"]);

		expect(table?.length ?? 0).toBeGreaterThan(0);
		for (const { providers } of table ?? []) {
			for (const provider of providers) expect(known.has(provider), provider).toBe(true);
		}
	});
});
