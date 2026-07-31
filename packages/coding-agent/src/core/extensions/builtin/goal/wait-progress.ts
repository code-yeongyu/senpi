import { formatWakeDuration } from "./cache-warm.ts";

export type GoalWaitKind = "monitor" | "userGrace";

export interface GoalWaitLabelInput {
	readonly kind: GoalWaitKind;
	readonly remainingMs: number;
	readonly totalMs: number;
	readonly activeMonitorCount: number;
}

export const GOAL_WAIT_BAR_CELLS = 12;

const FILLED_CELL = "\u25b0";
const EMPTY_CELL = "\u25b1";

function clampRatio(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

export function renderGoalWaitBar(elapsedRatio: number): string {
	const filled = Math.round(clampRatio(elapsedRatio) * GOAL_WAIT_BAR_CELLS);
	return FILLED_CELL.repeat(filled) + EMPTY_CELL.repeat(GOAL_WAIT_BAR_CELLS - filled);
}

function elapsedRatioOf(remainingMs: number, totalMs: number): number {
	if (totalMs <= 0) return 1;
	return clampRatio((totalMs - Math.max(0, remainingMs)) / totalMs);
}

function monitorsOnDuty(count: number): string {
	return count === 1 ? "1 monitor on duty" : `${count} monitors on duty`;
}

export function formatGoalWaitLabel(input: GoalWaitLabelInput): string {
	const bar = renderGoalWaitBar(elapsedRatioOf(input.remainingMs, input.totalMs));
	const remaining = formatWakeDuration(Math.max(0, input.remainingMs));
	if (input.kind === "monitor") {
		return `${bar} goal continues in ${remaining} \u00b7 ${monitorsOnDuty(input.activeMonitorCount)}`;
	}
	return `${bar} goal resumes in ${remaining}`;
}
