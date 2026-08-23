import type { KeyId } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import type { KeybindingsManager } from "../src/core/keybindings.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface ExtensionUiPrototype {
	createExtensionUIContext(this: {
		keybindings: Pick<KeybindingsManager, "getKeys" | "matches">;
		extensionSelector?: object;
		extensionInput?: object;
		extensionEditor?: object;
	}): ExtensionUIContext;
}

describe("InteractiveMode extension keybinding context", () => {
	it("matches extension input through the active keybinding manager", () => {
		// Given
		const matches = vi.fn(() => true);
		const getKeys = vi.fn((): KeyId[] => ["ctrl+7"]);
		const prototype = InteractiveMode.prototype as unknown as ExtensionUiPrototype;

		// When
		const ui = prototype.createExtensionUIContext.call({
			keybindings: { getKeys, matches },
		});
		const matched = ui.matchesKeybinding?.("terminal-sequence", "app.btw.switch");
		const keys = ui.getKeybindingKeys?.("app.btw.switch");

		// Then
		expect(matched).toBe(true);
		expect(matches).toHaveBeenCalledWith("terminal-sequence", "app.btw.switch");
		expect(keys).toEqual(["ctrl+7"]);
		expect(getKeys).toHaveBeenCalledWith("app.btw.switch");
	});

	it("reports selectors inputs and editors as active dialogs", () => {
		// Given
		const prototype = InteractiveMode.prototype as unknown as ExtensionUiPrototype;
		const keybindings = {
			getKeys: vi.fn((): KeyId[] => []),
			matches: vi.fn(() => false),
		};

		// When
		const states = ["extensionSelector", "extensionInput", "extensionEditor"].map((field) => {
			const ui = prototype.createExtensionUIContext.call({
				keybindings,
				[field]: {},
			});
			return ui.isDialogActive?.();
		});

		// Then
		expect(states).toEqual([true, true, true]);
	});
});
