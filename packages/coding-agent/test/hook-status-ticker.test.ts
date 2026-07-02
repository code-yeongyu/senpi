import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type HookStatusTickerPrototype = {
	startToolHookStatusTimer(this: HookStatusTickerThis): void;
};

type HookStatusTickerThis = {
	hookStatusIntervalId: ReturnType<typeof setInterval> | undefined;
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
			refreshToolHookStatuses: vi.fn(),
		};

		try {
			// When
			prototype.startToolHookStatusTimer.call(fakeThis);

			// Then
			expect(setIntervalSpy).toHaveBeenCalledTimes(1);
			expect(unrefSpy).toHaveBeenCalledTimes(1);
		} finally {
			clearInterval(intervalHandle);
			vi.restoreAllMocks();
		}
	});
});
