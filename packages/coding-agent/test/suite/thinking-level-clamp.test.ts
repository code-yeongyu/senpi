import { getModel } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { clampThinkingLevelToModel } from "../../src/core/sdk.js";

describe("clampThinkingLevelToModel", () => {
	it("clamps max to high on Anthropic models that do not expose xhigh/max", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(clampThinkingLevelToModel("max", model)).toBe("high");
	});

	it("clamps xhigh to high on Anthropic models that do not expose xhigh/max", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(clampThinkingLevelToModel("xhigh", model)).toBe("high");
	});

	it("preserves max on Opus 4.7 (native max support)", () => {
		const model = getModel("anthropic", "claude-opus-4-7");
		expect(clampThinkingLevelToModel("max", model)).toBe("max");
	});

	it("preserves xhigh on Opus 4.7", () => {
		const model = getModel("anthropic", "claude-opus-4-7");
		expect(clampThinkingLevelToModel("xhigh", model)).toBe("xhigh");
	});

	it("preserves max on Opus 4.6 (legacy max tier)", () => {
		const model = getModel("anthropic", "claude-opus-4-6");
		expect(clampThinkingLevelToModel("max", model)).toBe("max");
	});

	it("downgrades max to xhigh on xhigh-only OpenAI models (GPT-5.2)", () => {
		const model = getModel("openai", "gpt-5.2");
		expect(clampThinkingLevelToModel("max", model)).toBe("xhigh");
	});

	it("downgrades max to xhigh on GPT-5.4", () => {
		const model = getModel("openai", "gpt-5.4");
		expect(clampThinkingLevelToModel("max", model)).toBe("xhigh");
	});

	it("preserves xhigh on xhigh-only OpenAI models", () => {
		const model = getModel("openai", "gpt-5.2");
		expect(clampThinkingLevelToModel("xhigh", model)).toBe("xhigh");
	});

	it("forces off on non-reasoning models", () => {
		const model = getModel("anthropic", "claude-3-5-haiku-latest");
		const nonReasoning = { ...model, reasoning: false };
		expect(clampThinkingLevelToModel("max", nonReasoning)).toBe("off");
	});

	it("forces off when model is undefined", () => {
		expect(clampThinkingLevelToModel("max", undefined)).toBe("off");
	});

	it("preserves lower levels unchanged on xhigh-capable models", () => {
		const model = getModel("anthropic", "claude-opus-4-7");
		expect(clampThinkingLevelToModel("medium", model)).toBe("medium");
		expect(clampThinkingLevelToModel("high", model)).toBe("high");
	});

	it("defaults undefined level to off", () => {
		const model = getModel("anthropic", "claude-opus-4-7");
		expect(clampThinkingLevelToModel(undefined, model)).toBe("off");
	});
});
