import { describe, expect, it } from "vitest";
import { MODELS } from "../../../ai/src/models.generated.ts";
import {
	AUTO_RESOLVED_PRESET_NAMES,
	PROMPT_PRESET_MODEL_CASES,
	resolvePresetName as resolveContractPresetName,
} from "../../src/core/extensions/builtin/prompt-preset/contract.ts";
import { resolvePresetName as resolveRuntimePresetName } from "../../src/core/extensions/builtin/prompt-preset/presets.ts";
import { VALID_PRESETS } from "../../src/core/extensions/builtin/prompt-preset/settings.ts";

function flattenCatalog(): Array<{ providerID: string; modelID: string; name?: string }> {
	const entries: Array<{ providerID: string; modelID: string; name?: string }> = [];
	for (const [providerID, providerModels] of Object.entries(MODELS)) {
		for (const model of Object.values(providerModels)) {
			const entry: { providerID: string; modelID: string; name?: string } = {
				providerID,
				modelID: model.id,
			};
			if (typeof model.name === "string" && model.name.length > 0) {
				entry.name = model.name;
			}
			entries.push(entry);
		}
	}
	return entries;
}

describe("prompt-preset shared contract", () => {
	it("resolves every shared model case to its preset", () => {
		for (const testCase of PROMPT_PRESET_MODEL_CASES) {
			expect(
				resolveContractPresetName({ providerID: testCase.providerID, modelID: testCase.modelID }),
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
		expect(resolveContractPresetName({ providerID: "acme", modelID: "acme-unknown-9000" })).toBeUndefined();
	});

	it("resolves every catalog model identically through the runtime and the contract", () => {
		const mismatches: string[] = [];
		for (const entry of flattenCatalog()) {
			const runtime = resolveRuntimePresetName(
				{ id: entry.modelID, provider: entry.providerID, name: entry.name },
				{ promptPreset: "auto" },
			);
			const contract = resolveContractPresetName({
				providerID: entry.providerID,
				modelID: entry.modelID,
				name: entry.name,
			});
			if (runtime !== contract) {
				mismatches.push(
					`${entry.providerID}/${entry.modelID}: runtime=${String(runtime)} contract=${String(contract)}`,
				);
			}
		}
		expect(mismatches).toEqual([]);
	});

	it("fails on probe model ids whose routing exists in only one resolver", () => {
		// Self-audit: the drift guard must actually observe divergence. Each probe
		// resolves through one hardcoded expectation in each resolver, so a routing
		// change made in only one of them (the past dotted-before-generic and
		// snapshot-before-alias bugs) breaks the pair here.
		const probes = [
			{ providerID: "anthropic", modelID: "opus-6-preview", expected: undefined },
			{ providerID: "openai", modelID: "gpt-5.7-preview", expected: undefined },
			{ providerID: "anthropic", modelID: "opus-5.5", expected: "claude-opus-5-5" },
			{ providerID: "deepseek", modelID: "deepseek-v4-flash", expected: "deepseek-v4-1-flash" },
			{
				providerID: "fireworks",
				modelID: "accounts/fireworks/models/deepseek-v4-flash",
				expected: "deepseek-v4-flash",
			},
		] as const;
		for (const probe of probes) {
			const runtime = resolveRuntimePresetName(
				{ id: probe.modelID, provider: probe.providerID },
				{ promptPreset: "auto" },
			);
			const contract = resolveContractPresetName({ providerID: probe.providerID, modelID: probe.modelID });
			expect(runtime, `${probe.providerID}/${probe.modelID} runtime`).toBe(probe.expected);
			expect(contract, `${probe.providerID}/${probe.modelID} contract`).toBe(probe.expected);
		}
	});
});
