import { getThemeExportColors, theme } from "../theme/theme.ts";

export type ChromeTextStyle = (text: string) => string;

/**
 * Chrome-only semantic tokens. Foreground/status tokens delegate to the active
 * interactive theme; the panel token is the theme export's card background.
 * This keeps grok chrome coherent for grok-day and custom themes instead of
 * embedding the grok-night capture values in components.
 */
export interface GrokChromeTokens {
	readonly inputBorder: ChromeTextStyle;
	readonly inputInterior: ChromeTextStyle;
	readonly surface: ChromeTextStyle;
	readonly cardBorder: ChromeTextStyle;
	readonly modelLabel: ChromeTextStyle;
	readonly cwd: ChromeTextStyle;
	readonly primaryText: ChromeTextStyle;
	readonly mutedText: ChromeTextStyle;
	readonly success: ChromeTextStyle;
	readonly error: ChromeTextStyle;
	readonly warning: ChromeTextStyle;
}

function backgroundFromThemeExport(hex: string): ChromeTextStyle | undefined {
	const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
	if (!match) return undefined;
	const [, red, green, blue] = match;
	return (text: string) =>
		`\x1b[48;2;${parseInt(red, 16)};${parseInt(green, 16)};${parseInt(blue, 16)}m${text}\x1b[49m`;
}

export function getGrokChromeTokens(): GrokChromeTokens {
	const themeExport = getThemeExportColors();
	const panelBackground = themeExport.cardBg;
	const pageBackground = themeExport.pageBg;
	return {
		inputBorder: (text) => theme.fg("borderAccent", text),
		inputInterior: backgroundFromThemeExport(panelBackground ?? "") ?? ((text) => theme.bg("toolPendingBg", text)),
		surface: backgroundFromThemeExport(pageBackground ?? "") ?? ((text) => text),
		cardBorder: (text) => theme.fg("borderMuted", text),
		modelLabel: (text) => theme.fg("thinkingText", text),
		cwd: (text) => theme.fg("dim", text),
		primaryText: (text) => theme.fg("text", text),
		mutedText: (text) => theme.fg("muted", text),
		success: (text) => theme.fg("success", text),
		error: (text) => theme.fg("error", text),
		warning: (text) => theme.fg("warning", text),
	};
}
