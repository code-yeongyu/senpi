import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildHighReasoningWarning,
	isSensitiveHighReasoningModel,
	shouldWarnHighReasoning,
} from "../src/core/high-reasoning-warning.ts";
import { getSupportedThinkingLevels, supportsMax, supportsXhigh } from "../src/core/thinking-levels.ts";

function mkModel(id: string, provider = "openai"): Model<Api> {
	return { id, provider, reasoning: true, api: "openai-responses" } as unknown as Model<Api>;
}

const SOL_MODEL_IDS = [
	"gpt-5.6-sol",
	"gpt-5.6-sol-fast",
	"openai.gpt-5.6-sol",
	"openai/gpt-5.6-sol",
	"openai/gpt-5.6-sol-pro",
];

const NON_SOL_MODEL_IDS = [
	"upstage/solar-pro-3",
	"gpt-5.6-luna",
	"gpt-5.6-luna-fast",
	"gpt-5.6-terra",
	"gpt-5.6",
	"gpt-5.5",
	"gpt-5.2",
	"gpt-5.3-codex-spark",
	"gpt-4o",
	"claude-fable-5",
	"claude-opus-4-8",
	"opus-4.7",
	"opus-5",
	"claude-sonnet-5",
	"deepseek-v4-pro",
	"deepseek-v4-flash",
];

const ASTRA_MODEL_IDS = ["gpt-6-astra", "gpt-6-astra-fast", "openai/gpt-6-astra"];

describe("high-reasoning-warning", () => {
	describe("isSensitiveHighReasoningModel", () => {
		it.each(SOL_MODEL_IDS)("flags the gpt-5.6-sol variant %s", (id) => {
			expect(isSensitiveHighReasoningModel(mkModel(id))).toBe(true);
		});

		it.each(["openai", "openrouter", "azure", "anthropic"])("is provider-agnostic for provider %s", (provider) => {
			expect(isSensitiveHighReasoningModel(mkModel("gpt-5.6-sol", provider))).toBe(true);
		});

		it.each(NON_SOL_MODEL_IDS)("does NOT flag %s", (id) => {
			expect(isSensitiveHighReasoningModel(mkModel(id))).toBe(false);
		});
	});

	describe("shouldWarnHighReasoning", () => {
		it("warns for a gpt-5.6-sol variant at xhigh or max", () => {
			expect(shouldWarnHighReasoning(mkModel("gpt-5.6-sol"), "xhigh")).toBe(true);
			expect(shouldWarnHighReasoning(mkModel("gpt-5.6-sol"), "max")).toBe(true);
			expect(shouldWarnHighReasoning(mkModel("openai/gpt-5.6-sol-pro"), "xhigh")).toBe(true);
		});

		it.each(ASTRA_MODEL_IDS)("warns for GPT-6 Astra only at max: %s", (id) => {
			expect(shouldWarnHighReasoning(mkModel(id), "xhigh")).toBe(false);
			expect(shouldWarnHighReasoning(mkModel(id), "max")).toBe(true);
		});

		it("does NOT warn for claude-fable-5 at xhigh or max (reported bug)", () => {
			expect(shouldWarnHighReasoning(mkModel("claude-fable-5", "anthropic"), "xhigh")).toBe(false);
			expect(shouldWarnHighReasoning(mkModel("claude-fable-5", "anthropic"), "max")).toBe(false);
		});

		it.each(NON_SOL_MODEL_IDS)("does NOT warn for non-sol model %s at xhigh", (id) => {
			expect(shouldWarnHighReasoning(mkModel(id), "xhigh")).toBe(false);
			expect(shouldWarnHighReasoning(mkModel(id), "max")).toBe(false);
		});

		it.each(["high", "medium", "low", "minimal", "off"] as const)(
			"does NOT warn for gpt-5.6-sol at level %s",
			(level) => {
				expect(shouldWarnHighReasoning(mkModel("gpt-5.6-sol"), level)).toBe(false);
			},
		);
	});

	describe("capability gating is untouched by the warning narrowing", () => {
		it("keeps xhigh/max capability for claude-fable-5 even though it no longer warns", () => {
			const fable = mkModel("claude-fable-5", "anthropic");
			expect(supportsXhigh(fable)).toBe(true);
			expect(supportsMax(fable)).toBe(true);
			const levels = getSupportedThinkingLevels(fable);
			expect(levels).toContain("xhigh");
			expect(levels).toContain("max");
			expect(shouldWarnHighReasoning(fable, "xhigh")).toBe(false);
		});

		it("keeps xhigh capability for gpt-5.6-sol, which also warns", () => {
			const sol = mkModel("gpt-5.6-sol");
			expect(supportsXhigh(sol)).toBe(true);
			expect(getSupportedThinkingLevels(sol)).toContain("xhigh");
			expect(shouldWarnHighReasoning(sol, "xhigh")).toBe(true);
		});
	});

	describe("buildHighReasoningWarning", () => {
		it("produces a scary warning that names the model+level and urges ultrabrain", () => {
			const w = buildHighReasoningWarning(mkModel("gpt-5.6-sol", "openai"), "xhigh");
			expect(w.title).toMatch(/WARNING/i);
			expect(w.title).toContain("gpt-5.6-sol");
			expect(w.title).toContain("xhigh");
			const body = w.body.join("\n");
			expect(body).toMatch(/ultrabrain/i);
			expect(body).toMatch(/responsibilit/i);
			expect(body).toMatch(/stop|loop|halt/i);
			expect(body).toMatch(/unrequested|not asked|not requested/i);
			expect(body).toMatch(/risk|irreversible|dangerous/i);
			expect(body).toMatch(/query ultrabrain|delegate|subagent|sub-agent/i);
			expect(body.length).toBeGreaterThan(200);
		});
	});
});
