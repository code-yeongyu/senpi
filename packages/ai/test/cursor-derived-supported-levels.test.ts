// senpi#2038: a derived Cursor identity offers exactly the levels the server listed.
import { describe, expect, it } from "vitest";
import { resolveCursorSelectionDescriptor } from "../src/cursor/selection-descriptor.ts";
import { regroupStoredCursorModels } from "../src/cursor/store-migration.ts";
import { clampThinkingLevel, getSupportedThinkingLevels } from "../src/models.ts";
import type { Model, ModelThinkingLevel } from "../src/types.ts";
import fixture from "./fixtures/cursor-usable-models-unlisted-20260923.json" with { type: "json" };

const ALL_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function storedFlat(id: string): Model<"cursor-agent"> {
	return {
		id,
		name: id,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
		compat: {},
	};
}

function derivedModels(): Model<"cursor-agent">[] {
	return regroupStoredCursorModels(fixture.models.map((entry) => storedFlat(entry.id))).filter(
		(model) => model.compat?.cursorReasoning?.variantIds !== undefined,
	);
}

describe("derived Cursor identities: supported levels, clamping, and wire ids (senpi#2038)", () => {
	it("advertises grok-4.7 levels exactly as listed, clamping unlisted ones onto a listed wire id", () => {
		const grok = derivedModels().find((model) => model.id === "grok-4.7");
		if (!grok) throw new Error("expected a derived grok-4.7 identity");

		expect(getSupportedThinkingLevels(grok)).toEqual(["low", "medium", "high", "xhigh"]);
		expect(clampThinkingLevel(grok, "off")).toBe("low");
		expect(clampThinkingLevel(grok, "minimal")).toBe("low");
		expect(clampThinkingLevel(grok, "max")).toBe("xhigh");
		expect(
			resolveCursorSelectionDescriptor(grok, { level: clampThinkingLevel(grok, "off"), source: "explicit" }),
		).toEqual({ modelId: "grok-4.7-low", parameters: [] });
	});

	it("never offers or sends a level the catalog did not list, for every derived family", () => {
		const models = derivedModels();
		expect(models.map((model) => model.id)).toEqual([
			"claude-fable-5-1",
			"claude-fable-5-1-thinking",
			"claude-opus-5-5",
			"gemini-3.8-flash",
			"grok-4.7",
			"muse-spark-1.3",
		]);
		for (const model of models) {
			const variantIds = model.compat?.cursorReasoning?.variantIds ?? {};
			const listed = ALL_LEVELS.filter((level) => variantIds[level] !== undefined);
			expect(getSupportedThinkingLevels(model), model.id).toEqual(listed);
			for (const requested of ALL_LEVELS) {
				const effective = clampThinkingLevel(model, requested);
				expect(listed, `${model.id}:${requested}`).toContain(effective);
				expect(
					resolveCursorSelectionDescriptor(model, { level: effective, source: "explicit" }).modelId,
					`${model.id}:${requested}`,
				).toBe(variantIds[effective]);
			}
		}
	});
});
