import { describe, expect, it } from "vitest";
import { rankModelSearchItems } from "../src/modes/interactive/model-search-rank.ts";

interface FixtureModel {
	provider: string;
	id: string;
	name?: string;
}

function fullId(model: FixtureModel): string {
	return `${model.provider}/${model.id}`;
}

function rankIds(
	models: FixtureModel[],
	query: string,
	options?: { favoritesFirst?: boolean; favorites?: string[] },
): string[] {
	const favorites = new Set(options?.favorites ?? []);
	const ranked = rankModelSearchItems(models, query, (model) => model, {
		favoritesFirst: options?.favoritesFirst ?? false,
		isFavorite: (model) => favorites.has(fullId(model)),
	});
	return ranked.map(fullId);
}

/**
 * Pinned 16-model fixture catalog from the plan's grounding simulation
 * (.omo/plans/model-selector-favorites-search-ux.md, todo 1).
 */
const PINNED_CATALOG: FixtureModel[] = [
	{ provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
	{ provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
	{ provider: "anthropic", id: "claude-opus-4-1", name: "Claude Opus 4.1" },
	{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
	{ provider: "anthropic", id: "claude-fable-5", name: "Claude Fable 5" },
	{ provider: "openrouter", id: "anthropic/claude-opus-5", name: "Anthropic: Claude Opus 5" },
	{ provider: "openrouter", id: "anthropic/claude-opus-4.5", name: "Anthropic: Claude Opus 4.5" },
	{ provider: "openrouter", id: "openai/gpt-5.2", name: "OpenAI: GPT-5.2" },
	{ provider: "quotio-anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
	{ provider: "quotio-openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
	{ provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
	{ provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
	{ provider: "openai", id: "gpt-5-4-mini-fast", name: "GPT 5.4 Mini Fast" },
	{ provider: "google", id: "gemini-3-pro-preview", name: "Gemini 3 Pro Preview" },
	{ provider: "zai", id: "glm-5.2", name: "GLM-5.2" },
	{ provider: "groq", id: "moonshotai/kimi-k3", name: "Kimi K3" },
];

describe("rankModelSearchItems spec cases", () => {
	it("spec 1: 'opus 5' ranks anthropic/claude-opus-5 over 4-5, proxy, and open-pulse-5", () => {
		const models: FixtureModel[] = [
			{ provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
			{ provider: "openrouter", id: "anthropic/claude-opus-5", name: "Anthropic: Claude Opus 5" },
			{ provider: "anthropic", id: "open-pulse-5", name: "Open Pulse 5" },
			{ provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
		];
		expect(rankIds(models, "opus 5")).toEqual([
			"anthropic/claude-opus-5",
			"anthropic/claude-opus-4-5",
			"openrouter/anthropic/claude-opus-5",
			"anthropic/open-pulse-5",
		]);
	});

	it("spec 2: 'anthropic/claude-opus-5' ranks the direct provider over the openrouter proxy", () => {
		const models: FixtureModel[] = [
			{ provider: "openrouter", id: "anthropic/claude-opus-5", name: "Anthropic: Claude Opus 5" },
			{ provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
		];
		expect(rankIds(models, "anthropic/claude-opus-5")).toEqual([
			"anthropic/claude-opus-5",
			"openrouter/anthropic/claude-opus-5",
		]);
	});

	it("spec 3: 'openrouter opus' matches only the openrouter proxy", () => {
		const models: FixtureModel[] = [
			{ provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
			{ provider: "openrouter", id: "anthropic/claude-opus-5", name: "Anthropic: Claude Opus 5" },
		];
		expect(rankIds(models, "openrouter opus")).toEqual(["openrouter/anthropic/claude-opus-5"]);
	});

	it("spec 4: 'opus5' keeps alphanumeric-swap recall for claude-5-opus over claude-sonnet-5", () => {
		const models: FixtureModel[] = [
			{ provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" },
			{ provider: "anthropic", id: "claude-5-opus", name: "Claude 5 Opus" },
		];
		expect(rankIds(models, "opus5")).toEqual(["anthropic/claude-5-opus", "anthropic/claude-sonnet-5"]);
	});

	it("spec 5: 'gpt5' ranks gpt-5 over gpt-4.5", () => {
		const models: FixtureModel[] = [
			{ provider: "openai", id: "gpt-4.5", name: "GPT-4.5" },
			{ provider: "openai", id: "gpt-5", name: "GPT-5" },
		];
		expect(rankIds(models, "gpt5")).toEqual(["openai/gpt-5", "openai/gpt-4.5"]);
	});

	it("spec 6: 'openai/gpt 5 4 mini fast' recalls gpt-5-4-mini-fast", () => {
		const models: FixtureModel[] = [
			{ provider: "openai", id: "gpt-5-4-mini-fast", name: "GPT 5.4 Mini Fast" },
			{ provider: "openai", id: "gpt-5.4", name: "GPT 5.4" },
			{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
		];
		expect(rankIds(models, "openai/gpt 5 4 mini fast")).toEqual(["openai/gpt-5-4-mini-fast"]);
	});

	it("spec 7: 'opus' exact id x/opus beats whole-token claude-opus-5", () => {
		const models: FixtureModel[] = [
			{ provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
			{ provider: "x", id: "opus" },
		];
		expect(rankIds(models, "opus")).toEqual(["x/opus", "anthropic/claude-opus-5"]);
	});

	it("spec 8: 'opus' whole-token claude-opus-5 beats boundary-substring opusmax", () => {
		const models: FixtureModel[] = [
			{ provider: "zai", id: "opusmax", name: "OpusMax" },
			{ provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
		];
		expect(rankIds(models, "opus")).toEqual(["anthropic/claude-opus-5", "zai/opusmax"]);
	});

	it("spec 9: 'opus' boundary-substring opusmax beats substring myopusmodel", () => {
		const models: FixtureModel[] = [
			{ provider: "acme", id: "myopusmodel" },
			{ provider: "zai", id: "opusmax" },
		];
		expect(rankIds(models, "opus")).toEqual(["zai/opusmax", "acme/myopusmodel"]);
	});

	it("spec 10: 'opus' substring myopusmodel beats fuzzy open-pulse", () => {
		const models: FixtureModel[] = [
			{ provider: "acme", id: "open-pulse" },
			{ provider: "acme", id: "myopusmodel" },
		];
		expect(rankIds(models, "opus")).toEqual(["acme/myopusmodel", "acme/open-pulse"]);
	});

	it("spec 11: 'opus 5' favoritesFirst partitions a favorite above an equal non-favorite", () => {
		const models: FixtureModel[] = [
			{ provider: "alpha", id: "claude-opus-5", name: "Claude Opus 5" },
			{ provider: "beta", id: "claude-opus-5", name: "Claude Opus 5" },
		];
		expect(rankIds(models, "opus 5", { favoritesFirst: true, favorites: ["beta/claude-opus-5"] })).toEqual([
			"beta/claude-opus-5",
			"alpha/claude-opus-5",
		]);
	});

	it("spec 12: 'opus 5' with no favorites preserves input order on a full tie", () => {
		const models: FixtureModel[] = [
			{ provider: "alpha", id: "claude-opus-5", name: "Claude Opus 5" },
			{ provider: "beta", id: "claude-opus-5", name: "Claude Opus 5" },
		];
		expect(rankIds(models, "opus 5", { favoritesFirst: true })).toEqual([
			"alpha/claude-opus-5",
			"beta/claude-opus-5",
		]);
	});
});

describe("rankModelSearchItems current-bug regressions (pinned 16-model catalog)", () => {
	it("regression: 'opus' does not rank claude-sonnet-4-5 above claude-opus-5", () => {
		const ranked = rankIds(PINNED_CATALOG, "opus");
		expect(ranked).toContain("anthropic/claude-sonnet-4-5");
		expect(ranked.indexOf("anthropic/claude-opus-5")).toBeLessThan(ranked.indexOf("anthropic/claude-sonnet-4-5"));
	});

	it("regression: 'opus 5' top-1 is anthropic/claude-opus-5", () => {
		expect(rankIds(PINNED_CATALOG, "opus 5")[0]).toBe("anthropic/claude-opus-5");
	});

	it("regression: 'claude-opus-5' direct beats the openrouter proxy", () => {
		const ranked = rankIds(PINNED_CATALOG, "claude-opus-5");
		expect(ranked.indexOf("anthropic/claude-opus-5")).toBeLessThan(
			ranked.indexOf("openrouter/anthropic/claude-opus-5"),
		);
	});

	it("regression: 'anthropic opus' top-1 is anthropic/claude-opus-5", () => {
		expect(rankIds(PINNED_CATALOG, "anthropic opus")[0]).toBe("anthropic/claude-opus-5");
	});
});

describe("rankModelSearchItems query handling", () => {
	it("returns the input unchanged for an empty query", () => {
		const result = rankModelSearchItems(PINNED_CATALOG, "   ", (model) => model, {
			favoritesFirst: true,
			isFavorite: () => false,
		});
		expect(result).toBe(PINNED_CATALOG);
	});
});
