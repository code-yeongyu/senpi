import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { colorToHex } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { loadThemeFromPath, setTerminalColors } from "../../../src/modes/interactive/theme/theme.ts";

// Regression for https://github.com/code-yeongyu/senpi/issues/2655

type ThemeFile = {
	name: string;
	colors: Record<string, string>;
};

const tempDirs: string[] = [];

function loadTheme(base: "dark" | "light") {
	const themeJson = JSON.parse(
		readFileSync(new URL(`../../../src/modes/interactive/theme/${base}.json`, import.meta.url), "utf8"),
	) as ThemeFile;
	const dir = mkdtempSync(join(tmpdir(), "senpi-theme-contrast-"));
	tempDirs.push(dir);
	const path = join(dir, `${themeJson.name}.json`);
	writeFileSync(path, JSON.stringify(themeJson));
	return loadThemeFromPath(path, "truecolor");
}

function relativeLuminance(hexColor: string): number {
	const c = hexColor.slice(1);
	const channel = (i: number) => {
		const u = Number.parseInt(c.slice(i, i + 2), 16) / 255;
		return u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(fg: string, bg: string): number {
	const a = relativeLuminance(fg);
	const b = relativeLuminance(bg);
	const [hi, lo] = a > b ? [a, b] : [b, a];
	return (hi + 0.05) / (lo + 0.05);
}

afterEach(() => {
	setTerminalColors({});
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("tool-card diff contrast", () => {
	for (const base of ["dark", "light"] as const) {
		it(`${base}: added and removed diff lines read at >= 7:1 and keep distinct backgrounds`, () => {
			const theme = loadTheme(base);
			const successBg = colorToHex(theme.colors.toolSuccessBg);
			const errorBg = colorToHex(theme.colors.toolErrorBg);
			const added = colorToHex(theme.colors.toolDiffAdded);
			const removed = colorToHex(theme.colors.toolDiffRemoved);

			// The full line content (the diff foreground on its line background) is readable.
			expect(contrast(added, successBg)).toBeGreaterThanOrEqual(7);
			expect(contrast(removed, errorBg)).toBeGreaterThanOrEqual(7);
			// Added and removed lines must not collapse onto one shared background.
			expect(successBg).not.toBe(errorBg);
		});

		it(`${base}: general text contrast is not reduced below its current floor`, () => {
			const theme = loadTheme(base);
			const text = colorToHex(theme.colors.text);
			const muted = colorToHex(theme.colors.muted);
			const successBg = colorToHex(theme.colors.toolSuccessBg);

			expect(contrast(text, successBg)).toBeGreaterThanOrEqual(7);
			// Muted sits at or above its pre-change floor (dark 6.7, light ~3.99) on the card.
			expect(contrast(muted, successBg)).toBeGreaterThanOrEqual(3.9);
		});
	}
});
