import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels, supportsMax, supportsXhigh } from "../src/compat.ts";
import type { Model } from "../src/model.ts";
import type { Api } from "../src/types.ts";

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
	it("delegates extended-tier precedence to the exported capability predicates", () => {
		const source = readFileSync(fileURLToPath(new URL("../src/models.ts", import.meta.url)), "utf8");
		const functionSource = source.slice(
			source.indexOf("export function getSupportedThinkingLevels"),
			source.indexOf("export function clampThinkingLevel"),
		);

		expect(functionSource).toContain('if (level === "xhigh") return supportsXhigh(model);');
		expect(functionSource).toContain('if (level === "max") return supportsMax(model);');
		expect(functionSource).not.toContain("supportsXhighModelId");
		expect(functionSource).not.toContain("supportsMaxModel");
	});

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

	it.each(["gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const)(
		"includes xhigh for openai-codex %s models",
		(modelId) => {
			const model = getModel("openai-codex", modelId);
			expect(model).toBeDefined();
			expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		},
	);

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

	it("includes only high/max plus off for DeepSeek V4 Flash on the DeepSeek provider", () => {
		const model = getModel("deepseek", "deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "high", "max"]);
	});

	it("includes only high/max plus off for DeepSeek V4 Flash on opencode-go", () => {
		const model = getModel("opencode-go", "deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "high", "max"]);
	});

	it("includes only high plus off for OpenCode Go Kimi K2.6", () => {
		const model = getModel("opencode-go", "kimi-k2.6");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "high"]);
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

	it("does not infer max for a map-less gpt-5.6-terra model", () => {
		expect(getSupportedThinkingLevels({ ...maplessWithId("gpt-5.6-terra"), api: "openai-responses" })).not.toContain(
			"max",
		);
	});
});

describe("supportsMax tier detection for map-less models", () => {
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

	it("does not infer max for a map-less gpt-5.6-sol model on a non-OpenAI-compatible api", () => {
		expect(supportsMax(maplessModel("anthropic-messages", "gpt-5.6-sol"))).toBe(false);
	});

	it.each(["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6", "gpt-5.5", "upstage/solar-pro-3"])(
		"does not infer max for a map-less non-Sol %s model",
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

	it.each(["claude-opus-4-8", "claude-opus-5", "claude-sonnet-5", "claude-fable-5"])(
		"keeps inferring max for map-less Anthropic %s",
		(id) => {
			expect(supportsMax(maplessModel("anthropic-messages", id))).toBe(true);
		},
	);
});
