import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("SettingsSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("cycles through fullscreen settings", () => {
		const onExitOutputChange = vi.fn();
		const onScrollbarChange = vi.fn();
		const onCopyOnSelectChange = vi.fn();
		const onWheelScrollLinesChange = vi.fn();
		const config = {
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
			fullscreenCopyOnSelect: true,
			fullscreenWheelScrollLines: 7,
			warnings: {},
			defaultModel: "not set",
			availableDefaultModels: [],
			availableThinkingLevels: [],
			modelThinkingLevels: {},
			availableThemes: [],
		} as unknown as SettingsConfig;
		const callbacks = {
			onFullscreenExitOutputChange: onExitOutputChange,
			onFullscreenScrollbarChange: onScrollbarChange,
			onFullscreenCopyOnSelectChange: onCopyOnSelectChange,
			onFullscreenWheelScrollLinesChange: onWheelScrollLinesChange,
		} as unknown as SettingsCallbacks;

		const cycle = (label: string, count: number) => {
			const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
			for (const character of label) list.handleInput(character);
			for (let i = 0; i < count; i++) list.handleInput("\r");
		};

		cycle("Fullscreen exit output", 2);
		expect(onExitOutputChange.mock.calls.flat()).toEqual(["resume-hint", "transcript"]);
		cycle("Fullscreen scrollbar", 3);
		expect(onScrollbarChange.mock.calls.flat()).toEqual(["always", "hidden", "auto"]);
		cycle("Fullscreen copy on select", 2);
		expect(onCopyOnSelectChange.mock.calls.flat()).toEqual([false, true]);
		// #9758: custom values from settings.json stay in the cycle.
		cycle("Fullscreen wheel scrolling", 3);
		expect(onWheelScrollLinesChange.mock.calls.flat()).toEqual([10, "auto", 1]);
	});

	it("keeps the configured fixed theme marked while browsing", () => {
		const config = {
			defaultModel: "not set",
			availableDefaultModels: [],
			modelThinkingLevels: {},
			currentTheme: "dark",
			terminalTheme: "dark",
			availableThemes: ["system", "dark", "light"],
			warnings: {},
		} as unknown as SettingsConfig;
		const callbacks = { onThemePreview: vi.fn(), onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("theme");
		list.handleInput("\r");
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toMatch(
			/ {4}system +Theme created from your terminal's colors\n {4}automatic +Use separate themes/,
		);
		expect(output).toContain("→ ✓ dark");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ dark");
		expect(output).toContain("→   light");
	});

	it("keeps a configured automatic theme marked while browsing", () => {
		const config = {
			defaultModel: "not set",
			availableDefaultModels: [],
			modelThinkingLevels: {},
			currentTheme: "light/dark",
			terminalTheme: "dark",
			availableThemes: ["dark", "light", "other"],
			warnings: {},
		} as unknown as SettingsConfig;
		const callbacks = { onThemePreview: vi.fn(), onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("theme");
		list.handleInput("\r");
		list.handleInput("\r");
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("→ ✓ light");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ light");
		expect(output).toContain("→   other");
	});

	it("pre-selects the configured thinking level in the settings submenu while browsing", () => {
		// Upstream sync (5133c9284, adopted by the merge): the settings selector dropped the
		// per-model thinking row; per-model thinking memory stays covered by settings-manager
		// and per-model-thinking-memory tests. The configured global level is now pre-selected
		// in the "Thinking level" submenu.
		const config = {
			defaultModel: "not set",
			availableDefaultModels: [],
			thinkingLevel: "medium",
			availableThinkingLevels: ["medium", "high"],
			modelThinkingLevels: {},
			currentTheme: "dark",
			terminalTheme: "dark",
			availableThemes: ["dark", "light"],
			warnings: {},
		} as unknown as SettingsConfig;
		const callbacks = { onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("thinking");
		list.handleInput("\r");

		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("→ medium");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  medium");
		expect(output).toContain("→ high");
	});
});
