import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GOAL_ELAPSED_TICK_INTERVAL_MS,
	GoalElapsedTicker,
	goalLiveElapsedSeconds,
} from "../../src/core/extensions/builtin/goal/elapsed-ticker.ts";
import type { Goal } from "../../src/core/extensions/builtin/goal/types.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";

function makeGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		threadId: "thread-1",
		objective: "Ship the feature",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

const fakeCtx = { hasUI: true } as unknown as ExtensionContext;

describe("goalLiveElapsedSeconds", () => {
	it("adds whole seconds elapsed since the measurement start to the committed time", () => {
		const goal = makeGoal({ timeUsedSeconds: 10 });
		expect(goalLiveElapsedSeconds(goal, 1_000_000, 1_000_000)).toBe(10);
		expect(goalLiveElapsedSeconds(goal, 1_000_000, 1_000_999)).toBe(11); // rounds 0.999s -> 1s
		expect(goalLiveElapsedSeconds(goal, 1_000_000, 1_002_400)).toBe(12); // rounds 2.4s -> 2s
	});

	it("never counts negative elapsed when the clock moves backwards", () => {
		const goal = makeGoal({ timeUsedSeconds: 7 });
		expect(goalLiveElapsedSeconds(goal, 5_000, 1_000)).toBe(7);
	});
});

describe("GoalElapsedTicker", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("unrefs the interval handle so it never keeps the process alive", () => {
		const unref = vi.fn();
		const fakeHandle = { unref, ref: vi.fn(), hasRef: () => true } as unknown as NodeJS.Timeout;
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(fakeHandle);
		const ticker = new GoalElapsedTicker({ render: () => {}, now: () => 1_000_000 });

		ticker.sync(fakeCtx, makeGoal({ status: "active" }), 1_000_000);

		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), GOAL_ELAPSED_TICK_INTERVAL_MS);
		expect(unref).toHaveBeenCalledTimes(1);
	});

	it("renders immediately on sync and once per second afterwards", () => {
		vi.useFakeTimers();
		const renders: number[] = [];
		const ticker = new GoalElapsedTicker({ render: (_ctx, _goal, live) => renders.push(live) });
		const measuredFrom = Date.now();

		ticker.sync(fakeCtx, makeGoal({ timeUsedSeconds: 10 }), measuredFrom);
		expect(renders).toEqual([10]);

		vi.advanceTimersByTime(1000);
		expect(renders).toEqual([10, 11]);

		vi.advanceTimersByTime(2000);
		expect(renders).toEqual([10, 11, 12, 13]);

		ticker.stop();
		vi.advanceTimersByTime(5000);
		expect(renders).toEqual([10, 11, 12, 13]);
	});

	it("re-syncing the same goal keeps a single interval and refreshes the goal snapshot", () => {
		vi.useFakeTimers();
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const renders: number[] = [];
		const ticker = new GoalElapsedTicker({ render: (_ctx, _goal, live) => renders.push(live) });
		const measuredFrom = Date.now();

		ticker.sync(fakeCtx, makeGoal({ timeUsedSeconds: 0 }), measuredFrom);
		vi.advanceTimersByTime(1000);
		// A new turn committed 5s and reset the measurement window to "now".
		ticker.sync(fakeCtx, makeGoal({ timeUsedSeconds: 5 }), Date.now());
		vi.advanceTimersByTime(1000);

		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		expect(renders).toEqual([0, 1, 5, 6]);

		ticker.stop();
	});

	it("stop is idempotent and safe before any sync", () => {
		const ticker = new GoalElapsedTicker({ render: () => {} });
		expect(ticker.running).toBe(false);
		expect(() => ticker.stop()).not.toThrow();
		expect(ticker.running).toBe(false);
	});
});
