import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { parseModelPattern, resolveModelScopeWithDiagnostics } from "../src/core/model-resolver.ts";

function model(provider: string, id: string, name = id): Model<"anthropic-messages"> {
	return {
		id,
		name,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

const gpt55 = model("openai", "gpt-5.5", "GPT-5.5");
const claudeOpus = model("anthropic", "claude-opus-5", "Claude Opus 5");
const claudeSonnet = model("anthropic", "claude-sonnet-5", "Claude Sonnet 5");
const claudeHaiku = model("anthropic", "claude-haiku-5", "Claude Haiku 5");
const exacto = model("openrouter", "qwen/qwen3-coder:exacto", "Qwen3 Coder Exacto");
// A colon-bearing id that ALSO ends in a decorator-looking suffix: the full-string
// match must win over decorator consumption.
const priorityId = model("openrouter", "vendor/model:priority", "Vendor Model Priority");
const registryModels = [gpt55, claudeOpus, claudeSonnet, claudeHaiku, exacto, priorityId];

const snapshot = { getAvailable: () => registryModels };

describe("baseline: existing model:level parsing (characterization)", () => {
	test("model:level still parses on the unchanged parser", () => {
		const result = parseModelPattern("gpt-5.5:high", registryModels);
		expect(result.model?.id).toBe("gpt-5.5");
		expect(result.thinkingLevel).toBe("high");
		expect(result.serviceTier).toBeUndefined();
		expect(result.warning).toBeUndefined();
	});

	test("colon-bearing model ids match whole before any suffix stripping", () => {
		const result = parseModelPattern("openrouter/qwen/qwen3-coder:exacto", registryModels);
		expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
		expect(result.thinkingLevel).toBeUndefined();
		expect(result.warning).toBeUndefined();
	});

	test("colon-bearing model id plus a level suffix keeps the id intact", () => {
		const result = parseModelPattern("openrouter/qwen/qwen3-coder:exacto:high", registryModels);
		expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
		expect(result.thinkingLevel).toBe("high");
		expect(result.warning).toBeUndefined();
	});

	test("unknown suffix still warns and falls back to the bare model", () => {
		const result = parseModelPattern("gpt-5.5:bogus", registryModels);
		expect(result.model?.id).toBe("gpt-5.5");
		expect(result.thinkingLevel).toBeUndefined();
		expect(result.warning).toContain("Invalid thinking level");
	});
});

describe("service-tier decorators", () => {
	test("model:priority resolves the tier without an invalid-thinking-level warning", () => {
		const result = parseModelPattern("gpt-5.5:priority", registryModels);
		expect(result.model?.id).toBe("gpt-5.5");
		expect(result.serviceTier).toBe("priority");
		expect(result.thinkingLevel).toBeUndefined();
		expect(result.warning).toBeUndefined();
	});

	test("model:tier:level resolves both decorators", () => {
		const result = parseModelPattern("gpt-5.5:priority:high", registryModels);
		expect(result.model?.id).toBe("gpt-5.5");
		expect(result.serviceTier).toBe("priority");
		expect(result.thinkingLevel).toBe("high");
		expect(result.warning).toBeUndefined();
	});

	test("all tier values parse", () => {
		for (const tier of ["auto", "flex", "priority"] as const) {
			const result = parseModelPattern(`gpt-5.5:${tier}`, registryModels);
			expect(result.model?.id).toBe("gpt-5.5");
			expect(result.serviceTier).toBe(tier);
			expect(result.warning).toBeUndefined();
		}
	});

	test("a model id that literally ends in :priority still matches whole (full-string precedence)", () => {
		const result = parseModelPattern("openrouter/vendor/model:priority", registryModels);
		expect(result.model?.id).toBe("vendor/model:priority");
		expect(result.serviceTier).toBeUndefined();
		expect(result.warning).toBeUndefined();
	});

	test("decorators after a colon-bearing id are consumed right-to-left", () => {
		const result = parseModelPattern("openrouter/qwen/qwen3-coder:exacto:flex:max", registryModels);
		expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
		expect(result.serviceTier).toBe("flex");
		expect(result.thinkingLevel).toBe("max");
		expect(result.warning).toBeUndefined();
	});

	test("level:tier order is not accepted as a tier decorator (tier precedes level)", () => {
		const result = parseModelPattern("gpt-5.5:high:priority", registryModels);
		// "priority" is consumed as the tier, "high" is then NOT a tier, so it stays a level.
		expect(result.model?.id).toBe("gpt-5.5");
		expect(result.serviceTier).toBe("priority");
		expect(result.thinkingLevel).toBe("high");
		expect(result.warning).toBeUndefined();
	});

	describe("malformed input", () => {
		test("trailing colon warns and resolves the bare model, no throw", () => {
			const result = parseModelPattern("gpt-5.5:", registryModels);
			expect(result.model?.id).toBe("gpt-5.5");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.serviceTier).toBeUndefined();
			expect(result.warning).toContain("Invalid thinking level");
		});

		test("leading colon keeps the pre-existing empty-prefix behavior and never throws", () => {
			// An empty prefix partial-matches every model today; the decorator grammar must
			// not change that, only refrain from inventing a tier.
			const result = parseModelPattern(":high", registryModels);
			expect(result.model).toBeDefined();
			expect(result.thinkingLevel).toBe("high");
			expect(result.serviceTier).toBeUndefined();
			expect(result.warning).toBeUndefined();

			// ":priority" partial-matches the model whose id literally contains ":priority",
			// so full-string precedence resolves it before any decorator is consumed.
			const tierOnly = parseModelPattern(":priority", registryModels);
			expect(tierOnly.model?.id).toBe("vendor/model:priority");
			expect(tierOnly.serviceTier).toBeUndefined();
			expect(tierOnly.warning).toBeUndefined();

			// Without such a model in the snapshot, the tier decorator is consumed and the
			// empty prefix falls back to partial matching — still no throw.
			const tierOnlyClean = parseModelPattern(":priority", [gpt55]);
			expect(tierOnlyClean.model?.id).toBe("gpt-5.5");
			expect(tierOnlyClean.serviceTier).toBe("priority");
			expect(tierOnlyClean.warning).toBeUndefined();
		});

		test("model:bogus:high keeps the level and warns about the unknown segment", () => {
			const result = parseModelPattern("gpt-5.5:bogus:high", registryModels);
			expect(result.model?.id).toBe("gpt-5.5");
			expect(result.serviceTier).toBeUndefined();
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toContain("Invalid thinking level");
		});

		test("model:priority:bogus warns and drops both decorators", () => {
			const result = parseModelPattern("gpt-5.5:priority:bogus", registryModels);
			expect(result.model?.id).toBe("gpt-5.5");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toContain("Invalid thinking level");
		});
	});
});

describe("pattern ownership metadata", () => {
	test("exact pattern reports its owned canonical id and decorators", async () => {
		const result = await resolveModelScopeWithDiagnostics(["gpt-5.5:priority:high"], snapshot);

		expect(result.patternResolutions).toEqual([
			{
				pattern: "gpt-5.5:priority:high",
				ownedIds: ["openai/gpt-5.5"],
				thinkingLevel: "high",
				serviceTier: "priority",
				unresolved: false,
				isGlob: false,
			},
		]);
		expect(result.scopedModels[0].serviceTier).toBe("priority");
		expect(result.scopedModels[0].thinkingLevel).toBe("high");
	});

	test("glob pattern owns every registry model it matched", async () => {
		const result = await resolveModelScopeWithDiagnostics(["anthropic/claude-*:high"], snapshot);

		expect(result.patternResolutions).toHaveLength(1);
		const resolution = result.patternResolutions[0];
		expect(resolution.pattern).toBe("anthropic/claude-*:high");
		expect(resolution.isGlob).toBe(true);
		expect(resolution.unresolved).toBe(false);
		expect(resolution.thinkingLevel).toBe("high");
		expect(resolution.serviceTier).toBeUndefined();
		expect(resolution.ownedIds).toEqual([
			"anthropic/claude-opus-5",
			"anthropic/claude-sonnet-5",
			"anthropic/claude-haiku-5",
		]);
	});

	test("glob decorated with a tier reports the tier on scoped models and metadata", async () => {
		const result = await resolveModelScopeWithDiagnostics(["anthropic/claude-*:priority:high"], snapshot);

		expect(result.patternResolutions[0].serviceTier).toBe("priority");
		expect(result.patternResolutions[0].thinkingLevel).toBe("high");
		expect(result.scopedModels.every((scoped) => scoped.serviceTier === "priority")).toBe(true);
	});

	test("first-pattern-wins dedupe keeps ownership with the first pattern", async () => {
		const result = await resolveModelScopeWithDiagnostics(
			["anthropic/claude-opus-5:high", "anthropic/claude-*"],
			snapshot,
		);

		expect(result.patternResolutions[0].ownedIds).toEqual(["anthropic/claude-opus-5"]);
		expect(result.patternResolutions[1].ownedIds).toEqual(["anthropic/claude-sonnet-5", "anthropic/claude-haiku-5"]);
		expect(result.patternResolutions[1].unresolved).toBe(false);
	});

	test("unresolved patterns pass through as unresolved with no owned ids", async () => {
		const result = await resolveModelScopeWithDiagnostics(["openrouter/does-not-exist", "gpt-5.5"], snapshot);

		expect(result.patternResolutions[0]).toEqual({
			pattern: "openrouter/does-not-exist",
			ownedIds: [],
			thinkingLevel: undefined,
			serviceTier: undefined,
			unresolved: true,
			isGlob: false,
		});
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("no-match");
		expect(result.patternResolutions[1].unresolved).toBe(false);
	});

	test("unresolved glob patterns are reported unresolved, not dropped", async () => {
		const result = await resolveModelScopeWithDiagnostics(["nope/nothing-*"], snapshot);

		expect(result.patternResolutions[0].isGlob).toBe(true);
		expect(result.patternResolutions[0].unresolved).toBe(true);
		expect(result.patternResolutions[0].ownedIds).toEqual([]);
	});

	test("ownership metadata reflects the current registry snapshot, not a cached one", async () => {
		let models = [gpt55];
		const mutableSnapshot = { getAvailable: () => models };

		const before = await resolveModelScopeWithDiagnostics(["anthropic/claude-*"], mutableSnapshot);
		expect(before.patternResolutions[0].unresolved).toBe(true);

		models = registryModels;
		const after = await resolveModelScopeWithDiagnostics(["anthropic/claude-*"], mutableSnapshot);
		expect(after.patternResolutions[0].ownedIds).toEqual([
			"anthropic/claude-opus-5",
			"anthropic/claude-sonnet-5",
			"anthropic/claude-haiku-5",
		]);
	});
});
