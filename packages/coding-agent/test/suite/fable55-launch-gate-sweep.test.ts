import { FABLE55_LAUNCH, isFable55ModelId } from "@earendil-works/pi-ai/utils/fable55-launch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OBSERVED_CLAUDE_CODE_MODEL_FLOORS } from "../../src/core/extensions/builtin/anthropic-subscription/executable-model-support.ts";
import { RECOMMENDED_DEFAULT_MODELS } from "../../src/core/extensions/builtin/recommended-models/index.ts";
import { DEFAULT_FALLBACK_CHAINS } from "../../src/core/retry-fallback/settings.ts";
import { createHarness, model } from "./recommended-models-harness.ts";

// senpi#3897 ships before the Fable 5.5 launch: with the gate off, no shipped default, fallback chain,
// version floor or automatic model choice may name the launch id, whatever the model registry lists.
describe("Fable 5.5 launch gate off: no shipped default routes to the launch id", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("the gate is off in this build", () => {
		expect(FABLE55_LAUNCH.released).toBe(false);
	});

	it("no recommended default, fallback chain key or rung, or Claude Code floor names the launch id", () => {
		const shipped = [
			...RECOMMENDED_DEFAULT_MODELS.map(([modelId]) => modelId),
			...Object.keys(DEFAULT_FALLBACK_CHAINS),
			...Object.values(DEFAULT_FALLBACK_CHAINS).flat(),
			...Object.keys(OBSERVED_CLAUDE_CODE_MODEL_FLOORS),
		];
		expect(shipped.filter((id) => isFable55ModelId(id))).toEqual([]);
	});

	it.each([
		["cold registry", [] as string[]],
		["warm registry listing only the launch id", [FABLE55_LAUNCH.modelId]],
		["warm registry listing 5.1 and the launch id", ["claude-fable-5-1", FABLE55_LAUNCH.modelId]],
	])("the automatic model choice never selects the launch id (%s)", async (_case, ids) => {
		// #given
		const harness = createHarness({
			active: model("unrecommended-start", "anthropic"),
			available: ids.map((id) => model(id, "anthropic")),
		});
		// #when
		await harness.start("provider-default");
		// #then
		expect(isFable55ModelId(harness.getActiveModel().id)).toBe(false);
	});
});
