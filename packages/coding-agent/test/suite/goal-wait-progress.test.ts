import { describe, expect, it } from "vitest";
import {
	formatGoalWaitLabel,
	GOAL_WAIT_BAR_CELLS,
	renderGoalWaitBar,
} from "../../src/core/extensions/builtin/goal/wait-progress.ts";

const FILLED = "▰";
const EMPTY = "▱";

function filledCells(bar: string): number {
	return [...bar].filter((cell) => cell === FILLED).length;
}

describe("goal wait progress bar", () => {
	it("renders an empty bar at the start of the wait", () => {
		expect(renderGoalWaitBar(0)).toBe(EMPTY.repeat(GOAL_WAIT_BAR_CELLS));
	});

	it("renders a full bar once the wait has elapsed", () => {
		expect(renderGoalWaitBar(1)).toBe(FILLED.repeat(GOAL_WAIT_BAR_CELLS));
	});

	it("fills proportionally at the halfway point", () => {
		const bar = renderGoalWaitBar(0.5);
		expect([...bar]).toHaveLength(GOAL_WAIT_BAR_CELLS);
		expect(filledCells(bar)).toBe(Math.round(GOAL_WAIT_BAR_CELLS / 2));
	});

	it("clamps out-of-range ratios instead of overflowing the bar", () => {
		expect(renderGoalWaitBar(-1)).toBe(EMPTY.repeat(GOAL_WAIT_BAR_CELLS));
		expect(renderGoalWaitBar(9)).toBe(FILLED.repeat(GOAL_WAIT_BAR_CELLS));
	});
});

describe("goal wait label", () => {
	it("shows remaining seconds and a partially filled bar for a user-grace wait", () => {
		const label = formatGoalWaitLabel({
			kind: "userGrace",
			remainingMs: 47_000,
			totalMs: 60_000,
			activeMonitorCount: 0,
		});

		expect(label).toContain("47s");
		expect(label).toContain(FILLED);
		expect(label).toContain(EMPTY);
	});

	it("formats a multi-minute monitor wait and names the monitors on duty", () => {
		const label = formatGoalWaitLabel({
			kind: "monitor",
			remainingMs: 192_000,
			totalMs: 240_000,
			activeMonitorCount: 2,
		});

		expect(label).toContain("3m 12s");
		expect(label).toContain("2 monitors");
	});

	it("uses the singular monitor wording for a single monitor", () => {
		const label = formatGoalWaitLabel({
			kind: "monitor",
			remainingMs: 60_000,
			totalMs: 240_000,
			activeMonitorCount: 1,
		});

		expect(label).toContain("1 monitor");
		expect(label).not.toContain("1 monitors");
	});

	it("never renders a negative remaining time", () => {
		const label = formatGoalWaitLabel({
			kind: "userGrace",
			remainingMs: -5_000,
			totalMs: 60_000,
			activeMonitorCount: 0,
		});

		expect(label).toContain("0s");
		expect(label).not.toContain("-");
	});

	it("keeps the user-grace label free of monitor wording", () => {
		const label = formatGoalWaitLabel({
			kind: "userGrace",
			remainingMs: 30_000,
			totalMs: 60_000,
			activeMonitorCount: 3,
		});

		expect(label).not.toContain("monitor");
	});
});
