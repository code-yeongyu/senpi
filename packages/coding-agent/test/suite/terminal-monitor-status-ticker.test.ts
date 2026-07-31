import { afterEach, describe, expect, it, vi } from "vitest";
import type { MonitorSnapshotEntry } from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import {
	MONITOR_STATUS_TICK_INTERVAL_MS,
	MonitorStatusTicker,
} from "../../src/core/extensions/builtin/terminal/monitor-status-ticker.ts";

const T0 = 1_000_000;
const entry = (id: string, description: string, startedAtMs = T0, paused = false): MonitorSnapshotEntry => ({
	id,
	description,
	paused,
	startedAtMs,
});

describe("MonitorStatusTicker", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("unrefs the interval handle so it never keeps the process alive", () => {
		const unref = vi.fn();
		const fakeHandle = { unref, ref: vi.fn(), hasRef: () => true } as unknown as NodeJS.Timeout;
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(fakeHandle);
		const ticker = new MonitorStatusTicker({ render: () => {}, now: () => T0 });

		ticker.sync([entry("bash_1", "deploy errors")]);

		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), MONITOR_STATUS_TICK_INTERVAL_MS);
		expect(unref).toHaveBeenCalledTimes(1);
	});

	it("renders immediately on sync and advances the elapsed label once per second", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const labels: Array<string | undefined> = [];
		const ticker = new MonitorStatusTicker({ render: (status) => labels.push(status) });

		ticker.sync([entry("bash_1", "deploy errors")]);
		expect(labels).toEqual(["◉ watching deploy errors (0s)"]);

		vi.advanceTimersByTime(1_000);
		expect(labels).toEqual(["◉ watching deploy errors (0s)", "◉ watching deploy errors (1s)"]);

		vi.advanceTimersByTime(1_000);
		expect(labels.at(-1)).toBe("◉ watching deploy errors (2s)");
	});

	it("does not re-render while the formatted label is unchanged", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const render = vi.fn();
		const ticker = new MonitorStatusTicker({ render });

		ticker.sync([entry("bash_1", "deploy errors", T0 - 60_000)]);
		expect(render).toHaveBeenCalledTimes(1);

		// 61s..119s all format as "1m", so a minute of ticks adds no renders.
		vi.advanceTimersByTime(59_000);
		expect(render).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(1_000);
		expect(render).toHaveBeenCalledTimes(2);
		expect(render).toHaveBeenLastCalledWith("◉ watching deploy errors (2m)");
	});

	it("clears the status and stops ticking when the last watch settles", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const labels: Array<string | undefined> = [];
		const ticker = new MonitorStatusTicker({ render: (status) => labels.push(status) });

		ticker.sync([entry("bash_1", "deploy errors")]);
		ticker.sync([]);
		expect(labels).toEqual(["◉ watching deploy errors (0s)", undefined]);
		expect(ticker.running).toBe(false);

		vi.advanceTimersByTime(5_000);
		expect(labels).toHaveLength(2);
	});

	it("re-syncs against a new snapshot without leaking a second interval", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		const labels: Array<string | undefined> = [];
		const ticker = new MonitorStatusTicker({ render: (status) => labels.push(status) });

		ticker.sync([entry("bash_1", "deploy errors")]);
		ticker.sync([entry("bash_1", "deploy errors"), entry("bash_2", "webpack", T0 + 30_000)]);
		vi.advanceTimersByTime(5_000);

		expect(labels[0]).toBe("◉ watching deploy errors (0s)");
		expect(labels[1]).toBe("◉ watching 2: deploy errors, webpack (0s)");
		expect(labels.at(-1)).toBe("◉ watching 2: deploy errors, webpack (5s)");
		expect(clearIntervalSpy).not.toHaveBeenCalled();
	});

	it("stop() halts ticking and drops the retained snapshot", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const labels: Array<string | undefined> = [];
		const ticker = new MonitorStatusTicker({ render: (status) => labels.push(status) });

		ticker.sync([entry("bash_1", "deploy errors")]);
		ticker.stop();
		expect(ticker.running).toBe(false);

		vi.advanceTimersByTime(5_000);
		expect(labels).toEqual(["◉ watching deploy errors (0s)"]);

		// A later sync starts fresh: the label re-renders even though it matches the pre-stop one.
		ticker.sync([entry("bash_1", "deploy errors", T0 + 5_000)]);
		expect(labels.at(-1)).toBe("◉ watching deploy errors (0s)");
	});
});
