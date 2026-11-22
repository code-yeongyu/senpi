import { colorToHex, type TerminalColorMode } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	createReservedKeywordHighlight,
	reservedKeywordColor,
} from "../src/modes/interactive/theme/reserved-keyword-rainbow.ts";
import type { ThemeAppearance } from "../src/modes/interactive/theme/theme.ts";

function highlight(appearance: ThemeAppearance, mode: TerminalColorMode, env: NodeJS.ProcessEnv = {}) {
	return createReservedKeywordHighlight({ appearance: () => appearance, colorMode: () => mode, env });
}

describe("reserved keyword rainbow", () => {
	it("starts on the desktop's red and ends on its pink for each appearance", () => {
		expect(colorToHex(reservedKeywordColor("light", 0, 8))).toBe("#b91c1c");
		expect(colorToHex(reservedKeywordColor("light", 7, 8))).toBe("#be185d");
		expect(colorToHex(reservedKeywordColor("dark", 0, 8))).toBe("#f87171");
		expect(colorToHex(reservedKeywordColor("dark", 7, 8))).toBe("#f472b6");
	});

	it("gives each character of a short keyword its own colour", () => {
		const colours = [0, 1, 2].map((index) => colorToHex(reservedKeywordColor("dark", index, 3)));
		expect(new Set(colours).size).toBe(3);
	});

	it("emits a truecolor foreground per character and resets only the foreground", () => {
		expect(highlight("dark", "truecolor")?.style("u", 0, 3)).toBe("\x1b[38;2;248;113;113mu\x1b[39m");
	});

	it("falls back to the 256-colour palette", () => {
		expect(highlight("dark", "256color")?.style("u", 0, 3)).toMatch(/^\x1b\[38;5;\d+mu\x1b\[39m$/);
	});

	it("is off under NO_COLOR and on when NO_COLOR is empty", () => {
		expect(highlight("dark", "truecolor", { NO_COLOR: "1" })).toBeUndefined();
		expect(highlight("dark", "truecolor", { NO_COLOR: "" })).toBeDefined();
	});

	it("finds runs with the shared matcher", () => {
		expect(highlight("light", "truecolor")?.find("mass ulw research x")).toEqual([{ start: 0, end: 17 }]);
	});
});
