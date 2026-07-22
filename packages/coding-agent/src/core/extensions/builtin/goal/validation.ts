import { GOAL_STATUS_VALUES, type GoalStatus } from "./types.ts";

export const MAX_OBJECTIVE_LENGTH = 4_000;
const GOAL_TOO_LONG_FILE_HINT =
	"Put longer instructions in a file and refer to that file in the goal, for example: /goal follow the instructions in docs/goal.md.";

export function validateObjective(value: string): string {
	const objective = value.trim();
	if (objective.length === 0) throw new Error("objective must not be empty");
	const objectiveCharacters = [...objective].length;
	if (objectiveCharacters > MAX_OBJECTIVE_LENGTH) {
		throw new Error(
			`Goal objective is too long: ${objectiveCharacters.toLocaleString()} characters. Limit: ${MAX_OBJECTIVE_LENGTH.toLocaleString()} characters. ${GOAL_TOO_LONG_FILE_HINT}`,
		);
	}
	return objective;
}

export function isGoalStatus(value: unknown): value is GoalStatus {
	return GOAL_STATUS_VALUES.some((status) => status === value);
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function resolveTokenBudget(current: number | undefined, update: number | null | undefined): number | undefined {
	if (update === undefined) return current;
	if (update === null) return undefined;
	return validateTokenBudget(update);
}

export function validateTokenBudget(value: number): number {
	if (!isNonNegativeSafeInteger(value)) {
		throw new Error("token budget must be a non-negative integer");
	}
	return value;
}
