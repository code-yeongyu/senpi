import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { InteractiveMode, shouldShowRetryIndicator } from "../src/modes/interactive/interactive-mode.ts";

type FallbackLifecycleFixture = {
	isInitialized: true;
	footer: { invalidate: () => void };
	fallbackAppliedBeforeRetryStart: boolean;
	showWarning: (message: string) => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	setExtensionStatus: (key: string, text: string | undefined) => void;
};

type InteractiveEventHandler = {
	handleEvent(this: FallbackLifecycleFixture, event: AgentSessionEvent): Promise<void>;
};

function createFixture(): FallbackLifecycleFixture {
	return {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		fallbackAppliedBeforeRetryStart: false,
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		setExtensionStatus: vi.fn(),
	};
}

const handleEvent = (InteractiveMode.prototype as unknown as InteractiveEventHandler).handleEvent;

describe("InteractiveMode fallback lifecycle", () => {
	it("renders fallback notices and maintains the fallback footer status", async () => {
		const fixture = createFixture();

		await handleEvent.call(fixture, {
			type: "retry_fallback_applied",
			from: "faux/faux-1",
			to: "faux/faux-2",
			chainKey: "faux/faux-1",
			reason: "transient",
		});
		await handleEvent.call(fixture, {
			type: "retry_fallback_succeeded",
			model: "faux/faux-2",
			chainKey: "faux/faux-1",
		});
		await handleEvent.call(fixture, {
			type: "retry_fallback_reverted",
			from: "faux/faux-2",
			to: "faux/faux-1",
		});
		await handleEvent.call(fixture, {
			type: "retry_fallback_exhausted",
			chainKey: "faux/faux-1",
			lastError: "all models unavailable",
		});

		expect(fixture.showWarning).toHaveBeenCalledWith("Model fallback: faux/faux-1 -> faux/faux-2 (transient)");
		expect(fixture.showStatus).toHaveBeenNthCalledWith(1, "Fallback model faux/faux-2 responded");
		expect(fixture.showStatus).toHaveBeenNthCalledWith(2, "Reverted to faux/faux-1");
		expect(fixture.showError).toHaveBeenCalledWith(
			"Fallback chain exhausted for faux/faux-1: all models unavailable",
		);
		expect(fixture.setExtensionStatus).toHaveBeenNthCalledWith(1, "fallback", "fallback: faux/faux-2");
		expect(fixture.setExtensionStatus).toHaveBeenNthCalledWith(2, "fallback", undefined);
		expect(fixture.setExtensionStatus).toHaveBeenNthCalledWith(3, "fallback", undefined);
	});
});

describe("shouldShowRetryIndicator", () => {
	it("suppresses only zero-delay retries that immediately apply a fallback", () => {
		expect(shouldShowRetryIndicator(0, true)).toBe(false);
		expect(shouldShowRetryIndicator(0, false)).toBe(true);
		expect(shouldShowRetryIndicator(1, true)).toBe(true);
	});
});
