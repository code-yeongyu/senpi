import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type HookStatusTickerPrototype = {
	startToolHookStatusTimer(this: HookStatusTickerThis): void;
};

type HookStatusTickerThis = {
	hookStatusIntervalId: ReturnType<typeof setInterval> | undefined;
	sessionManager: { getEntries(): readonly unknown[]; getEntryCount(): number };
	refreshToolHookStatuses(): void;
};

describe("InteractiveMode hook status ticker", () => {
	test("unrefs the interval handle when starting the hook status ticker", () => {
		// Given
		const prototype = InteractiveMode.prototype as unknown as HookStatusTickerPrototype;
		const intervalHandle = setInterval(() => {}, 60_000);
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(intervalHandle);
		const unrefSpy = vi.spyOn(intervalHandle, "unref");
		const fakeThis: HookStatusTickerThis = {
			hookStatusIntervalId: undefined,
			sessionManager: { getEntries: () => [], getEntryCount: () => 0 },
			refreshToolHookStatuses: vi.fn(),
		};

		try {
			// When
			prototype.startToolHookStatusTimer.call(fakeThis);

			// Then
			expect(setIntervalSpy).toHaveBeenCalledTimes(1);
			expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 32);
			expect(unrefSpy).toHaveBeenCalledTimes(1);
		} finally {
			clearInterval(intervalHandle);
			vi.restoreAllMocks();
		}
	});

	test("uses a one-second hook status cadence for large sessions", () => {
		const prototype = InteractiveMode.prototype as unknown as HookStatusTickerPrototype;
		const intervalHandle = setInterval(() => {}, 60_000);
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(intervalHandle);
		const fakeThis: HookStatusTickerThis = {
			hookStatusIntervalId: undefined,
			sessionManager: {
				getEntries: () => Array.from({ length: 1000 }),
				getEntryCount: () => 1000,
			},
			refreshToolHookStatuses: vi.fn(),
		};

		try {
			prototype.startToolHookStatusTimer.call(fakeThis);

			expect(setIntervalSpy).toHaveBeenCalledTimes(1);
			expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1_000);
		} finally {
			clearInterval(intervalHandle);
			vi.restoreAllMocks();
		}
	});
});
