import { GOAL_STATUS_VALUES, type GoalStatus } from "./types.ts";

export const MAX_OBJECTIVE_LENGTH = 4_000;
const WHITESPACE_LOOKBACK = 200;

export type ValidatedObjective = {
	objective: string;
	truncated: boolean;
	fullTextFileName?: string;
};

export function validateObjective(value: string, fullTextFileName: string): ValidatedObjective {
	const objective = value.trim();
	if (objective.length === 0) throw new Error("objective must not be empty");
	const codePoints = [...objective];
	if (codePoints.length <= MAX_OBJECTIVE_LENGTH) return { objective, truncated: false };

	const marker = truncationMarker(fullTextFileName);
	const payloadBudget = MAX_OBJECTIVE_LENGTH - [...marker].length;
	const payload = codePoints.slice(0, nearestWhitespaceCut(codePoints, payloadBudget) ?? payloadBudget).join("");
	return { objective: `${payload}${marker}`, truncated: true, fullTextFileName };
}

export function truncationMarker(fullTextFileName: string): string {
	return `… [truncated; full objective: ${fullTextFileName}]`;
}

export function objectiveTruncationNotice(fullTextFileName: string): string {
	return `Objective was truncated; full objective saved to ${fullTextFileName}.`;
}

export function isGoalStatus(value: unknown): value is GoalStatus {
	return GOAL_STATUS_VALUES.some((status) => status === value);
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function resolveTokenBudget(current: number | undefined, update: number | null | undefined): number | undefined {
	if (update === undefined) return current;
	return update === null ? undefined : validateTokenBudget(update);
}

export function validateTokenBudget(value: number): number {
	if (!isNonNegativeSafeInteger(value)) throw new Error("token budget must be a non-negative integer");
	return value;
}

function nearestWhitespaceCut(codePoints: string[], payloadBudget: number): number | undefined {
	for (let index = payloadBudget - 1; index >= Math.max(0, payloadBudget - WHITESPACE_LOOKBACK); index -= 1) {
		if (/\s/u.test(codePoints[index] ?? "")) return index;
	}
	return undefined;
}
