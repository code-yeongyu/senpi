import type { Goal, GoalStatus, GoalUpdateSource } from "./types.ts";

export function transitionGoalStatus(
	current: Goal,
	status: GoalStatus,
	source: GoalUpdateSource,
	reason: string | undefined,
	updatedAt: number,
): Goal {
	assertGoalTransition(current.status, status, source);
	if (status === "complete" && reason !== undefined)
		throw new Error("reason must not be provided when status is complete");

	const next: Goal = { ...current, status, updatedAt };
	if (status === "blocked") applyBlockedFields(next, current, reason, updatedAt);
	else {
		delete next.blockedReason;
		delete next.blockedAt;
	}
	if (status === "active" && current.status !== "active") next.lastStartedAt = updatedAt;
	else if (status !== "active") delete next.lastStartedAt;
	if (status === "complete") next.completedAt = current.completedAt ?? updatedAt;
	else delete next.completedAt;
	return next;
}

function assertGoalTransition(current: GoalStatus, next: GoalStatus, source: GoalUpdateSource): void {
	if (current === next || isAllowedTransition(current, next, source)) return;
	throw new Error(`illegal goal transition: ${current} -> ${next}`);
}

function isAllowedTransition(current: GoalStatus, next: GoalStatus, source: GoalUpdateSource): boolean {
	if (source === "model") {
		return (
			(current === "active" && (next === "blocked" || next === "complete")) ||
			(current === "blocked" && next === "complete")
		);
	}
	return (
		(current === "active" && next === "paused") ||
		(current === "paused" && next === "active") ||
		(current === "blocked" && next === "active")
	);
}

function applyBlockedFields(next: Goal, current: Goal, reason: string | undefined, updatedAt: number): void {
	if (current.status === "blocked") return;
	const blockedReason = reason?.trim();
	if (blockedReason === undefined || blockedReason.length === 0)
		throw new Error("reason is required when status is blocked");
	next.blockedReason = blockedReason;
	next.blockedAt = updatedAt;
}
