import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { resolveModelScopeFromModels } from "../src/core/model-resolver.ts";
import { mergeFavoritePatternsForPersist } from "../src/modes/interactive/components/model-favorites.ts";

function model(provider: string, id: string): Model<any> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	};
}

const models = [
	model("anthropic", "claude-opus-5"),
	model("anthropic", "claude-sonnet-5"),
	model("anthropic", "claude-haiku-5"),
	model("openai", "gpt-5.5"),
	model("google", "gemini-3-pro"),
];

function merge(storedPatterns: string[], selectedIds: string[] | null, candidateIds: string[]) {
	const { patternResolutions } = resolveModelScopeFromModels(storedPatterns, models);
	return mergeFavoritePatternsForPersist({
		storedPatterns,
		patternResolutions,
		selectedIds,
		candidateIds,
	});
}

describe("favorite model pattern merge", () => {
	test("keeps decorated exact and glob patterns verbatim when an unrelated favorite is toggled", () => {
		const storedPatterns = ["claude-opus-5:xhigh", "gpt-5.5:priority:high", "anthropic/claude-*:high"];

		const merged = merge(
			storedPatterns,
			[
				"anthropic/claude-opus-5",
				"openai/gpt-5.5",
				"anthropic/claude-sonnet-5",
				"anthropic/claude-haiku-5",
				"google/gemini-3-pro",
			],
			models.map((item) => `${item.provider}/${item.id}`),
		);

		expect(merged).toEqual([...storedPatterns, "google/gemini-3-pro"]);
		const liveFavorites = resolveModelScopeFromModels(merged ?? [], models).scopedModels;
		expect(liveFavorites.find((item) => item.model.id === "claude-opus-5")?.thinkingLevel).toBe("xhigh");
		expect(liveFavorites.find((item) => item.model.id === "gpt-5.5")).toMatchObject({
			thinkingLevel: "high",
			serviceTier: "priority",
		});
	});

	test("explodes a partially deselected glob and retains owned models outside the candidate set", () => {
		expect(
			merge(
				["anthropic/claude-*:high"],
				["anthropic/claude-sonnet-5"],
				["anthropic/claude-opus-5", "anthropic/claude-sonnet-5"],
			),
		).toEqual(["anthropic/claude-sonnet-5:high", "anthropic/claude-haiku-5:high"]);
	});

	test("restores the original decorated string after unfavorite and refavorite in one selector session", () => {
		const storedPatterns = ["claude-opus-5:xhigh"];
		const candidateIds = ["anthropic/claude-opus-5"];
		const { patternResolutions } = resolveModelScopeFromModels(storedPatterns, models);

		expect(
			mergeFavoritePatternsForPersist({ storedPatterns, patternResolutions, selectedIds: [], candidateIds }),
		).toBeUndefined();
		expect(
			mergeFavoritePatternsForPersist({
				storedPatterns,
				patternResolutions,
				selectedIds: ["anthropic/claude-opus-5"],
				candidateIds,
			}),
		).toEqual(storedPatterns);
	});

	test("preserves unresolved malformed, empty, and zero-match glob patterns verbatim", () => {
		const storedPatterns = ["malformed:wat", "", "anthropic/missing-*:priority:high"];
		expect(merge(storedPatterns, [], ["anthropic/claude-opus-5"])).toEqual(storedPatterns);
	});

	test("drops later overlapping patterns so a deselection is not resurrected", () => {
		const storedPatterns = ["claude-opus-5:xhigh", "opus"];
		expect(merge(storedPatterns, [], ["anthropic/claude-opus-5"])).toBeUndefined();
		expect(merge(storedPatterns, ["anthropic/claude-opus-5"], ["anthropic/claude-opus-5"])).toEqual([
			"claude-opus-5:xhigh",
		]);
	});

	test("keeps snapshot-owned ids that disappear from the selector and appends newly visible selections bare", () => {
		const storedPatterns = ["claude-opus-5:xhigh"];
		expect(merge(storedPatterns, ["new-provider/new-model"], ["new-provider/new-model"])).toEqual([
			"claude-opus-5:xhigh",
			"new-provider/new-model",
		]);
	});
});

describe("favorite model pattern merge under drifted snapshots", () => {
	const candidateIds = models.map((item) => `${item.provider}/${item.id}`);
	const decorated = ["claude-opus-5:xhigh", "gpt-5.5:priority:high", "anthropic/claude-*:high"];

	/** Resolutions captured against one pattern list, then merged against a drifted stored list. */
	function mergeDrifted(resolvedFrom: string[], storedPatterns: string[], selectedIds: string[] | null) {
		const { patternResolutions } = resolveModelScopeFromModels(resolvedFrom, models);
		return mergeFavoritePatternsForPersist({
			storedPatterns,
			patternResolutions,
			selectedIds,
			candidateIds,
		});
	}

	test("keeps decorators when a pattern is inserted ahead of the snapshot's patterns", () => {
		// settings.json gained a leading entry after the resolutions snapshot was captured,
		// so positional pairing shifts every decorated pattern onto the wrong resolution.
		const merged = mergeDrifted(decorated, ["google/gemini-3-pro", ...decorated], candidateIds);
		expect(merged).toContain("claude-opus-5:xhigh");
		expect(merged).toContain("gpt-5.5:priority:high");
		expect(merged).toContain("anthropic/claude-*:high");
		expect(merged).not.toContain("anthropic/claude-opus-5");
		expect(merged).not.toContain("openai/gpt-5.5");
	});

	test("keeps decorators when a stored pattern is removed from the head", () => {
		const merged = mergeDrifted(["google/gemini-3-pro", ...decorated], decorated, candidateIds);
		expect(merged).toEqual([...decorated, "google/gemini-3-pro"]);
	});

	test("keeps decorators when the stored patterns are reordered", () => {
		const reordered = [decorated[2], decorated[0], decorated[1]];
		const merged = mergeDrifted(decorated, reordered, candidateIds);
		// gemini-3-pro is selected but owned by no stored pattern, so it appends bare -
		// exactly as it does when the snapshot and the stored list are aligned.
		expect(merged).toEqual([...reordered, "google/gemini-3-pro"]);
		const live = resolveModelScopeFromModels(merged ?? [], models).scopedModels;
		expect(live.find((item) => item.model.id === "claude-opus-5")?.thinkingLevel).toBe("high");
		expect(live.find((item) => item.model.id === "gpt-5.5")).toMatchObject({
			thinkingLevel: "high",
			serviceTier: "priority",
		});
	});

	test("appends bare ids only when the resolution snapshot is genuinely empty", () => {
		expect(
			mergeFavoritePatternsForPersist({
				storedPatterns: decorated,
				patternResolutions: [],
				selectedIds: ["anthropic/claude-opus-5"],
				candidateIds,
			}),
		).toEqual(["anthropic/claude-opus-5"]);
	});

	test("duplicate identical stored patterns collapse to one entry, as before", () => {
		expect(merge(["claude-opus-5:xhigh", "claude-opus-5:xhigh"], ["anthropic/claude-opus-5"], candidateIds)).toEqual([
			"claude-opus-5:xhigh",
		]);
		expect(
			merge(
				["anthropic/claude-*:high", "anthropic/claude-*:high"],
				["anthropic/claude-opus-5", "anthropic/claude-sonnet-5", "anthropic/claude-haiku-5"],
				candidateIds,
			),
		).toEqual(["anthropic/claude-*:high"]);
	});
});
