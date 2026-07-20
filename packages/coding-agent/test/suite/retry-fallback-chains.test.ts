import { getModel } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	baseSelector,
	candidatesAfter,
	canonicalizeFallbackChains,
	formatSelector,
	parseFallbackSelector,
	resolveChainKey,
} from "../../src/core/retry-fallback/chains.ts";

const models = [
	getModel("openai", "gpt-5.4"),
	getModel("anthropic", "claude-sonnet-4-5"),
	{
		...getModel("openai", "gpt-5.4"),
		provider: "openrouter",
		id: "qwen/qwen3-coder:exacto",
		name: "Qwen3 Coder Exacto",
	},
];

describe("fallback chain selectors", () => {
	it("parses case-insensitive selectors and preserves colon-containing model ids", () => {
		expect(parseFallbackSelector("OpenAI/gpt-5.4:HIGH", models)).toMatchObject({
		provider: "openai",
		id: "gpt-5.4",
		thinkingLevel: "high",
	});
		expect(parseFallbackSelector("OPENROUTER/qwen/qwen3-coder:exacto:MAX", models)).toMatchObject({
		provider: "openrouter",
		id: "qwen/qwen3-coder:exacto",
		thinkingLevel: "max",
	});
	});

	it("canonicalizes aliases to a dated-only registry model", () => {
		const datedOnlyModels = [
			{
				...getModel("anthropic", "claude-sonnet-4-5"),
				id: "claude-sonnet-4-5-20250929",
			},
		];

		expect(parseFallbackSelector("anthropic/claude-sonnet-4-5", datedOnlyModels)).toMatchObject({
			provider: "anthropic",
			id: "claude-sonnet-4-5-20250929",
		});
		expect(parseFallbackSelector("anthropic/claude-sonnet-4-5:high", datedOnlyModels)).toMatchObject({
			provider: "anthropic",
			id: "claude-sonnet-4-5-20250929",
			thinkingLevel: "high",
		});
	});

	it("rejects malformed, partial, role, wildcard, unknown, and unsupported selectors", () => {
		for (const selector of ["", "gpt-5.4", "default", "openai/*", "openai/gpt-5.4:invalid", "missing/gpt-5.4"])
			expect(parseFallbackSelector(selector, models)).toBeUndefined();
	});

	it("formats canonical selectors", () => {
		const model = getModel("openai", "gpt-5.4");
		expect(formatSelector(model)).toBe("openai/gpt-5.4");
		expect(formatSelector(model, "high")).toBe("openai/gpt-5.4:high");
		expect(baseSelector({ provider: "openai", id: "gpt-5.4" })).toBe("openai/gpt-5.4");
	});

	it("canonicalizes chain keys and entries at load", () => {
		expect(
		canonicalizeFallbackChains(
			{
				"OpenAI/gpt-5.4:HIGH": ["ANTHROPIC/claude-sonnet-4-5:MAX"],
				default: ["anthropic/claude-sonnet-4-5"],
			},
			models,
		),
		).toEqual({ "openai/gpt-5.4:high": ["anthropic/claude-sonnet-4-5:max"] });
	});

	it("prefers an exact thinking key, then the base key", () => {
		const chains = {
			"openai/gpt-5.4": ["anthropic/claude-sonnet-4-5"],
			"openai/gpt-5.4:high": ["openrouter/qwen/qwen3-coder:exacto:max"],
		};
		const model = getModel("openai", "gpt-5.4");

		expect(resolveChainKey(model, "high", chains)).toBe("openai/gpt-5.4:high");
		expect(resolveChainKey(model, "max", chains)).toBe("openai/gpt-5.4");
	});

	it("returns candidates after the current entry, using base matching when thinking differs", () => {
		const entries = [
			"anthropic/claude-sonnet-4-5:max",
			"openrouter/qwen/qwen3-coder:exacto",
			"openai/gpt-5.4",
		];

		expect(candidatesAfter(entries, "openai/primary:high")).toEqual(entries);
		expect(candidatesAfter(entries, "openai/gpt-5.4:high")).toEqual([]);
		expect(candidatesAfter(entries, "anthropic/claude-sonnet-4-5:high")).toEqual(entries.slice(1));
		expect(candidatesAfter(entries, "unknown/model")).toEqual(entries);
	});
});
