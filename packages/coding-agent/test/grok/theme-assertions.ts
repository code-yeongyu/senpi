import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import {
	getThemeExportColors,
	initTheme,
	type ThemeBg,
	type ThemeColor,
	theme,
} from "../../src/modes/interactive/theme/theme.ts";

export const GROK_COLOR_MODES = [
	{ label: "truecolor", trueColor: true },
	{ label: "256color", trueColor: false },
] as const;

export function initGrokTheme(themeName: "grok-night" | "grok-day", trueColor: boolean): "truecolor" | "256color" {
	setCapabilities({ images: null, trueColor, hyperlinks: false });
	initTheme(themeName, false);
	return theme.getColorMode();
}

export function resetGrokThemeCapabilities(): void {
	resetCapabilitiesCache();
}

export function fg(color: ThemeColor, text: string): string {
	return theme.fg(color, text);
}

export function bg(color: ThemeBg, text: string): string {
	return theme.bg(color, text);
}

export function backgroundFromThemeExport(color: keyof ReturnType<typeof getThemeExportColors>, text: string): string {
	const hex = getThemeExportColors()[color];
	if (!hex) throw new Error(`Theme export color ${color} is not defined`);
	const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
	if (!match) throw new Error(`Theme export color ${color} is not a hex color: ${hex}`);
	const [, red, green, blue] = match;
	return `\x1b[48;2;${parseInt(red, 16)};${parseInt(green, 16)};${parseInt(blue, 16)}m${text}\x1b[49m`;
}
