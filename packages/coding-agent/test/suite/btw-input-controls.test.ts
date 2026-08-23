import { setKittyProtocolActive } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BTW_SWITCH_KEYBINDING, createBtwInputRouter } from "../../src/core/extensions/builtin/btw/input-controls.ts";
import { type KeybindingsConfig, KeybindingsManager } from "../../src/core/keybindings.ts";

afterEach(() => {
	setKittyProtocolActive(false);
});

function createHarness(
	options: { side?: boolean; idle?: boolean; dialog?: boolean; now?: number; bindings?: KeybindingsConfig } = {},
) {
	const manager = new KeybindingsManager(options.bindings);
	let side = options.side ?? false;
	let idle = options.idle ?? true;
	let dialog = options.dialog ?? false;
	let now = options.now ?? 0;
	const dispatch = vi.fn();
	const tryBeginBtwCommand = vi.fn(() => true);
	const tryBeginBtwClose = vi.fn(() => true);
	const tryBeginBtwMain = vi.fn(() => true);
	const router = createBtwInputRouter({
		isCurrentSide: () => side,
		isIdle: () => idle,
		isDialogActive: () => dialog,
		tryBeginBtwCommand,
		tryBeginBtwClose,
		tryBeginBtwMain,
		matchesKeybinding: (data, binding) => manager.matches(data, binding),
		dispatch,
		now: () => now,
	});
	return {
		dispatch,
		router,
		tryBeginBtwCommand,
		tryBeginBtwClose,
		tryBeginBtwMain,
		setIdle(value: boolean) {
			idle = value;
		},
		setDialog(value: boolean) {
			dialog = value;
		},
		setNow(value: number) {
			now = value;
		},
		setSide(value: boolean) {
			side = value;
		},
	};
}

describe("BTW switch keybinding", () => {
	it("suppresses a second shortcut while the first command is pending", () => {
		// Given
		const harness = createHarness();
		harness.tryBeginBtwCommand.mockReturnValueOnce(true).mockReturnValueOnce(false);

		// When
		const first = harness.router.handleInput("\x1f");
		const second = harness.router.handleInput("\x1f");

		// Then
		expect(first).toEqual({ consume: true });
		expect(second).toEqual({ consume: true });
		expect(harness.dispatch).toHaveBeenCalledOnce();
	});

	it("does not replace an already active dialog", () => {
		// Given
		const harness = createHarness({ dialog: true });

		// When
		const disposition = harness.router.handleInput("\x1f");

		// Then
		expect(disposition).toBeUndefined();
		expect(harness.dispatch).not.toHaveBeenCalled();
	});

	it("yields destructive Ctrl+C to an active dialog", () => {
		// Given
		const harness = createHarness({ side: true, dialog: true });

		// When
		const disposition = harness.router.handleInput("\x03");

		// Then
		expect(disposition).toBeUndefined();
		expect(harness.dispatch).not.toHaveBeenCalled();
	});

	it("opens the picker for Ctrl+/, Ctrl+_, and Ctrl+7", () => {
		// Given
		const harness = createHarness();
		setKittyProtocolActive(true);

		// When
		const dispositions = ["\x1b[47;5u", "\x1b[95;5u", "\x1b[55;5u"].map((input) => harness.router.handleInput(input));
		setKittyProtocolActive(false);
		const legacyDisposition = harness.router.handleInput("\x1f");

		// Then
		expect(dispositions).toEqual([{ consume: true }, { consume: true }, { consume: true }]);
		expect(legacyDisposition).toEqual({ consume: true });
		expect(harness.dispatch).toHaveBeenCalledTimes(4);
		expect(harness.dispatch).toHaveBeenNthCalledWith(1, "/btw");
		expect(harness.dispatch).toHaveBeenNthCalledWith(2, "/btw");
		expect(harness.dispatch).toHaveBeenNthCalledWith(3, "/btw");
		expect(harness.dispatch).toHaveBeenNthCalledWith(4, "/btw");
	});

	it("uses the configured switch binding instead of hard-coded keys", () => {
		// Given
		const harness = createHarness({
			bindings: {
				[BTW_SWITCH_KEYBINDING]: "alt+b",
			},
		});

		// When
		const configured = harness.router.handleInput("\x1bb");
		const removedDefault = harness.router.handleInput("\x1f");

		// Then
		expect(configured).toEqual({ consume: true });
		expect(removedDefault).toBeUndefined();
		expect(harness.dispatch).toHaveBeenCalledOnce();
		expect(harness.dispatch).toHaveBeenCalledWith("/btw");
	});
});

describe("BTW side input controls", () => {
	it("does not count dialog-cancel Escape toward the return pair", () => {
		// Given
		const harness = createHarness({ side: true, idle: true, dialog: true, now: 0 });

		// When
		const dialogEscape = harness.router.handleInput("\x1b");
		harness.setDialog(false);
		harness.setNow(500);
		const firstSessionEscape = harness.router.handleInput("\x1b");

		// Then
		expect(dialogEscape).toBeUndefined();
		expect(firstSessionEscape).toBeUndefined();
		expect(harness.dispatch).not.toHaveBeenCalled();
	});

	it("returns to Main only on the second idle interrupt inside one second", () => {
		// Given
		const harness = createHarness({ side: true, idle: true, now: 10_000 });

		// When
		const first = harness.router.handleInput("\x1b");
		harness.setNow(10_999);
		const second = harness.router.handleInput("\x1b");

		// Then
		expect(first).toBeUndefined();
		expect(second).toEqual({ consume: true });
		expect(harness.dispatch).toHaveBeenCalledOnce();
		expect(harness.dispatch).toHaveBeenCalledWith("/btw-main");
	});

	it("does not reuse a busy interrupt or an expired pair", () => {
		// Given
		const harness = createHarness({ side: true, idle: false, now: 20_000 });

		// When
		const busy = harness.router.handleInput("\x1b");
		harness.setIdle(true);
		harness.setNow(20_100);
		const afterBusy = harness.router.handleInput("\x1b");
		harness.setNow(21_101);
		const expired = harness.router.handleInput("\x1b");

		// Then
		expect([busy, afterBusy, expired]).toEqual([undefined, undefined, undefined]);
		expect(harness.dispatch).not.toHaveBeenCalled();
	});

	it("dispatches destructive close only for the current visible side", () => {
		// Given
		const side = createHarness({ side: true });
		const main = createHarness({ side: false });

		// When
		const sideDisposition = side.router.handleInput("\x03");
		const mainDisposition = main.router.handleInput("\x03");

		// Then
		expect(sideDisposition).toEqual({ consume: true });
		expect(side.dispatch).toHaveBeenCalledWith("/btw-close");
		expect(mainDisposition).toBeUndefined();
		expect(main.dispatch).not.toHaveBeenCalled();
	});

	it("suppresses a second destructive close while the first is pending", () => {
		// Given
		const harness = createHarness({ side: true });
		harness.tryBeginBtwClose.mockReturnValueOnce(true).mockReturnValueOnce(false);

		// When
		const first = harness.router.handleInput("\x03");
		const second = harness.router.handleInput("\x03");

		// Then
		expect(first).toEqual({ consume: true });
		expect(second).toEqual({ consume: true });
		expect(harness.dispatch).toHaveBeenCalledOnce();
		expect(harness.dispatch).toHaveBeenCalledWith("/btw-close");
	});
});
