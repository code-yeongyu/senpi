import { type LoaderIndicatorOptions, resetCapabilitiesCache, setCapabilities, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	RetryStatusIndicator,
	WorkingStatusIndicator,
} from "../../src/modes/interactive/components/status-indicator.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1_000_000);
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	initTheme("dark");
});

afterEach(() => {
	vi.useRealTimers();
	resetCapabilitiesCache();
});

describe("status animation cadence", () => {
	it.each([999, 1000, 10_000])("animates Working ANSI before the seconds tick with %i entries", (entryCount) => {
		const startedAt = Date.now();
		const owner = {
			sessionManager: { getEntryCount: () => entryCount },
			getWorkingElapsedSeconds: () => Math.floor((Date.now() - startedAt) / 1000),
		};
		const options = Reflect.get(InteractiveMode.prototype, "getWorkingIndicatorOptions").call(
			owner,
		) as LoaderIndicatorOptions;
		const requestRender = vi.fn();
		const indicator = new WorkingStatusIndicator({ requestRender } as unknown as TUI, "Working", options);
		const frames: string[] = [];
		try {
			for (let frame = 0; frame < 31; frame++) {
				vi.advanceTimersByTime(32);
				const line = indicator.renderInBorder(100);
				expect(stripAnsi(line)).toContain("Working (0s");
				frames.push(line);
			}
			expect(new Set(frames).size).toBeGreaterThan(10);
			expect(requestRender.mock.calls.length).toBeGreaterThan(10);
			vi.advanceTimersByTime(32);
			expect(stripAnsi(indicator.renderInBorder(100))).toContain("Working (1s");
		} finally {
			indicator.dispose();
		}
		requestRender.mockClear();
		vi.advanceTimersByTime(5000);
		expect(requestRender).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("preserves explicit extension indicator options", () => {
		const options: LoaderIndicatorOptions = { frames: ["custom"], intervalMs: 250, messageIntervalMs: 400 };
		const owner = { workingIndicatorOptions: options };
		expect(Reflect.get(InteractiveMode.prototype, "getWorkingIndicatorOptions").call(owner)).toBe(options);
	});

	it("animates and stops the hook ticker in a large session", () => {
		const owner = {
			hookStatusIntervalId: undefined,
			sessionManager: { getEntryCount: () => 10_000 },
			refreshToolHookStatuses: vi.fn(),
		};
		Reflect.get(InteractiveMode.prototype, "startToolHookStatusTimer").call(owner);
		vi.advanceTimersByTime(96);
		expect(owner.refreshToolHookStatuses).toHaveBeenCalledTimes(3);
		Reflect.get(InteractiveMode.prototype, "stopToolHookStatusTimer").call(owner);
		vi.advanceTimersByTime(1000);
		expect(owner.refreshToolHookStatuses).toHaveBeenCalledTimes(3);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("animates a large-session retry without changing its countdown and disposes both timers", () => {
		const requestRender = vi.fn();
		let indicator: RetryStatusIndicator | undefined;
		const owner = {
			ui: { requestRender },
			sessionManager: { getEntryCount: () => 10_000 },
			showStatusIndicator(value: RetryStatusIndicator) {
				indicator = value;
			},
		};
		Reflect.get(InteractiveMode.prototype, "showRetryIndicator").call(owner, {
			attempt: 1,
			maxAttempts: 3,
			delayMs: 4000,
			errorMessage: "temporary failure",
		});
		expect(indicator).toBeInstanceOf(RetryStatusIndicator);
		try {
			const first = indicator!.renderInBorder(120);
			vi.advanceTimersByTime(80);
			const next = indicator!.renderInBorder(120);
			expect(next).not.toBe(first);
			expect(stripAnsi(next)).toContain("in 4s");
			vi.advanceTimersByTime(920);
			expect(stripAnsi(indicator!.renderInBorder(120))).toContain("in 3s");
		} finally {
			indicator?.dispose();
		}
		requestRender.mockClear();
		vi.advanceTimersByTime(5000);
		expect(requestRender).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});
