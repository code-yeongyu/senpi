import { describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";

const OPENROUTER_ANTHROPIC_LATEST_MODEL_IDS = [
	"~anthropic/claude-fable-latest",
	"~anthropic/claude-haiku-latest",
	"~anthropic/claude-opus-latest",
	"~anthropic/claude-sonnet-latest",
] as const;

describe("OpenRouter cache control metadata", () => {
	it.each(OPENROUTER_ANTHROPIC_LATEST_MODEL_IDS)("enables cache control for %s", (modelId) => {
		expect(getModel("openrouter", modelId).compat?.cacheControlFormat).toBe("anthropic");
	});

	it.each(["qwen/qwen3-235b-a22b", "google/gemini-2.5-pro"] as const)("enables cache control for %s", (modelId) => {
		expect(getModel("openrouter", modelId).compat?.cacheControlFormat).toBe("anthropic");
	});

	it("does not enable cache control outside the prefix allowlist", () => {
		expect(getModel("openrouter", "meta-llama/llama-3.3-70b-instruct").compat?.cacheControlFormat).toBeUndefined();
	});
});
