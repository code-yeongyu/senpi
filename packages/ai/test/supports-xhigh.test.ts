import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getModel, getSupportedThinkingLevels, supportsMax, supportsXhigh } from "../src/compat.ts";
import type { Model } from "../src/model.ts";
import type { Api } from "../src/types.ts";
import {
	FIXTURE_MAX_MODEL_ID,
	FIXTURE_NO_MAX_MODEL_ID,
	installMaxEffortFixtureCatalog,
} from "./fixture-model-catalog.ts";

installMaxEffortFixtureCatalog();

/** A custom-provider model with no thinkingLevelMap unless supplied in overrides. */
function maplessModel<TApi extends Api>(api: TApi, id: string, overrides: Partial<Model<TApi>> = {}): Model<TApi> {
	return {
		id,
		name: id,
		api,
		provider: "codex-lb",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
		...overrides,
	};
}

describe("getSupportedThinkingLevels", () => {
	it("includes max but not xhigh for Anthropic Opus 4.6 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-opus-4-6");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("max");
		expect(getSupportedThinkingLevels(model!)).not.toContain("xhigh");
	});

	it("includes xhigh and max for Anthropic Opus 4.8 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).toContain("max");
	});

	it("includes xhigh and max for Anthropic Opus 5 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-opus-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).toContain("max");
	});

	it("includes Claude Opus 5.5 with its always-on effort levels and official pricing", () => {
		const model = getModel("anthropic", "claude-opus-5-5");
		expect(model).toMatchObject({
			cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			compat: {
				forceAdaptiveThinking: true,
				supportsMidConvoEffort: true,
				supportsMidConvoSystemMessages: true,
				supportsMidConvoToolChanges: true,
			},
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});

	it("includes Claude Sonnet 5.5 with managed effort levels and official pricing", () => {
		const model = getModel("anthropic", "claude-sonnet-5-5");
		expect(model).toMatchObject({
			cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			compat: {
				forceAdaptiveThinking: true,
				supportsMidConvoEffort: true,
				supportsMidConvoSystemMessages: true,
				supportsMidConvoToolChanges: true,
				supportsTemperature: false,
			},
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});

	it("includes max but not xhigh for Anthropic Sonnet 4.6 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-sonnet-4-6");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("max");
		expect(getSupportedThinkingLevels(model!)).not.toContain("xhigh");
	});

	it("includes xhigh and max for Anthropic Sonnet 5 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-sonnet-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).toContain("max");
	});

	it("includes off, xhigh and max for Anthropic Claude Fable 5 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-fable-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).toContain("max");
		// Fable 5 rejects `thinking.type: "disabled"`, but "off" is still a real user choice:
		// the Messages provider pins the cheapest effort instead of sending a thinking block.
		expect(getSupportedThinkingLevels(model!)).toContain("off");
	});

	it("does not include xhigh or max for Claude Sonnet 4.5", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).not.toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).not.toContain("max");
	});

	it.each([
		"gpt-5.5",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-5.6-luna",
		"gpt-6-astra",
		"gpt-6-sol",
		"gpt-6-luna",
		"gpt-6.1-sol",
	] as const)("includes xhigh for openai-codex %s models", (modelId) => {
		const model = getModel("chatgpt-subscription", modelId);
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
	});

	it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const)(
		"includes xhigh and max for OpenAI %s models",
		(modelId) => {
			const model = getModel("openai", modelId);
			expect(model).toBeDefined();
			expect(getSupportedThinkingLevels(model!)).toEqual([
				"off",
				"minimal",
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
			]);
		},
	);

	// The fork GPT-6 ladder has no minimal effort (gpt-6-family-catalog.test.ts).
	it.each(["gpt-6-sol", "gpt-6-luna"] as const)(
		"includes xhigh and max without minimal for OpenAI %s models",
		(modelId) => {
			const model = getModel("openai", modelId);
			expect(model).toBeDefined();
			expect(getSupportedThinkingLevels(model!)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
		},
	);

	// OpenAI and Codex reject reasoning.effort "none" for GPT-6.1 Sol.
	it("does not support off for GPT-6.1 Sol", () => {
		const expected = {
			openai: ["low", "medium", "high", "xhigh", "max"],
			"azure-openai-responses": ["low", "medium", "high", "xhigh", "max"],
			"chatgpt-subscription": ["low", "medium", "high", "xhigh", "max"],
		} as const;
		for (const [provider, levels] of Object.entries(expected)) {
			const model = getModel(provider as keyof typeof expected, "gpt-6.1-sol");
			expect(model).toBeDefined();
			expect(getSupportedThinkingLevels(model!)).toEqual(levels);
			expect(model!.thinkingLevelMap?.off).toBeNull();
		}
	});

	it.each([
		// Fork context windows: Sol and 6.1 Sol 400k, Luna the full 922k input cap (gpt-6-family-catalog.test.ts).
		["gpt-6-sol", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, 400000],
		["gpt-6-luna", { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }, 922000],
		["gpt-6.1-sol", { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, 400000],
	] as const)("includes official metadata for OpenAI and Codex %s", (modelId, cost, contextWindow) => {
		for (const provider of ["openai", "chatgpt-subscription"] as const) {
			const model = getModel(provider, modelId);
			expect(model).toMatchObject({
				input: ["text", "image"],
				cost: {
					...cost,
					tiers: [
						{
							inputTokensAbove: 272000,
							input: cost.input * 2,
							output: cost.output * 1.5,
							cacheRead: cost.cacheRead * 2,
							cacheWrite: cost.cacheWrite * 2,
						},
					],
				},
				contextWindow,
				maxTokens: 128000,
				compat: {
					supportsAdditionalTools: true,
					supportsMidConvoSystemMessages: true,
					supportsOpenAIGrammarTools: true,
					supportsToolSearch: true,
				},
			});
		}
	});

	it("includes only medium/high/xhigh for OpenAI GPT-5.5 Pro", () => {
		const model = getModel("openai", "gpt-5.5-pro");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["medium", "high", "xhigh"]);
	});

	it("includes only medium/high/xhigh for OpenRouter GPT-5.5 Pro", () => {
		const model = getModel("openrouter", "openai/gpt-5.5-pro");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["medium", "high", "xhigh"]);
	});

	it("includes low/high/max plus off for DeepSeek V4.1 Flash on the DeepSeek provider", () => {
		const model = getModel("deepseek", "deepseek-flash");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "low", "high", "max"]);
	});

	it("includes low/high/max plus off for DeepSeek V4 Flash on opencode-go", () => {
		const model = getModel("opencode-go", "deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "low", "high", "max"]);
	});

	it("preserves low/high/max metadata for DeepSeek V4.1 Flash on OpenRouter", () => {
		const model = getModel("openrouter", "deepseek/deepseek-v4.1-flash");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "low", "high", "max"]);
	});

	it("preserves low/high/max metadata for DeepSeek V4.1 Flash on opencode-go", () => {
		const model = getModel("opencode-go", "deepseek-v4.1-flash");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["low", "high", "max"]);
	});

	it("excludes thinking off for Moonshot Kimi K2.7 Code models", () => {
		const cases = [getModel("moonshotai", "kimi-k2.7-code"), getModel("moonshotai-cn", "kimi-k2.7-code")];

		for (const model of cases) {
			expect(model).toBeDefined();
			expect(getSupportedThinkingLevels(model!)).toEqual(["minimal", "low", "medium", "high"]);
		}
	});

	it.each(["moonshotai", "moonshotai-cn"] as const)("uses the verified effort options for %s Kimi K3", (provider) => {
		const model = getModel(provider, "kimi-k3");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["low", "high", "max"]);
	});

	it("includes only low, high, max for Kimi Coding K3", () => {
		const model = getModel("kimi-coding", "k3");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["low", "high", "max"]);
	});

	it("includes only high for OpenCode Grok Build", () => {
		const model = getModel("opencode", "grok-build-0.1");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["high"]);
	});

	it("includes only high/xhigh plus off for DeepSeek V4 Flash on OpenRouter", () => {
		const model = getModel("openrouter", "deepseek/deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "high", "xhigh"]);
	});

	it("includes max but not xhigh for OpenRouter Opus 4.6 (openai-completions API)", () => {
		const model = getModel("openrouter", "anthropic/claude-opus-4.6");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("max");
		expect(getSupportedThinkingLevels(model!)).not.toContain("xhigh");
	});

	it("includes xhigh and max for Bedrock Claude Opus 5", () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-opus-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).toContain("max");
	});

	it("includes xhigh but not off or max for xAI Grok 4.6", () => {
		const model = getModel("xai", "grok-4.6");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["low", "medium", "high", "xhigh"]);
	});

	it("includes xhigh and max but not off for Bedrock Claude Fable 5", () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-fable-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).toContain("max");
		expect(getSupportedThinkingLevels(model!)).not.toContain("off");
	});
});

describe("supportsXhigh tier detection for map-less models", () => {
	function maplessWithId(id: string) {
		const base = getModel("anthropic", "claude-opus-4-8");
		if (!base) throw new Error("fixture model missing");
		const { thinkingLevelMap: _thinkingLevelMap, ...rest } = base;
		return { ...rest, id };
	}

	it.each(["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "gpt-5.6-sol"])(
		"detects the xhigh tier for map-less %s",
		(id) => {
			expect(supportsXhigh(maplessWithId(id))).toBe(true);
		},
	);

	it("still reports no xhigh tier for a map-less Sonnet 4.5", () => {
		expect(supportsXhigh(maplessWithId("claude-sonnet-4-5"))).toBe(false);
	});

	it("includes max for a map-less gpt-5.6-sol model", () => {
		expect(getSupportedThinkingLevels({ ...maplessWithId("gpt-5.6-sol"), api: "openai-responses" })).toContain("max");
	});

	it("does not derive max when an exact-id fixture catalog entry omits it", () => {
		expect(
			getSupportedThinkingLevels({ ...maplessWithId(FIXTURE_NO_MAX_MODEL_ID), api: "openai-responses" }),
		).not.toContain("max");
	});
});

describe("supportsMax tier detection for map-less models", () => {
	it("derives max support for a custom map-less model from injected catalog metadata", () => {
		const model = maplessModel("openai-completions", FIXTURE_MAX_MODEL_ID);

		expect(supportsMax(model)).toBe(true);
		expect(clampThinkingLevel(model, "max")).toBe("max");
		expect(clampThinkingLevel(model, "xhigh")).toBe("max");
	});

	it("does not grant max to an unknown custom map-less model", () => {
		const model = maplessModel("openai-completions", "unknown-reasoning-model");

		expect(supportsMax(model)).toBe(false);
		expect(clampThinkingLevel(model, "max")).toBe("high");
	});

	it("keeps valid discovered efforts authoritative over a fixture catalog max", () => {
		const model = maplessModel("openai-completions", FIXTURE_MAX_MODEL_ID, {
			thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null },
		});

		expect(supportsMax(model)).toBe(false);
		expect(clampThinkingLevel(model, "max")).toBe("high");
	});

	it.each(["openai-responses", "azure-openai-responses", "openai-codex-responses", "openai-completions"] as const)(
		"infers max for a map-less gpt-5.6-sol model on %s",
		(api) => {
			const model = maplessModel(api, "gpt-5.6-sol");
			expect(supportsMax(model)).toBe(true);
			expect(getSupportedThinkingLevels(model)).toContain("max");
		},
	);

	it.each(["gpt-5.6-sol-fast", "openai/gpt-5.6-sol"])("infers max for the map-less Sol variant %s", (id) => {
		expect(supportsMax(maplessModel("openai-responses", id))).toBe(true);
	});

	it.each(["gpt-5.6-solar", "gpt-5.6-solaris", "my-gpt-5.6-sol", "xgpt-5.6-sol", "legacy-gpt-5.6-solstice"])(
		"rejects %s",
		(id) => {
			expect(supportsMax(maplessModel("openai-responses", id))).toBe(false);
		},
	);

	it.each([
		["my-gpt-5.60", false, false],
		["notopus-5ive", false, false],
		["opus-50", false, false],
		["not-sonnet-500", false, false],
		["xgpt-5.2y", false, false],
		["gpt-5.6-solar", false, false],
		["GPT-5.6-SOL", true, true],
		["openai/gpt-5.6-sol", true, true],
		["quotio-openai/gpt-5.6-sol-fast", true, true],
	] as const)("matches model-family boundaries for %s", (id, xhigh, max) => {
		const model = maplessModel("openai-responses", id);
		expect(supportsXhigh(model)).toBe(xhigh);
		expect(supportsMax(model)).toBe(max);
	});

	it("does not apply the OpenAI floor to a namespaced Sol variant on a non-OpenAI-compatible api", () => {
		expect(supportsMax(maplessModel("anthropic-messages", "custom/gpt-5.6-sol-preview-2099"))).toBe(false);
	});

	it.each(["custom/gpt-5.6-terra", "custom/gpt-5.6-luna", "gpt-5.6", "gpt-5.5", "upstage/solar-pro-3"])(
		"does not infer max for an uncataloged map-less %s model",
		(id) => {
			expect(supportsMax(maplessModel("openai-responses", id))).toBe(false);
		},
	);

	it("does not infer max for a map-less non-reasoning gpt-5.6-sol model", () => {
		expect(supportsMax(maplessModel("openai-responses", "gpt-5.6-sol", { reasoning: false }))).toBe(false);
	});

	it("treats an empty thinking-level map as authoritative", () => {
		const model = maplessModel("openai-responses", "gpt-5.6-sol", { thinkingLevelMap: {} });
		expect(supportsXhigh(model)).toBe(false);
		expect(supportsMax(model)).toBe(false);
		expect(getSupportedThinkingLevels(model)).not.toContain("xhigh");
		expect(getSupportedThinkingLevels(model)).not.toContain("max");
	});

	it("honors an explicit max veto on gpt-5.6-sol", () => {
		const model = maplessModel("openai-responses", "gpt-5.6-sol", { thinkingLevelMap: { max: null } });
		expect(supportsXhigh(model)).toBe(false);
		expect(supportsMax(model)).toBe(false);
		expect(getSupportedThinkingLevels(model)).not.toContain("xhigh");
		expect(getSupportedThinkingLevels(model)).not.toContain("max");
	});

	it("treats a map omitting max as authoritative for gpt-5.6-sol", () => {
		const model = maplessModel("openai-responses", "gpt-5.6-sol", { thinkingLevelMap: { xhigh: "xhigh" } });
		expect(supportsMax(model)).toBe(false);
		expect(getSupportedThinkingLevels(model)).not.toContain("max");
		expect(getSupportedThinkingLevels(model)).toContain("xhigh");
	});

	it("treats a map omitting xhigh as authoritative for gpt-5.6-sol", () => {
		const model = maplessModel("openai-responses", "gpt-5.6-sol", { thinkingLevelMap: { max: "max" } });
		expect(supportsXhigh(model)).toBe(false);
		expect(supportsMax(model)).toBe(true);
		expect(getSupportedThinkingLevels(model)).not.toContain("xhigh");
		expect(getSupportedThinkingLevels(model)).toContain("max");
	});

	it("keeps the existing GPT and Claude id lists as a floor", () => {
		expect(supportsMax(maplessModel("openai-responses", "custom/gpt-5.6-sol-preview-2099"))).toBe(true);
		expect(supportsMax(maplessModel("anthropic-messages", "custom/claude-opus-4-7-preview-2099"))).toBe(true);
	});

	it.each(["claude-opus-4-8", "claude-opus-5", "claude-sonnet-5", "claude-fable-5"])(
		"keeps inferring max for map-less Anthropic %s",
		(id) => {
			expect(supportsMax(maplessModel("anthropic-messages", id))).toBe(true);
		},
	);
});
