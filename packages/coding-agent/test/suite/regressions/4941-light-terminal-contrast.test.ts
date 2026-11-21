import { rmSync } from "node:fs";
import { join } from "node:path";
import type { RgbColor, TerminalColors, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../../../src/config.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { relativeLuminance, wcagContrast } from "../../../src/modes/interactive/theme/system-theme.ts";
import {
	getResolvedThemeColors,
	getTerminalTheme,
	initTheme,
	setTerminalColorScheme,
	setTerminalColors,
	theme,
} from "../../../src/modes/interactive/theme/theme.ts";
import { InteractiveThemeController } from "../../../src/modes/interactive/theme/theme-controller.ts";
import { parseOscColorResponse } from "../../../../tui/src/terminal-colors.ts";

// Regression for https://github.com/code-yeongyu/senpi/issues/4941

const DARK_TERMINAL_REPLIES: Record<string, { foreground: string; background: string }> = {
	"iterm default dark": {
		foreground: "\x1b]10;rgb:c7c7/c7c7/c7c7\x1b\\",
		background: "\x1b]11;rgb:0000/0000/0000\x1b\\",
	},
};

const GHOSTTY_STYLE_LIGHT_TERMINAL_REPLIES: Record<string, { foreground: string; background: string }> = {
	"catppuccin latte": {
		foreground: "\x1b]10;rgb:4c4c/4f4f/6969\x1b\\",
		background: "\x1b]11;rgb:efef/f1f1/f5f5\x1b\\",
	},
	"github light": {
		foreground: "\x1b]10;rgb:1f1f/2323/2828\x1b\\",
		background: "\x1b]11;rgb:ffff/ffff/ffff\x1b\\",
	},
};

const TEXT_TOKEN_SURFACES: Record<string, string[]> = {
	text: ["background"],
	userMessageText: ["userMessageBg"],
	toolTitle: ["toolPendingBg", "toolSuccessBg", "toolErrorBg"],
	toolOutput: ["background", "toolPendingBg", "toolSuccessBg", "toolErrorBg"],
	customMessageText: ["customMessageBg"],
	muted: ["background", "toolPendingBg", "toolSuccessBg", "toolErrorBg"],
	dim: ["background", "toolPendingBg", "toolSuccessBg", "toolErrorBg"],
	thinkingText: ["background"],
	mdQuote: ["background"],
	mdLinkUrl: ["background"],
};
const FILLS = ["userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg", "selectedBg"];

function reply(data: string): RgbColor {
	const parsed = parseOscColorResponse(data);
	if (!parsed?.rgb) throw new Error(`not an OSC color reply: ${JSON.stringify(data)}`);
	return parsed.rgb;
}

function hexToRgb(hex: string): RgbColor {
	return {
		r: Number.parseInt(hex.slice(1, 3), 16),
		g: Number.parseInt(hex.slice(3, 5), 16),
		b: Number.parseInt(hex.slice(5, 7), 16),
	};
}

function fakeUi(colors: TerminalColors): TUI {
	return {
		invalidate: vi.fn(),
		requestRender: vi.fn(),
		setTerminalColorSchemeNotifications: vi.fn(),
		onTerminalColorSchemeChange: vi.fn(() => vi.fn()),
		queryTerminalColors: vi.fn(async () => colors),
	} as unknown as TUI;
}

beforeEach(() => {
	rmSync(join(getAgentDir(), "cache", "terminal-theme.json"), { force: true });
});

afterEach(() => {
	setTerminalColors({});
	setTerminalColorScheme(undefined);
	initTheme("dark");
});

describe("#4941 default theme text contrast on its fills", () => {
	const cases = [
		...Object.entries(GHOSTTY_STYLE_LIGHT_TERMINAL_REPLIES).map(([name, osc]) => ({
			name,
			osc,
			appearance: "light" as const,
		})),
		...Object.entries(DARK_TERMINAL_REPLIES).map(([name, osc]) => ({ name, osc, appearance: "dark" as const })),
	];
	for (const { name, osc, appearance } of cases) {
		it(`${name}: detects ${appearance}, keeps light-terminal fills at or below the background, and text at >= 4.5:1`, async () => {
			const colors: TerminalColors = { foreground: reply(osc.foreground), background: reply(osc.background) };
			const controller = new InteractiveThemeController(fakeUi(colors), {
				getSettingsManager: () => SettingsManager.inMemory({}),
				showError: vi.fn(),
				onChanged: vi.fn(),
			});
			controller.applyFromSettings();
			await controller.waitForTerminalColors();

			expect(theme.name).toBe("system");
			expect(getTerminalTheme()).toBe(appearance);

			const background = colors.background as RgbColor;
			const resolved = getResolvedThemeColors();
			const terminalDefaultForeground = colors.foreground as RgbColor;
			const rgbOf = (token: string): RgbColor =>
				token === "background"
					? background
					: resolved[token]
						? hexToRgb(resolved[token])
						: terminalDefaultForeground;

			const lighterFills = FILLS.filter(
				(fill) => resolved[fill] && relativeLuminance(rgbOf(fill)) > relativeLuminance(background),
			);
			if (appearance === "light") expect(lighterFills).toEqual([]);

			const failures: string[] = [];
			for (const [token, surfaces] of Object.entries(TEXT_TOKEN_SURFACES)) {
				for (const surface of surfaces) {
					const ratio = wcagContrast(rgbOf(token), rgbOf(surface));
					if (ratio < 4.5) failures.push(`${token} on ${surface}: ${ratio.toFixed(2)}:1`);
				}
			}
			expect(failures).toEqual([]);
			controller.dispose();
		});
	}
});
