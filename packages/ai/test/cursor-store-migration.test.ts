import { describe, expect, it } from "vitest";
import { regroupStoredCursorModels } from "../src/cursor/store-migration.ts";
import type { Model } from "../src/types.ts";
import fixture from "./fixtures/cursor-usable-models-20260818.json" with { type: "json" };

function legacyModel(id: string): Model<"cursor-agent"> {
	const source = fixture.find((entry) => entry.id === id);
	return {
		id,
		name: source?.name ?? id,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: source?.reasoning ?? false,
		input: (source?.input ?? ["text"]) as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: source?.contextWindow ?? 200000,
		maxTokens: 64000,
	};
}

function groupedModel(): Model<"cursor-agent"> {
	return {
		...legacyModel("kimi-k3"),
		id: "kimi-k3",
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
		compat: {
			cursorReasoning: { capabilityId: "kimi-k3", representativeVariantId: "kimi-k3-high" },
		},
	};
}

describe("regroupStoredCursorModels (C7)", () => {
	it("regroups a full legacy 204-variant store to the grouped catalog shape", () => {
		const legacy = fixture.map((entry) => legacyModel(entry.id));
		const out = regroupStoredCursorModels(legacy);
		expect(out).toHaveLength(113);
		expect(out.filter((model) => model.reasoning)).toHaveLength(32);
		const kimi = out.find((model) => model.id === "kimi-k3");
		expect(kimi?.contextWindow).toBe(1048576);
		expect(kimi?.compat?.cursorReasoning?.capabilityId).toBe("kimi-k3");
	});

	it("is idempotent: applying it twice yields the same list", () => {
		const legacy = fixture.map((entry) => legacyModel(entry.id));
		const once = regroupStoredCursorModels(legacy);
		const twice = regroupStoredCursorModels(once);
		expect(twice.map((model) => model.id)).toEqual(once.map((model) => model.id));
		for (const key of ["thinkingLevelMap", "contextWindow", "maxTokens"] as const) {
			expect(twice.map((model) => JSON.stringify(model[key]))).toEqual(
				once.map((model) => JSON.stringify(model[key])),
			);
		}
	});

	it("handles mixed old/new stores and preserves unknown entries in order", () => {
		const unknown: Model<"cursor-agent"> = { ...legacyModel("zzz-custom-thing"), id: "zzz-custom-thing" };
		const legacyEntry = legacyModel("claude-fable-5-thinking-xhigh");
		const input = [unknown, legacyEntry, groupedModel()];
		const out = regroupStoredCursorModels(input);
		const ids = out.map((model) => model.id);
		expect(ids).toContain("zzz-custom-thing");
		expect(ids).toContain("kimi-k3");
		expect(ids).toContain("claude-fable-5-thinking");
		expect(ids).not.toContain("claude-fable-5-thinking-xhigh");
		const unknownOut = out.find((model) => model.id === "zzz-custom-thing");
		expect(unknownOut?.contextWindow).toBe(200000);
	});

	it("deduplicates repeated legacy ids deterministically", () => {
		const input = [legacyModel("gpt-5.5-extra-high"), legacyModel("gpt-5.5-extra-high")];
		const out = regroupStoredCursorModels(input);
		expect(out).toHaveLength(1);
		expect(out[0]?.id).toBe("gpt-5.5");
	});

	it("keeps retained fast variant identities distinct", () => {
		const out = regroupStoredCursorModels(fixture.map((entry) => legacyModel(entry.id)));
		const fastIds = out.map((model) => model.id).filter((id) => id.endsWith("-fast"));
		expect(fastIds.length).toBeGreaterThan(60);
	});
});
