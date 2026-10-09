import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type WorkingThis = {
	workingVisible: boolean;
	session: { isStreaming: boolean };
	activeStatusIndicator: { kind: string } | undefined;
	chrome: { createWorkingIndicator: (...args: unknown[]) => { kind: string } } | undefined;
	ui: { requestRender: () => void };
	workingMessage: string | undefined;
	defaultWorkingMessage: string;
	getWorkingIndicatorOptions: () => undefined;
	showStatusIndicator: (indicator: { kind: string }) => void;
	clearStatusIndicator: (kind: string) => void;
};

const setWorkingVisible = (
	InteractiveMode.prototype as unknown as { setWorkingVisible(this: WorkingThis, visible: boolean): void }
).setWorkingVisible;

// Guards the 2026-09-05 "Restore Working text shimmer formatter" merge fix: when a chrome is configured,
// interactive mode shows the chrome's own working indicator, once, instead of building the default one.
describe("working indicator construction", () => {
	it("shows the configured chrome indicator exactly once while streaming", () => {
		const chromeIndicator = { kind: "working" };
		const createWorkingIndicator = vi.fn((..._args: unknown[]) => chromeIndicator);
		const showStatusIndicator = vi.fn();
		const self: WorkingThis = {
			workingVisible: false,
			session: { isStreaming: true },
			activeStatusIndicator: undefined,
			chrome: { createWorkingIndicator },
			ui: { requestRender: vi.fn() },
			workingMessage: "Thinking",
			defaultWorkingMessage: "Working",
			getWorkingIndicatorOptions: () => undefined,
			showStatusIndicator,
			clearStatusIndicator: vi.fn(),
		};

		setWorkingVisible.call(self, true);

		expect(createWorkingIndicator).toHaveBeenCalledTimes(1);
		expect(createWorkingIndicator.mock.calls[0]?.[1]).toBe("Thinking");
		expect(showStatusIndicator).toHaveBeenCalledTimes(1);
		expect(showStatusIndicator).toHaveBeenCalledWith(chromeIndicator);
	});
});
