/**
 * Golden test for the grok glyphs (todo S2), transcribed from `.omo/plans/grok-neo.md`
 * §Palette. The colour tables are checked through the theme loader in grok-themes.test.ts.
 */
import { describe, expect, it } from "vitest";
import { GROK_GLYPHS } from "../../src/modes/interactive/grok/palette.ts";

describe("grok palette golden (plan §Palette)", () => {
	it("matches the plan's Glyphs table", () => {
		expect(GROK_GLYPHS.spinner).toBe("⠹");
		expect(GROK_GLYPHS.toolRow).toBe("┃ ◆");
	});
});
