import { describe, expect, it } from "vitest";
import { buildPreset } from "../../../src/core/extensions/builtin/prompt-preset/presets.ts";
import { parsePromptPreset, VALID_PRESETS } from "../../../src/core/extensions/builtin/prompt-preset/settings.ts";
import { PromptSizeAccounting } from "../../../src/core/prompt-size-report.ts";
import { goldenCases } from "./3483-print-prompt-sizes-fixtures.ts";

const presetNames = [...VALID_PRESETS].flatMap((value) => {
	const name = parsePromptPreset(value);
	return name === undefined || name === "auto" ? [] : [name];
});
const presetCases = goldenCases.filter((entry) => entry.options.customPrompt === undefined);

describe("prompt preset parts (#3483)", () => {
	it.each(presetNames)("joins the parts of %s to its exact prompt", (name) => {
		for (const { options } of presetCases) {
			// When
			const preset = buildPreset(name, options);
			// Then
			expect(preset.parts.length).toBeGreaterThan(0);
			expect(preset.parts.map((part) => part.text).join("")).toBe(preset.prompt);
		}
	});

	it("reports a replacement whose parts do not join to its prompt", () => {
		// Given
		const accounting = new PromptSizeAccounting({
			base: "base",
			options: { cwd: "/workspace" },
			parts: [{ name: "core", text: "base" }],
			extensionNames: new Map([["<builtin:prompt-preset>", "prompt-preset"]]),
		});
		// When
		accounting.observe({
			path: "<builtin:prompt-preset>",
			before: "base",
			after: "preset prompt",
			parts: [{ name: "core", text: "preset" }],
		});
		const report = accounting.report([]);
		// Then: the net delta still sums, and the mismatch is named instead of hidden.
		expect(report.presetPartsMismatch?.names).toEqual(["prompt-preset"]);
		expect(report.total.bytes).toBe(Buffer.byteLength("preset prompt") + Buffer.byteLength("[]"));
	});
});
