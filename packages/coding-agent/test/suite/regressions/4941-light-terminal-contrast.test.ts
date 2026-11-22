import { rmSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type RgbColor, setCapabilityOverrides, type TerminalColors, Text, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { parseOscColorResponse } from "../../../../tui/src/terminal-colors.ts";
import { getAgentDir } from "../../../src/config.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { AssistantMessageComponent } from "../../../src/modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../../../src/modes/interactive/components/user-message.ts";
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

// Regression for https://github.com/code-yeongyu/senpi/issues/4941
// Contract: the default `system` theme keeps every text role at WCAG AA (4.5:1) on the fill it is drawn on, and
// never paints a message/tool fill lighter than a light terminal's own background.

type Appearance = "light" | "dark";
type TerminalCase = { name: string; appearance: Appearance; foreground: string; background: string };

/** OSC 10/11 replies as the terminals send them; the colors are injected, no real terminal is queried. */
const TERMINALS: TerminalCase[] = [
	{
		name: "catppuccin latte",
		appearance: "light",
		foreground: "\x1b]10;rgb:4c4c/4f4f/6969\x1b\\",
		background: "\x1b]11;rgb:efef/f1f1/f5f5\x1b\\",
	},
	{
		name: "github light",
		appearance: "light",
		foreground: "\x1b]10;rgb:1f1f/2323/2828\x1b\\",
		background: "\x1b]11;rgb:ffff/ffff/ffff\x1b\\",
	},
	{
		name: "stock ghostty dark",
		appearance: "dark",
		foreground: "\x1b]10;rgb:c5c5/c8c8/c6c6\x1b\\",
		background: "\x1b]11;rgb:1d1d/1f1f/2121\x1b\\",
	},
	{
		name: "iterm default dark",
		appearance: "dark",
		foreground: "\x1b]10;rgb:c7c7/c7c7/c7c7\x1b\\",
		background: "\x1b]11;rgb:0000/0000/0000\x1b\\",
	},
];

const TOOL_FILLS = ["toolPendingBg", "toolSuccessBg", "toolErrorBg"];
const MESSAGE_FILLS = ["userMessageBg", "customMessageBg"];
const FILLS = [...MESSAGE_FILLS, ...TOOL_FILLS];

/** Each text role and the surfaces it is drawn on. */
const ROLE_SURFACES: Record<"primary" | "secondary" | "dim", Record<string, string[]>> = {
	primary: {
		text: ["background", "selectedBg"],
		userMessageText: ["userMessageBg"],
		toolTitle: TOOL_FILLS,
	},
	secondary: {
		muted: ["background", "selectedBg", "customMessageBg", ...TOOL_FILLS],
		toolOutput: ["background", ...TOOL_FILLS],
		customMessageText: ["customMessageBg", ...TOOL_FILLS],
		thinkingText: ["background"],
		mdQuote: ["background", ...MESSAGE_FILLS],
		mdLinkUrl: ["background", ...MESSAGE_FILLS],
	},
	dim: {
		dim: ["background", "selectedBg", "customMessageBg", ...TOOL_FILLS],
	},
};

function rgb(data: string): RgbColor {
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

/** Applies the default theme the way interactive startup does, with the terminal's replies injected. */
async function applySystemTheme(terminal: TerminalCase) {
	const colors: TerminalColors = { foreground: rgb(terminal.foreground), background: rgb(terminal.background) };
	const controller = new InteractiveThemeController(fakeUi(colors), {
		getSettingsManager: () => SettingsManager.inMemory({}),
		showError: vi.fn(),
		onChanged: vi.fn(),
	});
	controller.applyFromSettings();
	await controller.waitForTerminalColors();
	controller.dispose();
	const resolved = getResolvedThemeColors();
	const background = colors.background as RgbColor;
	const rgbOf = (token: string): RgbColor =>
		token === "background"
			? background
			: resolved[token]
				? hexToRgb(resolved[token])
				: (colors.foreground as RgbColor);
	return { background, resolved, rgbOf };
}

beforeEach(() => {
	rmSync(join(getAgentDir(), "cache", "terminal-theme.json"), { force: true });
});

afterEach(() => {
	setCapabilityOverrides({});
	setTerminalColors({});
	setTerminalColorScheme(undefined);
	initTheme("dark");
});

describe("#4941 default theme text contrast on its fills", () => {
	for (const terminal of TERMINALS) {
		it(`${terminal.name}: detects ${terminal.appearance}, every text role >= 4.5:1 on its fill, no fill lighter than a light background`, async () => {
			const { background, resolved, rgbOf } = await applySystemTheme(terminal);

			expect(theme.name).toBe("system");
			expect(getTerminalTheme()).toBe(terminal.appearance);

			if (terminal.appearance === "light") {
				const lighterFills = FILLS.filter(
					(fill) => resolved[fill] && relativeLuminance(rgbOf(fill)) > relativeLuminance(background),
				);
				expect(lighterFills).toEqual([]);
			}

			const failures: string[] = [];
			for (const [role, tokens] of Object.entries(ROLE_SURFACES)) {
				for (const [token, surfaces] of Object.entries(tokens)) {
					for (const surface of surfaces) {
						const ratio = wcagContrast(rgbOf(token), rgbOf(surface));
						if (ratio < 4.5) failures.push(`${role} ${token} on ${surface}: ${ratio.toFixed(2)}:1`);
					}
				}
			}
			expect(failures).toEqual([]);
		});
	}
});

function assistantReply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

/** xterm cell colors of the first visible row containing `needle`. */
function rowColors(terminal: VirtualTerminal, needle: string): { fg: number; bg: number; bgRgb: boolean } {
	const buffer = Reflect.get(terminal, "xterm").buffer.active;
	for (let row = 0; row < buffer.length; row++) {
		const line = buffer.getLine(row);
		const column = line?.translateToString(true).indexOf(needle) ?? -1;
		if (line && column >= 0) {
			const cell = line.getCell(column);
			return { fg: cell.getFgColor(), bg: cell.getBgColor(), bgRgb: cell.isBgRGB() };
		}
	}
	throw new Error(`row with ${JSON.stringify(needle)} not rendered`);
}

const packed = ({ r, g, b }: RgbColor) => (r << 16) | (g << 8) | b;

describe("#4941 start screen and chat exchange render with the system theme's colors", () => {
	for (const terminal of TERMINALS.filter((entry) =>
		["catppuccin latte", "stock ghostty dark"].includes(entry.name),
	)) {
		it(`${terminal.name}: the virtual terminal receives the fill and text colors`, async () => {
			setCapabilityOverrides({ trueColor: true });
			const { rgbOf } = await applySystemTheme(terminal);

			const screen = new VirtualTerminal(100, 40);
			const writes: string[] = [];
			const write = screen.write.bind(screen);
			screen.write = (data: string) => {
				writes.push(data);
				write(data);
			};
			const ui = new TUI(screen);
			// Start screen: the compact startup header's roles (logo accent, version dim, separator muted).
			ui.addChild(
				new Text(
					`${theme.bold(theme.fg("accent", "senpi"))}${theme.fg("dim", " v0.0.0")}\n` +
						`esc interrupt${theme.fg("muted", " · ")}/ commands\n${theme.fg("dim", "Ask it how to use or extend Pi.")}`,
					1,
					0,
				),
			);
			ui.addChild(new UserMessageComponent("list the files"));
			const card = new ToolExecutionComponent("bash", "call-1", { command: "ls" }, {}, undefined, ui, process.cwd());
			card.updateResult({ content: [{ type: "text", text: "README.md" }], isError: false }, false);
			ui.addChild(card);
			ui.addChild(new AssistantMessageComponent(assistantReply("One file: README.md.")));
			ui.start();
			ui.renderNow(true);
			await screen.flush();
			ui.stop();

			const stream = writes.join("");
			const fg = (token: string) => {
				const { r, g, b } = rgbOf(token);
				return `\x1b[38;2;${r};${g};${b}m`;
			};
			const bg = (token: string) => {
				const { r, g, b } = rgbOf(token);
				return `\x1b[48;2;${r};${g};${b}m`;
			};
			for (const code of [
				fg("accent"),
				fg("dim"),
				fg("muted"),
				fg("toolOutput"),
				bg("userMessageBg"),
				bg("toolSuccessBg"),
			])
				expect(stream).toContain(code);

			const userRow = rowColors(screen, "list the files");
			expect(userRow.bgRgb).toBe(true);
			expect(userRow.bg).toBe(packed(rgbOf("userMessageBg")));
			const toolRow = rowColors(screen, "README.md");
			expect(toolRow.bg).toBe(packed(rgbOf("toolSuccessBg")));
			expect(toolRow.fg).toBe(packed(rgbOf("toolOutput")));
		});
	}
});
