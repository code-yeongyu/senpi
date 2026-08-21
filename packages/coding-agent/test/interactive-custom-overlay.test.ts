import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { KeybindingsManager } from "../src/core/keybindings.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, type Theme } from "../src/modes/interactive/theme/theme.ts";

type CustomFactory<T> = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: T) => void,
) => Component;

interface ShowCustomThis {
	readonly editor: { getText(): string };
	readonly keybindings: KeybindingsManager;
	readonly ui: TUI;
}

interface ShowCustomPrototype {
	showExtensionCustom<T>(
		this: ShowCustomThis,
		factory: CustomFactory<T>,
		options: {
			overlay: true;
			overlayOptions?: OverlayOptions;
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T>;
}

function createHandle() {
	let hidden = false;
	let focused = false;
	return {
		hide: vi.fn(() => {
			hidden = true;
		}),
		setHidden: vi.fn((next: boolean) => {
			hidden = next;
		}),
		isHidden: () => hidden,
		focus: vi.fn(() => {
			focused = true;
		}),
		unfocus: vi.fn(() => {
			focused = false;
		}),
		isFocused: () => focused,
	};
}

describe("InteractiveMode extension custom overlays", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("closes the overlay owned by the completing custom call instead of the topmost overlay", async () => {
		const ownedHandle = createHandle();
		const newerHandle = createHandle();
		const stack: ReturnType<typeof createHandle>[] = [];
		const ui = {
			showOverlay: vi.fn(() => {
				stack.push(ownedHandle);
				return ownedHandle;
			}),
			hideOverlay: vi.fn(() => {
				stack.pop()?.hide();
			}),
		} as unknown as TUI;
		const fakeThis: ShowCustomThis = {
			editor: { getText: () => "parent draft" },
			keybindings: {} as KeybindingsManager,
			ui,
		};
		const prototype = InteractiveMode.prototype as unknown as ShowCustomPrototype;
		let done: ((result: string) => void) | undefined;

		const resultPromise = prototype.showExtensionCustom.call(
			fakeThis,
			(_tui, _theme, _keybindings, complete) => {
				done = complete;
				return { render: () => ["owned"], invalidate: () => undefined };
			},
			{ overlay: true },
		);
		await Promise.resolve();
		await Promise.resolve();
		stack.push(newerHandle);
		done?.("closed");

		await expect(resultPromise).resolves.toBe("closed");
		expect(ownedHandle.hide).toHaveBeenCalledOnce();
		expect(newerHandle.hide).not.toHaveBeenCalled();
		expect(ui.hideOverlay).not.toHaveBeenCalled();
	});
});
