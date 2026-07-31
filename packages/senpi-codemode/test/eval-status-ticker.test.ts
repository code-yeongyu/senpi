import { afterEach, describe, expect, it, vi } from "vitest";
import { EVAL_STATUS_TICK_INTERVAL_MS, EvalStatusTicker } from "../src/extension/eval-status-ticker.ts";
import type { EvalDetachedCellStatusEntry } from "../src/tool/detached-cell-manager.ts";

const T0 = 1_000_000;
const entry = (cellId: string, title: string, startedAtMs = T0): EvalDetachedCellStatusEntry => ({
	cellId,
	language: "py",
	title,
	startedAtMs,
});

describe("EvalStatusTicker", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("unrefs the interval handle so it never keeps the process alive", () => {
		const unref = vi.fn();
		const fakeHandle = { unref, ref: vi.fn(), hasRef: () => true } as unknown as NodeJS.Timeout;
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(fakeHandle);
		const ticker = new EvalStatusTicker({ render: () => {}, now: () => T0 });

		ticker.sync([entry("cell-1", "long running cell")]);

		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), EVAL_STATUS_TICK_INTERVAL_MS);
		expect(unref).toHaveBeenCalledTimes(1);
	});

	it("renders immediately on sync and advances the elapsed label once per second", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const labels: Array<string | undefined> = [];
		const ticker = new EvalStatusTicker({ render: (status) => labels.push(status) });

		ticker.sync([entry("cell-1", "long running cell")]);
		expect(labels).toEqual(["↗ py · long running cell (0s)"]);

		vi.advanceTimersByTime(1_000);
		expect(labels).toEqual(["↗ py · long running cell (0s)", "↗ py · long running cell (1s)"]);
	});

	it("does not re-render while the formatted label is unchanged", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const render = vi.fn();
		const ticker = new EvalStatusTicker({ render });

		ticker.sync([entry("cell-1", "long running cell", T0 - 60_000)]);
		expect(render).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(59_000);
		expect(render).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(1_000);
		expect(render).toHaveBeenCalledTimes(2);
		expect(render).toHaveBeenLastCalledWith("↗ py · long running cell (2m)");
	});

	it("clears the status and stops ticking when the last detached cell settles", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const labels: Array<string | undefined> = [];
		const ticker = new EvalStatusTicker({ render: (status) => labels.push(status) });

		ticker.sync([entry("cell-1", "long running cell")]);
		ticker.sync([]);
		expect(labels).toEqual(["↗ py · long running cell (0s)", undefined]);
		expect(ticker.running).toBe(false);

		vi.advanceTimersByTime(5_000);
		expect(labels).toHaveLength(2);
	});

	it("stop() halts ticking and drops the retained entries", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const labels: Array<string | undefined> = [];
		const ticker = new EvalStatusTicker({ render: (status) => labels.push(status) });

		ticker.sync([entry("cell-1", "long running cell")]);
		ticker.stop();
		expect(ticker.running).toBe(false);

		vi.advanceTimersByTime(5_000);
		expect(labels).toEqual(["↗ py · long running cell (0s)"]);
	});
});
