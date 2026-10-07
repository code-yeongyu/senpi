import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TerminalColors, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../src/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { readTerminalThemeHint } from "../src/modes/interactive/theme/terminal-theme-cache.ts";
import {
	initTheme,
	setTerminalColorScheme,
	setTerminalColors,
	type TerminalTheme,
	theme,
} from "../src/modes/interactive/theme/theme.ts";
import { InteractiveThemeController } from "../src/modes/interactive/theme/theme-controller.ts";

beforeEach(() => {
	// A controller seeds its terminal theme from the persisted detection hint, so each case has to
	// start without one or it inherits whatever the previous case detected.
	rmSync(join(getAgentDir(), "cache", "terminal-theme.json"), { force: true });
});

const DARK: TerminalColors = { foreground: { r: 248, g: 248, b: 242 }, background: { r: 40, g: 42, b: 54 } };
const LIGHT: TerminalColors = { foreground: { r: 30, g: 30, b: 30 }, background: { r: 250, g: 250, b: 250 } };

type ColorQueryOptions = { timeoutMs: number; onLateReply?: (colors: TerminalColors) => void };

function createUi() {
	const queryTerminalColors = vi.fn(async (_options: ColorQueryOptions): Promise<TerminalColors> => ({}));
	const setTerminalColorSchemeNotifications = vi.fn();
	let terminalColorSchemeListener: ((terminalTheme: TerminalTheme) => void) | undefined;
	const unsubscribeTerminalColorScheme = vi.fn();
	const ui = {
		invalidate: vi.fn(),
		requestRender: vi.fn(),
		setTerminalColorSchemeNotifications,
		onTerminalColorSchemeChange: vi.fn((listener: (terminalTheme: TerminalTheme) => void) => {
			terminalColorSchemeListener = listener;
			return unsubscribeTerminalColorScheme;
		}),
		queryTerminalColors,
	} as unknown as TUI;
	return {
		ui,
		queryTerminalColors,
		setTerminalColorSchemeNotifications,
		unsubscribeTerminalColorScheme,
		emitTerminalColorScheme: (terminalTheme: TerminalTheme) => terminalColorSchemeListener?.(terminalTheme),
	};
}

function createController(ui: TUI, getSettingsManager: () => SettingsManager, initialThemeSetting?: string) {
	return new InteractiveThemeController(ui, {
		getSettingsManager,
		showError: vi.fn(),
		onChanged: vi.fn(),
		initialThemeSetting,
	});
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
	setTerminalColors({});
	setTerminalColorScheme(undefined);
	initTheme("dark");
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe("InteractiveThemeController", () => {
	it("uses the initial theme without persisting it", async () => {
		const { ui, queryTerminalColors } = createUi();
		const manager = SettingsManager.inMemory({ theme: "dark" });
		const setTheme = vi.spyOn(manager, "setTheme");
		const flushSettings = vi.spyOn(manager, "flush");
		const controller = createController(ui, () => manager, "light");

		expect(theme.name).toBe("light");
		expect(controller.getThemeSelection()).toBe("light");
		controller.applyFromSettings();
		await flush();

		expect(queryTerminalColors).toHaveBeenCalledOnce();
		expect(setTheme).not.toHaveBeenCalled();
		expect(flushSettings).not.toHaveBeenCalled();
	});

	it("applies the theme immediately and lets startup wait for the colors", async () => {
		const { ui, queryTerminalColors } = createUi();
		let answer: (colors: TerminalColors) => void = () => {};
		queryTerminalColors.mockReturnValue(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		const controller = createController(ui, () => SettingsManager.inMemory());
		controller.applyFromSettings();

		// Grayscale until the terminal answers.
		expect(theme.name).toBe("system");
		expect(theme.getFgAnsi("error")).toBe("\x1b[39m");

		answer(DARK);
		await controller.waitForTerminalColors();
		expect(theme.getFgAnsi("error")).toMatch(/^\x1b\[38;/);
	});

	it("falls back to palette indices, then applies colors that arrive after the timeout", async () => {
		const { ui, queryTerminalColors } = createUi();
		let lateReply: (colors: TerminalColors) => void = () => {};
		queryTerminalColors.mockImplementation(async (options) => {
			lateReply = options.onLateReply!;
			return {};
		});
		const controller = createController(ui, () => SettingsManager.inMemory());
		controller.applyFromSettings();
		await flush();
		expect(theme.getFgAnsi("error")).toBe("\x1b[38;5;1m");

		lateReply(DARK);
		expect(theme.colors.error.kind).toBe("rgb");
	});

	it("re-queries the colors on appearance changes and lets them decide", async () => {
		const { ui, queryTerminalColors, setTerminalColorSchemeNotifications, emitTerminalColorScheme } = createUi();
		queryTerminalColors.mockResolvedValue(LIGHT);
		const controller = createController(ui, () => SettingsManager.inMemory(), "light/dark");
		controller.applyFromSettings();
		expect(setTerminalColorSchemeNotifications).toHaveBeenCalledWith(true);
		await flush();
		expect(theme.name).toBe("light");

		queryTerminalColors.mockResolvedValue(DARK);
		// The report says light, but the terminal renders dark.
		emitTerminalColorScheme("light");
		await flush();
		expect(theme.name).toBe("dark");
	});

	it("uses the reported scheme for the system theme when the terminal reports no colors", async () => {
		vi.stubEnv("COLORFGBG", "");
		const { ui, emitTerminalColorScheme } = createUi();
		const controller = createController(ui, () => SettingsManager.inMemory());
		controller.applyFromSettings();
		await flush();
		expect(theme.appearance).toBe("dark");

		emitTerminalColorScheme("light");
		expect(theme.appearance).toBe("light");
		expect(controller.getTerminalTheme()).toBe("light");
	});

	it("re-renders only when the reported colors change", async () => {
		const { ui, queryTerminalColors } = createUi();
		const controller = createController(ui, () => SettingsManager.inMemory({ theme: "dark" }));
		const query = async (colors: TerminalColors) => {
			queryTerminalColors.mockResolvedValue(colors);
			controller.applyFromSettings();
			await flush();
		};

		await query(DARK);
		// A timeout keeps the known colors; erasing them would count as a change and re-render.
		await query({});
		await query(structuredClone(DARK));
		expect(ui.requestRender).toHaveBeenCalledOnce();
	});

	it("disables terminal appearance updates when disposed", async () => {
		const { ui, setTerminalColorSchemeNotifications, unsubscribeTerminalColorScheme } = createUi();
		const controller = createController(ui, () => SettingsManager.inMemory({ theme: "light/dark" }));
		controller.applyFromSettings();
		await flush();

		controller.dispose();

		expect(setTerminalColorSchemeNotifications).toHaveBeenLastCalledWith(false);
		expect(unsubscribeTerminalColorScheme).toHaveBeenCalledOnce();
	});

	it("detects the current terminal appearance when selecting a theme pair", async () => {
		vi.stubEnv("COLORFGBG", "");
		const { ui, queryTerminalColors } = createUi();
		queryTerminalColors.mockResolvedValue(LIGHT);
		const manager = SettingsManager.inMemory({ theme: "dark" });
		const controller = createController(ui, () => manager);

		expect(theme.name).toBe("dark");
		controller.setThemeSetting("light/dark");
		await controller.waitForTerminalColors();
		expect(theme.name).toBe("light");
		expect(queryTerminalColors).toHaveBeenCalledOnce();
	});

	it("lets an explicit selection replace the initial theme", async () => {
		const { ui } = createUi();
		const firstManager = SettingsManager.inMemory({ theme: "dark" });
		const secondManager = SettingsManager.inMemory({ theme: "light" });
		let manager = firstManager;
		const controller = createController(ui, () => manager, "light");
		controller.applyFromSettings();

		expect(controller.setThemeName("dark")).toEqual({ success: true });
		manager = secondManager;
		controller.applyFromSettings();
		await flush();

		expect(controller.getThemeSelection()).toBe("dark");
		expect(theme.name).toBe("dark");
	});

	it("reloads theme settings when no initial theme was supplied", async () => {
		const { ui } = createUi();
		const firstManager = SettingsManager.inMemory({ theme: "dark" });
		const secondManager = SettingsManager.inMemory({ theme: "light" });
		let manager = firstManager;
		const controller = createController(ui, () => manager);
		controller.applyFromSettings();

		firstManager.applyOverrides({ theme: "light" });
		controller.applyFromSettings();
		expect(theme.name).toBe("light");

		secondManager.applyOverrides({ theme: "dark" });
		manager = secondManager;
		controller.applyFromSettings();
		expect(theme.name).toBe("dark");
	});
});

/** A terminal that never answers: the query resolves with no colors once its timeout elapses. */
function unansweredColorQuery(timeoutMs: number): Promise<TerminalColors> {
	return new Promise((resolve) => {
		setTimeout(() => resolve({}), timeoutMs);
	});
}

async function expectApplyFromSettingsDoesNotWait(apply: () => void | Promise<void>): Promise<void> {
	let settled = false;
	void Promise.resolve(apply()).then(() => {
		settled = true;
	});
	await vi.advanceTimersByTimeAsync(0);
	expect(settled).toBe(true);
}

describe("InteractiveThemeController startup detection", () => {
	it("does not wait for an unanswered terminal color query", async () => {
		vi.useFakeTimers();
		vi.stubEnv("COLORFGBG", "");
		const { ui, queryTerminalColors } = createUi();
		queryTerminalColors.mockImplementation(({ timeoutMs }) => unansweredColorQuery(timeoutMs));
		const manager = SettingsManager.inMemory({});
		const controller = createController(ui, () => manager);

		await expectApplyFromSettingsDoesNotWait(() => controller.applyFromSettings());

		expect(queryTerminalColors).toHaveBeenCalledOnce();
		expect(theme.name).toBe("system");
		expect(manager.getThemeSetting()).toBeUndefined();
		controller.dispose();
	});

	it("seeds the first frame from the persisted terminal theme instead of re-guessing", async () => {
		// Given: an auto theme, a terminal that never answers, and a remembered light background
		vi.useFakeTimers();
		vi.stubEnv("COLORFGBG", "");
		writeFileSync(
			join(
				mkdirSync(join(getAgentDir(), "cache"), { recursive: true }) ?? join(getAgentDir(), "cache"),
				"terminal-theme.json",
			),
			JSON.stringify({ terminalTheme: "light" }),
		);
		const { ui, queryTerminalColors } = createUi();
		queryTerminalColors.mockImplementation(({ timeoutMs }) => unansweredColorQuery(timeoutMs));
		const manager = SettingsManager.inMemory({ theme: "light/dark" });
		const controller = createController(ui, () => manager);

		// When
		await expectApplyFromSettingsDoesNotWait(() => controller.applyFromSettings());

		// Then: the remembered background wins over the environment guess, so there is no repaint
		expect(theme.name).toBe("light");
		controller.dispose();
	});

	it("does not wait for an unanswered auto theme query", async () => {
		vi.useFakeTimers();
		vi.stubEnv("COLORFGBG", "");
		const { ui, queryTerminalColors, setTerminalColorSchemeNotifications } = createUi();
		queryTerminalColors.mockImplementation(({ timeoutMs }) => unansweredColorQuery(timeoutMs));
		const manager = SettingsManager.inMemory({ theme: "light/dark" });
		const controller = createController(ui, () => manager);

		await expectApplyFromSettingsDoesNotWait(() => controller.applyFromSettings());

		expect(queryTerminalColors).toHaveBeenCalledOnce();
		expect(setTerminalColorSchemeNotifications).toHaveBeenCalledWith(true);
		expect(theme.name).toBe("dark");
		controller.dispose();
	});

	it("applies a late color answer after startup has moved on without persisting a theme", async () => {
		vi.useFakeTimers();
		vi.stubEnv("COLORFGBG", "");
		const { ui, queryTerminalColors } = createUi();
		const colors = Promise.withResolvers<TerminalColors>();
		queryTerminalColors.mockImplementation(() => colors.promise);
		const manager = SettingsManager.inMemory({});
		const setTheme = vi.spyOn(manager, "setTheme");
		const controller = createController(ui, () => manager);

		await expectApplyFromSettingsDoesNotWait(() => controller.applyFromSettings());
		expect(theme.name).toBe("system");
		expect(theme.appearance).toBe("dark");

		colors.resolve(LIGHT);
		await controller.waitForTerminalColors();

		// Without a theme setting the system theme follows the terminal; nothing is written to settings.
		expect(theme.name).toBe("system");
		expect(theme.appearance).toBe("light");
		expect(setTheme).not.toHaveBeenCalled();
		expect(manager.getThemeSetting()).toBeUndefined();
		controller.dispose();
	});

	it("remembers the reported terminal appearance for the next launch", async () => {
		const { ui, queryTerminalColors } = createUi();
		queryTerminalColors.mockResolvedValue(LIGHT);
		const controller = createController(ui, () => SettingsManager.inMemory({ theme: "light/dark" }));
		controller.applyFromSettings();
		await controller.waitForTerminalColors();

		expect(readTerminalThemeHint()).toBe("light");
		controller.dispose();
	});
});
