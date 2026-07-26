import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GrokToolRow } from "../../src/modes/interactive/grok/tool-row.ts";
import { fg, GROK_COLOR_MODES, initGrokTheme, resetGrokThemeCapabilities } from "./theme-assertions.ts";

for (const { label, trueColor } of GROK_COLOR_MODES) {
	describe(`GrokToolRow (${label})`, () => {
		beforeEach(() => {
			expect(initGrokTheme("grok-night", trueColor)).toBe(label);
		});

		afterEach(() => {
			resetGrokThemeCapabilities();
		});

		it("renders guide and diamond glyphs with theme-backed success, error, and warning accents", () => {
			const success = new GrokToolRow({ toolName: "write", isPartial: false, result: { isError: false } });
			const error = new GrokToolRow({ toolName: "write", isPartial: false, result: { isError: true } });
			const warning = new GrokToolRow({ toolName: "write", isPartial: false });

			const prefix = `${fg("muted", "┃")} `;
			const label = ` ${fg("text", "write")}`;
			expect(success.render(80)).toEqual([`${prefix}${fg("success", "◆")}${label}`]);
			expect(error.render(80)).toEqual([`${prefix}${fg("error", "◆")}${label}`]);
			expect(warning.render(80)).toEqual([`${prefix}${fg("warning", "◆")}${label}`]);
		});

		it("uses the grok braille spinner frame while a tool is pending", () => {
			const row = new GrokToolRow({ toolName: "write", isPartial: true });
			expect(row.render(80)).toEqual([`${fg("muted", "┃")} ${fg("warning", "⠹")} ${fg("text", "write")}`]);
		});
	});
}
