import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { getSupportedThinkingLevels, supportsMax, supportsXhigh } from "../src/core/thinking-levels.ts";

/** A custom-provider model with no thinkingLevelMap: tier detection must come from the id. */
function maplessModel(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "custom-gateway",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
	} as Model<Api>;
}

describe("thinking level tier detection for map-less models", () => {
	it.each(["claude-opus-5", "claude-sonnet-5", "claude-fable-5"])("exposes xhigh and max for %s", (id) => {
		const model = maplessModel(id);
		expect(supportsXhigh(model)).toBe(true);
		expect(supportsMax(model)).toBe(true);
		expect(getSupportedThinkingLevels(model)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model)).toContain("max");
	});

	it("exposes xhigh for gpt-5.6 without claiming the max tier", () => {
		const model = maplessModel("gpt-5.6-sol");
		expect(supportsXhigh(model)).toBe(true);
		expect(supportsMax(model)).toBe(false);
	});

	it("exposes neither tier for Sonnet 4.5", () => {
		const model = maplessModel("claude-sonnet-4-5");
		expect(supportsXhigh(model)).toBe(false);
		expect(supportsMax(model)).toBe(false);
	});
});
