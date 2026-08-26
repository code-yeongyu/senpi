import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	parseModelPattern,
	resolveModelScopeFromModels,
	resolveStoredModelReference,
} from "../src/core/model-resolver.ts";

function model(provider: string, id: string, reasoning = true): Model<string> {
	return {
		id,
		name: id,
		api: provider === "cursor" ? "cursor-agent" : "cursor-cli-oauth",
		provider,
		baseUrl: "https://example.invalid",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 64000,
	};
}

const cursorModels = [
	model("cursor", "gpt-5.5"),
	model("cursor", "claude-opus-5"),
	model("cursor", "claude-opus-5-thinking"),
	model("cursor", "composer-2.5-fast", false),
	model("cursor-cli-oauth", "gpt-5.5"),
	model("cursor-cli-oauth", "claude-opus-5"),
	model("cursor-cli-oauth", "claude-opus-5-thinking"),
];

describe("legacy Cursor exact-id resolution", () => {
	it("projects an exact variant to the grouped identity with legacy provenance", () => {
		const result = parseModelPattern("cursor/gpt-5.5-high", cursorModels);
		expect(result.model).toMatchObject({ provider: "cursor", id: "gpt-5.5" });
		expect(result.thinkingLevel).toBe("high");
		expect(result.thinkingSelection).toEqual({
			level: "high",
			source: "legacy-variant",
			legacyVariantId: "gpt-5.5-high",
		});
	});

	it("selects the correct Claude boolean identity and maps none to off", () => {
		expect(parseModelPattern("cursor/claude-opus-5-thinking-high", cursorModels)).toMatchObject({
			model: { provider: "cursor", id: "claude-opus-5-thinking" },
			thinkingLevel: "high",
			thinkingSelection: {
				level: "high",
				source: "legacy-variant",
				legacyVariantId: "claude-opus-5-thinking-high",
			},
		});
		expect(parseModelPattern("cursor/gpt-5.5-none", cursorModels).thinkingSelection).toEqual({
			level: "off",
			source: "legacy-variant",
			legacyVariantId: "gpt-5.5-none",
		});
	});

	it("preserves the provider lane and never projects across providers", () => {
		expect(parseModelPattern("cursor-cli-oauth/gpt-5.5-high", cursorModels).model).toMatchObject({
			provider: "cursor-cli-oauth",
			id: "gpt-5.5",
		});
		expect(parseModelPattern("cursor/gpt-5.5-high", cursorModels).model?.provider).toBe("cursor");
	});

	it("uses the same projection for stored model_change and assistant-history references", () => {
		const runtime = {
			getModel: (provider: string, id: string) =>
				cursorModels.find((candidate) => candidate.provider === provider && candidate.id === id),
		};
		const restored = resolveStoredModelReference("cursor", "claude-opus-5-thinking-high", runtime);
		expect(restored).toMatchObject({
			model: { provider: "cursor", id: "claude-opus-5-thinking" },
			thinkingSelection: {
				level: "high",
				source: "legacy-variant",
				legacyVariantId: "claude-opus-5-thinking-high",
			},
		});
	});
});

describe("legacy Cursor wildcard projection", () => {
	it("projects broad legacy aliases without narrowing to retained fast ids", () => {
		const result = resolveModelScopeFromModels(["cursor/gpt-5.5-*"], cursorModels);
		expect(result.scopedModels.map((entry) => entry.model.id)).toEqual(["gpt-5.5"]);
		expect(result.scopedModels[0].thinkingSelection).toBeUndefined();
	});

	it("attaches legacy provenance when every projected alias agrees on one level", () => {
		const result = resolveModelScopeFromModels(["cursor/*-none"], cursorModels);
		expect(result.scopedModels).toEqual([
			expect.objectContaining({
				model: expect.objectContaining({ provider: "cursor", id: "gpt-5.5" }),
				thinkingLevel: "off",
				thinkingSelection: {
					level: "off",
					source: "legacy-variant",
					legacyVariantId: "gpt-5.5-none",
				},
			}),
		]);
	});

	it("projects Claude thinking globs to only the thinking identity", () => {
		const result = resolveModelScopeFromModels(["cursor/claude-*-thinking-*"], cursorModels);
		expect(result.scopedModels.map((entry) => entry.model.id)).toEqual(["claude-opus-5-thinking"]);
	});

	it("keeps fast ids raw and lets an explicit decorator win", () => {
		const fast = resolveModelScopeFromModels(["cursor/*-fast"], cursorModels);
		expect(fast.scopedModels).toEqual([
			expect.objectContaining({
				model: expect.objectContaining({ id: "composer-2.5-fast" }),
				thinkingSelection: undefined,
			}),
		]);

		const explicit = resolveModelScopeFromModels(["cursor/gpt-5.5-*:xhigh"], cursorModels);
		expect(explicit.scopedModels[0]).toMatchObject({
			thinkingLevel: "xhigh",
			thinkingSelection: { level: "xhigh", source: "explicit" },
		});
	});
});
