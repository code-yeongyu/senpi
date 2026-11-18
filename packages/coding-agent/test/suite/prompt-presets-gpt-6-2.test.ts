import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { GPT6_ASTRA_TEXT } from "../../src/core/extensions/builtin/prompt-preset/gpt-6-astra.ts";
import { GPT62_TEXT } from "../../src/core/extensions/builtin/prompt-preset/gpt-6.2.ts";
import { hasGpt62Signal } from "../../src/core/extensions/builtin/prompt-preset/matchers.ts";
import { type PromptPresetSettings, resolvePreset } from "../../src/core/extensions/builtin/prompt-preset/presets.ts";

function createModel(id: string, provider = "openai", api: Api = "openai-responses"): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	};
}

const AUTO: PromptPresetSettings = { promptPreset: "auto" };

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

// senpi#6942: GPT-6.2 Astra and Sol share one guide and one codex template, so both resolve to the
// gpt-6.2 preset ahead of the GPT-6 family signal, and the older family keeps gpt-6-astra.
describe("GPT-6.2 prompt preset", () => {
	it.each([
		{ id: "gpt-6.2-astra", provider: "openai", api: "openai-responses" as const },
		{ id: "gpt-6.2-sol", provider: "openai", api: "openai-responses" as const },
		{ id: "gpt-6.2-astra-fast", provider: "chatgpt-subscription", api: "openai-codex-responses" as const },
		{ id: "gpt-6.2-sol-ultrafast", provider: "chatgpt-subscription", api: "openai-codex-responses" as const },
		{ id: "openai/gpt-6.2-astra", provider: "openrouter", api: "openai-completions" as const },
		{ id: "openai/gpt-6.2-sol-fast", provider: "vercel-ai-gateway", api: "anthropic-messages" as const },
		{ id: "openai-gpt-62-sol", provider: "venice", api: "openai-completions" as const },
		{ id: "GPT-6.2-Astra", provider: "custom", api: "openai-responses" as const },
	])("resolves $provider/$id to gpt-6.2", ({ id, provider, api }) => {
		expect(resolvePreset(createModel(id, provider, api), AUTO)?.name).toBe("gpt-6.2");
	});

	it.each(["GPT-6.2 Astra", "GPT-6.2 Sol"])("resolves the display name %s when the id carries no family", (name) => {
		const model: Model<Api> = { ...createModel("default-model", "custom"), name };
		expect(resolvePreset(model, AUTO)?.name).toBe("gpt-6.2");
	});

	it.each(["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna-fast", "openai-gpt-61-sol", "gpt-6.12-sol"])(
		"keeps %s on gpt-6-astra",
		(id) => {
			expect(resolvePreset(createModel(id), AUTO)?.name).toBe("gpt-6-astra");
		},
	);

	it("renders one prompt for Astra and Sol", () => {
		const astra = resolvePreset(createModel("gpt-6.2-astra"), AUTO)?.prompt;
		const sol = resolvePreset(createModel("gpt-6.2-sol"), AUTO)?.prompt;
		expect(astra).toBeDefined();
		expect(sol).toBe(astra);
	});

	it("renders every replaced text exactly once and drops the GPT-6 Astra writing section", () => {
		const prompt = resolvePreset(createModel("gpt-6.2-sol"), AUTO)?.prompt ?? "";
		for (const text of Object.values(GPT62_TEXT)) {
			expect(occurrences(prompt, text)).toBe(1);
		}
		expect(prompt).not.toContain(GPT6_ASTRA_TEXT.writingStyle);
	});

	it("keeps the older family's prompt free of the 6.2 texts", () => {
		const prompt = resolvePreset(createModel("gpt-6.1-sol"), AUTO)?.prompt ?? "";
		for (const text of Object.values(GPT6_ASTRA_TEXT)) {
			expect(occurrences(prompt, text)).toBe(1);
		}
		expect(prompt).not.toContain(GPT62_TEXT.writingStyle);
	});

	it("is selectable by name in settings for any model", () => {
		expect(resolvePreset(createModel("gpt-6-astra"), { promptPreset: "gpt-6.2" })?.name).toBe("gpt-6.2");
	});

	it("routes every GPT-6.2 catalog row to gpt-6.2", () => {
		const rows = getProviders().flatMap((provider) =>
			getModels(provider).filter((model) => hasGpt62Signal(model.id) || hasGpt62Signal(model.name)),
		);
		expect(rows.map((model) => model.id)).toEqual(expect.arrayContaining(["gpt-6.2-astra", "gpt-6.2-sol"]));
		for (const model of rows) {
			expect(resolvePreset(model, AUTO)?.name, `${model.provider}/${model.id}`).toBe("gpt-6.2");
		}
	});
});
