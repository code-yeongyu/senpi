import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Markdown } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { getMarkdownTheme, loadThemeFromPath, setThemeInstance } from "../../src/modes/interactive/theme/theme.ts";

const tempDirs: string[] = [];

function writeDarkThemeVariant(name: string, colors: Record<string, string>): string {
	const themeJson = JSON.parse(
		readFileSync(new URL("../../src/modes/interactive/theme/dark.json", import.meta.url), "utf8"),
	) as { name: string; colors: Record<string, string | number> };
	themeJson.name = name;
	Object.assign(themeJson.colors, colors);
	const testDir = mkdtempSync(join(tmpdir(), "pi-markdown-emphasis-theme-"));
	tempDirs.push(testDir);
	const themePath = join(testDir, `${name}.json`);
	writeFileSync(themePath, JSON.stringify(themeJson));
	return themePath;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("markdown emphasis theme colors", () => {
	it("leaves emphasis text uncolored when the theme omits the tokens", () => {
		const theme = loadThemeFromPath(writeDarkThemeVariant("no-emphasis-colors", {}), "truecolor");

		expect(theme.markdownEmphasis("mdBold", "x")).toBe("x");
		expect(theme.markdownEmphasis("mdItalic", "x")).toBe("x");
		expect(theme.markdownEmphasis("mdStrikethrough", "x")).toBe("x");
	});

	it("colors emphasis text with the configured tokens", () => {
		const theme = loadThemeFromPath(
			writeDarkThemeVariant("emphasis-colors", {
				mdBold: "#ff8000",
				mdItalic: "#ffff00",
				mdStrikethrough: "#808080",
			}),
			"truecolor",
		);

		expect(theme.markdownEmphasis("mdBold", "x")).toBe("\x1b[38;2;255;128;0mx\x1b[39m");
		expect(theme.markdownEmphasis("mdItalic", "x")).toBe("\x1b[38;2;255;255;0mx\x1b[39m");
		expect(theme.markdownEmphasis("mdStrikethrough", "x")).toBe("\x1b[38;2;128;128;128mx\x1b[39m");
	});

	it("wires each token to its own inline markdown element", () => {
		setThemeInstance(
			loadThemeFromPath(
				writeDarkThemeVariant("emphasis-wiring", {
					mdBold: "#ff0000",
					mdItalic: "#00ff00",
					mdStrikethrough: "#0000ff",
				}),
				"truecolor",
			),
		);
		const lastForegroundBefore = (line: string, needle: string): string | undefined =>
			[...line.slice(0, line.indexOf(needle)).matchAll(/\x1b\[(?:3\d(?:;[\d;]*)?|39)m/g)].at(-1)?.[0];

		const output = new Markdown("**zip** *zed* ~~zot~~", 0, 0, getMarkdownTheme()).render(80).join("\n");

		expect(lastForegroundBefore(output, "zip")).toBe("\x1b[38;2;255;0;0m");
		expect(lastForegroundBefore(output, "zed")).toBe("\x1b[38;2;0;255;0m");
		expect(lastForegroundBefore(output, "zot")).toBe("\x1b[38;2;0;0;255m");
	});
});
