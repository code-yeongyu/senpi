import { describe, expect, it } from "vitest";
import {
	AUTO_RESOLVED_PRESET_NAMES,
	PROMPT_PRESET_MODEL_CASES,
	resolvePresetName,
} from "../../src/core/extensions/builtin/prompt-preset/contract.ts";
import { VALID_PRESETS } from "../../src/core/extensions/builtin/prompt-preset/settings.ts";

describe("prompt-preset shared contract", () => {
	it("resolves every shared model case to its preset", () => {
		for (const testCase of PROMPT_PRESET_MODEL_CASES) {
			expect(
				resolvePresetName({ providerID: testCase.providerID, modelID: testCase.modelID }),
				`${testCase.providerID}/${testCase.modelID}`,
			).toBe(testCase.preset);
		}
	});

	it("covers every preset with at least one shared model case", () => {
		const covered = new Set(PROMPT_PRESET_MODEL_CASES.map((testCase) => testCase.preset));
		for (const name of AUTO_RESOLVED_PRESET_NAMES) {
			expect(covered.has(name), `no PROMPT_PRESET_MODEL_CASES row resolves to ${name}`).toBe(true);
		}
	});

	it("exposes exactly the non-auto valid presets", () => {
		const autoResolvable = [...VALID_PRESETS].filter((preset) => preset !== "auto" && preset !== "gpt-5").sort();
		expect([...AUTO_RESOLVED_PRESET_NAMES].sort()).toEqual(autoResolvable);
	});

	it("returns undefined for an unknown model", () => {
		expect(resolvePresetName({ providerID: "acme", modelID: "acme-unknown-9000" })).toBeUndefined();
	});
});
