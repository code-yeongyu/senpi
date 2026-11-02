import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildHandoffSection, HANDOFF_LANGUAGE_RULE } from "../../../src/core/dynamic-prompt/handoff.ts";
import { resolvePreset } from "../../../src/core/extensions/builtin/prompt-preset/presets.ts";

function createModel(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	};
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

const CLAUDE_MODEL_IDS = [
	"claude-fable-5",
	"claude-fable-5-1",
	"claude-opus-5",
	"claude-opus-5-5",
	"claude-sonnet-5-5",
	"claude-opus-4-5",
	"claude-opus-4-6",
	"claude-opus-4-7",
	"claude-opus-4-8",
];

describe("senpi#2366 handoff user-language rule", () => {
	it.each(CLAUDE_MODEL_IDS)("renders the shared language rule exactly once in the %s preset", (modelId) => {
		// when
		const preset = resolvePreset(createModel(modelId), { promptPreset: "auto" });

		// then
		expect(preset?.name).toMatch(/^claude-/);
		expect(occurrences(preset?.prompt ?? "", HANDOFF_LANGUAGE_RULE)).toBe(1);
	});

	it("keeps the handoff template labels the ttsr repetitive-turns detector parses", () => {
		// given
		const templateLine = buildHandoffSection()
			.split("\n")
			.find((line) => line.includes("For you: ["));

		// then
		expect(templateLine).toMatch(
			/Ask: \[[^\]]+\] - wanted: \[[^\]]+\]\. For you: \[[^\]]+\]\. Now: \[[^\]]+\]\. Next: \[[^\]]+\]\./,
		);
	});
});
