import { FABLE55_LAUNCH } from "@earendil-works/pi-ai/utils/fable55-launch";
import { describe, expect, it } from "vitest";
import { DEFAULT_FALLBACK_CHAINS } from "../../src/core/retry-fallback/settings.ts";

// senpi#3893: a shipped default chain keyed on an unreleased id could route users to a model that does not exist yet.
describe("default fallback chains before the Fable 5.5 launch", () => {
	it("contain the launch id only once it is released", () => {
		expect(Object.hasOwn(DEFAULT_FALLBACK_CHAINS, FABLE55_LAUNCH.modelId)).toBe(FABLE55_LAUNCH.released);
	});
});
