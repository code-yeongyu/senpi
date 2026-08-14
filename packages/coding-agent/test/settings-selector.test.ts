import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("SettingsSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("cycles through fullscreen scrollbar modes", () => {
		const onChange = vi.fn();
		const selector = new SettingsSelectorComponent(
			{
				fullscreenScrollbar: "auto",
				defaultFastMode: true,
				warnings: {},
				availableThinkingLevels: [],
				availableThemes: [],
			} as unknown as SettingsConfig,
			{ onFullscreenScrollbarChange: onChange } as unknown as SettingsCallbacks,
		);
		const settingsList = selector.getSettingsList();

		for (const character of "Fullscreen scrollbar") settingsList.handleInput(character);
		settingsList.handleInput("\r");
		settingsList.handleInput("\r");
		settingsList.handleInput("\r");

		expect(onChange.mock.calls.flat()).toEqual(["always", "hidden", "auto"]);
	});

	it("toggles the default Fast mode preference", () => {
		const onChange = vi.fn();
		const selector = new SettingsSelectorComponent(
			{
				defaultFastMode: true,
				warnings: {},
				availableThinkingLevels: [],
				availableThemes: [],
			} as unknown as SettingsConfig,
			{ onDefaultFastModeChange: onChange } as unknown as SettingsCallbacks,
		);
		const settingsList = selector.getSettingsList();

		for (const character of "Default Fast mode") settingsList.handleInput(character);
		settingsList.handleInput("\r");

		expect(onChange).toHaveBeenCalledWith(false);
	});
});
