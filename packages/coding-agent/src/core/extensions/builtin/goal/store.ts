import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GoalAlreadyExistsError, GoalNotFoundError } from "./errors.ts";
import { encodedThreadId, readGoalFile, writeGoalFile } from "./persistence.ts";
import { transitionGoalStatus } from "./transitions.ts";
import type {
	Goal,
	GoalAccountingMode,
	GoalStatus,
	GoalStoreRef,
	GoalUpdate,
	GoalUpdateSource,
	TokenUsageSnapshot,
} from "./types.ts";
import { resolveTokenBudget, validateObjective, validateTokenBudget } from "./validation.ts";

export { goalFilePath } from "./persistence.ts";

export function goalHistoryFilePath(ref: GoalStoreRef): string {
	return join(ref.baseDir, `${encodedThreadId(ref)}.history.jsonl`);
}

export function objectiveFullTextFileName(ref: GoalStoreRef): string {
	return `${encodedThreadId(ref)}.objective-full.txt`;
}

export function objectiveFullTextFilePath(ref: GoalStoreRef): string {
	return join(ref.baseDir, objectiveFullTextFileName(ref));
}

export async function readGoal(ref: GoalStoreRef): Promise<Goal | null> {
	return readGoalFile(ref);
}

export async function writeGoal(ref: GoalStoreRef, goal: Goal | null): Promise<void> {
	await writeGoalFile(ref, goal);
}

export async function createGoal(ref: GoalStoreRef, objective: string, tokenBudget?: number): Promise<Goal> {
	const validatedObjective = validateObjective(objective, objectiveFullTextFileName(ref));
	const current = await readGoal(ref);
	if (current !== null && current.status !== "complete") {
		throw new GoalAlreadyExistsError("cannot create a new goal because this thread already has a goal");
	}
	if (validatedObjective.truncated) await writeFullObjectiveText(ref, objective);
	if (current?.status === "complete") await archiveGoal(ref, current);
	const now = nowSeconds();
	const goal: Goal = {
		id: randomUUID(),
		threadId: ref.threadId,
		objective: validatedObjective.objective,
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		consecutiveContinuations: 0,
		createdAt: now,
		updatedAt: now,
		lastStartedAt: now,
		...(tokenBudget === undefined ? {} : { tokenBudget: validateTokenBudget(tokenBudget) }),
	};
	await writeGoal(ref, goal);
	return goal;
}

export async function updateGoal(
	ref: GoalStoreRef,
	update: GoalUpdate,
	source: GoalUpdateSource = "model",
): Promise<Goal> {
	const current = await readGoal(ref);
	if (!current) throw new GoalNotFoundError("cannot update goal: no goal exists");

	const validatedObjective =
		update.objective === undefined ? undefined : validateObjective(update.objective, objectiveFullTextFileName(ref));
	const objective = validatedObjective?.objective ?? current.objective;
	const tokenBudget = resolveTokenBudget(current.tokenBudget, update.tokenBudget);
	const now = nextUpdatedAt(current.updatedAt);
	const hasObjectiveUpdate = update.objective !== undefined;
	const replacesGoal = hasObjectiveUpdate && (objective !== current.objective || current.status === "complete");
	const requestedStatus = update.status ?? (hasObjectiveUpdate ? "active" : undefined);

	if (replacesGoal) {
		const status = requestedStatus ?? "active";
		if (status === "blocked") throw new Error("objective replacement cannot create a blocked goal");
		const next: Goal = {
			id: randomUUID(),
			threadId: ref.threadId,
			objective,
			status,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			consecutiveContinuations: 0,
			createdAt: now,
			updatedAt: now,
			...(tokenBudget === undefined ? {} : { tokenBudget }),
		};
		if (status === "active") next.lastStartedAt = now;
		if (status === "complete") next.completedAt = now;
		if (validatedObjective?.truncated) await writeFullObjectiveText(ref, update.objective ?? "");
		await writeGoal(ref, next);
		return next;
	}

	const next = applyGoalStatusUpdate(
		{ ...current, objective },
		requestedStatus ?? current.status,
		source,
		update.reason,
		now,
	);
	if (tokenBudget === undefined) delete next.tokenBudget;
	else next.tokenBudget = tokenBudget;
	if (validatedObjective?.truncated) await writeFullObjectiveText(ref, update.objective ?? "");
	await writeGoal(ref, next);
	return next;
}

export async function archiveGoal(ref: GoalStoreRef, goal: Goal): Promise<void> {
	const filePath = goalHistoryFilePath(ref);
	await mkdir(dirname(filePath), { recursive: true });
	await appendFile(filePath, `${JSON.stringify(goal)}\n`, "utf8");
}

async function writeFullObjectiveText(ref: GoalStoreRef, objective: string): Promise<void> {
	const filePath = objectiveFullTextFilePath(ref);
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, objective, "utf8");
}

export async function clearGoal(ref: GoalStoreRef): Promise<boolean> {
	const hadGoal = (await readGoal(ref)) !== null;
	await writeGoal(ref, null);
	return hadGoal;
}

export async function accountGoalUsage(
	ref: GoalStoreRef,
	usage: TokenUsageSnapshot,
	elapsedSeconds: number,
	mode: GoalAccountingMode = "active",
	expectedGoalId?: string,
): Promise<Goal | null> {
	const goal = await readGoal(ref);
	if (!goal || (expectedGoalId !== undefined && goal.id !== expectedGoalId) || !canAccountGoalUsage(goal, mode)) {
		return goal;
	}
	const next = applyGoalUsage(goal, usage, elapsedSeconds, nextUpdatedAt(goal.updatedAt));
	await writeGoal(ref, next);
	return next;
}

export type GoalTurnTransition = {
	readonly status: GoalStatus;
	readonly source: GoalUpdateSource;
	readonly reason?: string;
	readonly when: (goal: Goal) => boolean;
};

export type GoalTurnFinalization = {
	readonly usage?: TokenUsageSnapshot;
	readonly elapsedSeconds: number;
	readonly mode: GoalAccountingMode;
	readonly expectedGoalId?: string;
	readonly transition?: GoalTurnTransition;
};

/** Accounts usage and applies an optional lifecycle transition with at most one Goal-file write. */
export async function finalizeGoalTurn(ref: GoalStoreRef, finalization: GoalTurnFinalization): Promise<Goal | null> {
	const goal = await readGoal(ref);
	if (!goal || (finalization.expectedGoalId !== undefined && goal.id !== finalization.expectedGoalId)) return goal;

	const shouldAccount = finalization.usage !== undefined && canAccountGoalUsage(goal, finalization.mode);
	const shouldTransition = finalization.transition?.when(goal) ?? false;
	if (!shouldAccount && !shouldTransition) return goal;

	const now = nextUpdatedAt(goal.updatedAt);
	let next =
		shouldAccount && finalization.usage !== undefined
			? applyGoalUsage(goal, finalization.usage, finalization.elapsedSeconds, now)
			: goal;
	if (shouldTransition && finalization.transition !== undefined) {
		next = applyGoalStatusUpdate(
			next,
			finalization.transition.status,
			finalization.transition.source,
			finalization.transition.reason,
			now,
		);
	}
	await writeGoal(ref, next);
	return next;
}

/** Restores a loaded Goal's historical continuation count without another Goal-file read. */
export async function restoreContinuationStreak(
	ref: GoalStoreRef,
	goal: Goal,
	derivedCount: number,
	continuationCap: number,
): Promise<Goal> {
	const effectiveCount = Math.max(goal.consecutiveContinuations ?? 0, derivedCount);
	const needsCountWrite = goal.consecutiveContinuations !== effectiveCount;
	if (effectiveCount < continuationCap && !needsCountWrite) return goal;

	let next: Goal = { ...goal, consecutiveContinuations: effectiveCount };
	if (effectiveCount >= continuationCap && goal.status === "active") {
		next = applyGoalStatusUpdate(next, "paused", "system", "continuation cap reached", nextUpdatedAt(goal.updatedAt));
	}
	await writeGoal(ref, next);
	return next;
}

export async function recordContinuationDelivered(ref: GoalStoreRef, signature: string): Promise<Goal | null> {
	const goal = await readGoal(ref);
	if (!goal) return goal;
	const next: Goal = {
		...goal,
		consecutiveContinuations: (goal.consecutiveContinuations ?? 0) + 1,
		lastContinuationSignature: signature,
	};
	await writeGoal(ref, next);
	return next;
}

export async function resetContinuationStreak(ref: GoalStoreRef): Promise<Goal | null> {
	const goal = await readGoal(ref);
	if (!goal || ((goal.consecutiveContinuations ?? 0) === 0 && goal.lastContinuationSignature === undefined)) {
		return goal;
	}
	const next: Goal = { ...goal, consecutiveContinuations: 0 };
	delete next.lastContinuationSignature;
	await writeGoal(ref, next);
	return next;
}

function applyGoalUsage(goal: Goal, usage: TokenUsageSnapshot, elapsedSeconds: number, updatedAt: number): Goal {
	return {
		...goal,
		tokensUsed: goal.tokensUsed + Math.max(0, usage.input) + Math.max(0, usage.output),
		timeUsedSeconds: goal.timeUsedSeconds + Math.max(0, Math.trunc(elapsedSeconds)),
		updatedAt,
	};
}

function applyGoalStatusUpdate(
	current: Goal,
	status: GoalStatus,
	source: GoalUpdateSource,
	reason: string | undefined,
	updatedAt: number,
): Goal {
	const next = transitionGoalStatus(current, status, source, reason, updatedAt);
	if (next.status !== current.status && source !== "system") {
		next.consecutiveContinuations = 0;
		delete next.lastContinuationSignature;
	}
	return next;
}

function canAccountGoalUsage(goal: Goal, mode: GoalAccountingMode): boolean {
	if (mode === "active") return goal.status === "active";
	if (mode === "activeOrBlocked") return goal.status === "active" || goal.status === "blocked";
	if (mode === "activeOrComplete") return goal.status === "active" || goal.status === "complete";
	return goal.status === "active" || (goal.status === "paused" && goal.blockedReason === "user-input");
}

function nextUpdatedAt(previousUpdatedAt: number): number {
	return Math.max(nowSeconds(), previousUpdatedAt + 1);
}

function nowSeconds(): number {
	return Math.trunc(Date.now() / 1000);
}
