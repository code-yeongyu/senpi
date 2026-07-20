import { type Api, getModel, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { validateFallbackChains } from "../../src/core/retry-fallback/validate.ts";
import { createHarness } from "./harness.ts";

const primary = getModel("openai", "gpt-5.4");
const fallback = getModel("anthropic", "claude-sonnet-4-5");
const nonReasoningFallback: Model<Api> = { ...fallback, provider: "test", id: "no-reasoning", reasoning: false };
const models = [primary, fallback, nonReasoningFallback];
const registry = {
	find(provider: string, id: string): Model<Api> | undefined {
		return models.find((model) => model.provider === provider && model.id === id);
	},
	getAll(): Model<Api>[] {
		return models;
	},
};

describe("validateFallbackChains", () => {
	it("exposes the warnings calculated when the session starts", async () => {
		const harness = await createHarness({
			settings: { retry: { fallbackChains: { smol: ["faux/faux-1"] } } },
		});
		try {
			expect(harness.session.fallbackValidationWarnings).toEqual([
				'Fallback chain key "smol" must use a provider/model selector; roles are unsupported.',
			]);
		} finally {
			harness.cleanup();
		}
	});

	it.each([
		{
			name: "non-object values",
			chains: null,
			warnings: ["Fallback chains must be a plain object."],
		},
		{
			name: "arrays and nested garbage",
			chains: ["openai/gpt-5.4"],
			warnings: ["Fallback chains must be a plain object."],
		},
		{
			name: "role and wildcard keys",
			chains: { default: [], "openai/*": [] },
			warnings: [
				'Fallback chain key "default" must use a provider/model selector; roles are unsupported.',
				'Fallback chain "default" must contain at least one entry.',
				'Fallback chain key "openai/*" cannot contain wildcards.',
				'Fallback chain "openai/*" must contain at least one entry.',
			],
		},
		{
			name: "invalid and unknown selectors",
			chains: {
				"openai/missing": ["anthropic/missing", "not a selector"],
			},
			warnings: [
				'Fallback chain key "openai/missing" is not a valid or known model selector.',
				'Fallback chain entry "anthropic/missing" for "openai/missing" is not a valid or known model selector.',
				'Fallback chain entry "not a selector" for "openai/missing" is not a valid or known model selector.',
			],
		},
		{
			name: "non-string and empty entry lists",
			chains: {
				"openai/gpt-5.4": ["anthropic/claude-sonnet-4-5", 42],
				"anthropic/claude-sonnet-4-5": [],
				"test/no-reasoning": "anthropic/claude-sonnet-4-5",
			},
			warnings: [
				'Fallback chain "openai/gpt-5.4" entries must be an array of strings.',
				'Fallback chain "anthropic/claude-sonnet-4-5" must contain at least one entry.',
				'Fallback chain "test/no-reasoning" entries must be an array of strings.',
			],
		},
		{
			name: "self-references and unsupported thinking",
			chains: {
				"openai/gpt-5.4": ["openai/gpt-5.4:high", "test/no-reasoning:high"],
			},
			warnings: [
				'Fallback chain entry "openai/gpt-5.4:high" for "openai/gpt-5.4" cannot reference the same model.',
				'Fallback chain entry "test/no-reasoning:high" uses thinking level "high", which is unsupported by test/no-reasoning.',
			],
		},
		{
			name: "clean configurations",
			chains: {
				"openai/gpt-5.4": ["anthropic/claude-sonnet-4-5:high"],
			},
			warnings: [],
		},
	] as const)("warns for $name", ({ chains, warnings }) => {
		expect(validateFallbackChains(chains, registry)).toEqual(warnings);
	});
});
