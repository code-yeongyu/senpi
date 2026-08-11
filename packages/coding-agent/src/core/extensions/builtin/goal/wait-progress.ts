import { formatWakeDuration } from "./cache-warm.ts";
import type { ResumptionChannelCounts } from "./monitor-continuation-types.ts";

export type GoalWaitKind = "monitor" | "userGrace";

export interface GoalWaitLabelInput {
	readonly kind: GoalWaitKind;
	readonly remainingMs: number;
	readonly totalMs: number;
	readonly channelCounts: ResumptionChannelCounts;
}

export const GOAL_WAIT_BAR_CELLS = 12;

const FILLED_CELL = "\u25b0";
const EMPTY_CELL = "\u25b1";
const SOURCE_ORDER = ["terminal-monitors", "senpi-task", "senpi-codemode", "terminal-background-sessions"] as const;

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

function sourceSortIndex(source: string): number {
	const index = SOURCE_ORDER.indexOf(source as (typeof SOURCE_ORDER)[number]);
	return index < 0 ? SOURCE_ORDER.length : index;
}

function formatSourceCount(source: string, count: number): string {
	switch (source) {
		case "terminal-monitors":
			return count === 1 ? "1 wake source" : `${count} wake sources`;
		case "senpi-task":
			return count === 1 ? "1 task" : `${count} tasks`;
		case "senpi-codemode":
			return count === 1 ? "1 eval" : `${count} evals`;
		case "terminal-background-sessions":
			return count === 1 ? "1 bash" : `${count} bash sessions`;
		default: {
			const label = source.replaceAll("-", " ");
			return count === 1 ? `1 ${label}` : `${count} ${label} channels`;
		}
	}
}

export function channelsOnDuty(channelCounts: ResumptionChannelCounts): string {
	const liveSources = Object.entries(channelCounts)
		.filter(([, count]) => count > 0)
		.sort(([left], [right]) => sourceSortIndex(left) - sourceSortIndex(right) || left.localeCompare(right));
	return `${liveSources.map(([source, count]) => formatSourceCount(source, count)).join(" \u00b7 ")} on duty`;
}

export function formatGoalWaitLabel(input: GoalWaitLabelInput): string {
	const bar = renderGoalWaitBar(elapsedRatioOf(input.remainingMs, input.totalMs));
	const remaining = formatWakeDuration(Math.max(0, input.remainingMs));
	if (input.kind === "monitor") {
		return `${bar} goal continues in ${remaining} \u00b7 ${channelsOnDuty(input.channelCounts)}`;
	}
	return `${bar} goal resumes in ${remaining}`;
}
