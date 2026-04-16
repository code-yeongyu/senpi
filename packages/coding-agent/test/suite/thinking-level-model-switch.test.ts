import { getModel } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { clampThinkingLevelToModel } from "../../src/core/sdk.js";

const THINKING_LEVELS_WITH_XHIGH = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const THINKING_LEVELS_WITH_MAX = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;

type ThinkingLevel = (typeof THINKING_LEVELS_WITH_MAX)[number];

function clampWithAvailableLevels(level: ThinkingLevel, availableLevels: readonly ThinkingLevel[]): ThinkingLevel {
	const ordered = THINKING_LEVELS_WITH_MAX;
	const available = new Set<ThinkingLevel>(availableLevels);
	const requestedIndex = ordered.indexOf(level);
	if (requestedIndex === -1) {
		return availableLevels[0] ?? "off";
	}
	for (let i = requestedIndex; i >= 0; i--) {
		const candidate = ordered[i];
		if (available.has(candidate)) return candidate;
	}
	for (let i = requestedIndex + 1; i < ordered.length; i++) {
		const candidate = ordered[i];
		if (available.has(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

describe("AgentSession _clampThinkingLevel contract on model switch", () => {
	it("max downgrades to xhigh when new model exposes xhigh but not max", () => {
		expect(clampWithAvailableLevels("max", THINKING_LEVELS_WITH_XHIGH)).toBe("xhigh");
	});

	it("max downgrades to high when new model has only basic thinking", () => {
		expect(clampWithAvailableLevels("max", THINKING_LEVELS)).toBe("high");
	});

	it("xhigh downgrades to high when new model has only basic thinking", () => {
		expect(clampWithAvailableLevels("xhigh", THINKING_LEVELS)).toBe("high");
	});

	it("max stays max when new model supports native max", () => {
		expect(clampWithAvailableLevels("max", THINKING_LEVELS_WITH_MAX)).toBe("max");
	});

	it("xhigh stays xhigh when new model supports xhigh", () => {
		expect(clampWithAvailableLevels("xhigh", THINKING_LEVELS_WITH_XHIGH)).toBe("xhigh");
	});
});

describe("clampThinkingLevelToModel covers real-world model switches", () => {
	it("Opus 4.7 max -> GPT-5.2 (xhigh-only) clamps to xhigh", () => {
		const gpt52 = getModel("openai", "gpt-5.2");
		expect(clampThinkingLevelToModel("max", gpt52)).toBe("xhigh");
	});

	it("Opus 4.7 max -> Sonnet 4.5 (basic reasoning) clamps to high", () => {
		const sonnet45 = getModel("anthropic", "claude-sonnet-4-5");
		expect(clampThinkingLevelToModel("max", sonnet45)).toBe("high");
	});

	it("Opus 4.7 max -> Opus 4.6 (native max) preserves max", () => {
		const opus46 = getModel("anthropic", "claude-opus-4-6");
		expect(clampThinkingLevelToModel("max", opus46)).toBe("max");
	});
});
