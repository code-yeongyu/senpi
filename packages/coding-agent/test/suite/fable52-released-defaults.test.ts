import { afterEach, describe, expect, it, vi } from "vitest";
import { OBSERVED_CLAUDE_CODE_MODEL_FLOORS } from "../../src/core/extensions/builtin/anthropic-subscription/executable-model-support.ts";
import { RECOMMENDED_DEFAULT_MODELS } from "../../src/core/extensions/builtin/recommended-models/index.ts";
import { DEFAULT_FALLBACK_CHAINS } from "../../src/core/retry-fallback/settings.ts";
import { createHarness, model } from "./recommended-models-harness.ts";

const CLAUDE_PROVIDERS = ["anthropic-subscription", "anthropic", "anthropic-api", "github-copilot", "opencode"];

// senpi#3893: the provisional Fable 5.5 launch shipped as Claude Fable 5.2 (`claude-fable-5-2`).
describe("Claude Fable 5.2 is the released Fable default", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("fills the Fable slot of the recommended ladder at xhigh on the Claude lanes", () => {
		expect(RECOMMENDED_DEFAULT_MODELS[1]).toEqual(["claude-fable-5-2", "xhigh", CLAUDE_PROVIDERS]);
	});

	it("ships a bare Opus-only fallback chain for Fable 5.2", () => {
		expect(DEFAULT_FALLBACK_CHAINS["claude-fable-5-2"]).toEqual(["claude-opus-5-5", "claude-opus-5"]);
	});

	it("names no provisional Fable/Mythos 5.5 id in any shipped default", () => {
		const shipped = [
			...RECOMMENDED_DEFAULT_MODELS.map(([modelId]) => modelId),
			...Object.keys(DEFAULT_FALLBACK_CHAINS),
			...Object.values(DEFAULT_FALLBACK_CHAINS).flat(),
			...Object.keys(OBSERVED_CLAUDE_CODE_MODEL_FLOORS),
		];
		expect(shipped.filter((id) => /(?:fable|mythos)-5[.-]5(?:$|[^0-9])/.test(id))).toEqual([]);
	});

	it("selects Fable 5.2 over Fable 5.1 when Opus 5.5 is unavailable", async () => {
		const fable52 = model("claude-fable-5-2", "anthropic");
		const harness = createHarness({
			active: model("unrecommended-start", "anthropic"),
			available: [model("claude-fable-5-1", "anthropic"), fable52],
		});

		await harness.start("provider-default");

		expect(harness.getActiveModel()).toBe(fable52);
		expect(harness.getThinkingLevel()).toBe("xhigh");
	});
});
