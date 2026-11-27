/**
 * A coordinated producer reports `progress` from its own event loop while it starts, so the launcher extends a slow
 * phase that is still moving and fails one that went quiet. The heartbeat ends with the attempt's decision budget.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportStartupProgress } from "../../src/modes/rpc/host-startup-beacon.ts";
import { STARTUP_PROGRESS_INTERVAL_MS } from "../../src/modes/rpc/host-startup-wire.ts";

describe("startup progress heartbeat", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("reports once per interval until the decision budget has passed", () => {
		const report = vi.fn();
		reportStartupProgress(report, 5 * STARTUP_PROGRESS_INTERVAL_MS + 1);
		vi.advanceTimersByTime(STARTUP_PROGRESS_INTERVAL_MS - 1);
		expect(report).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(report).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(20 * STARTUP_PROGRESS_INTERVAL_MS);
		expect(report).toHaveBeenCalledTimes(5);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stops reporting, and leaves no timer behind, once stopped", () => {
		const report = vi.fn();
		const stop = reportStartupProgress(report, 60_000);
		vi.advanceTimersByTime(STARTUP_PROGRESS_INTERVAL_MS);
		stop();
		vi.advanceTimersByTime(60_000);
		expect(report).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
