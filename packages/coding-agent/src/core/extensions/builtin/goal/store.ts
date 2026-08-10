import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GoalAlreadyExistsError, GoalNotFoundError } from "./errors.ts";
import { encodedThreadId, goalFilePath, readGoalFile, writeGoalFile } from "./persistence.ts";
import { transitionGoalStatus } from "./transitions.ts";
import type {
	Goal,
	GoalAccountingMode,
	GoalStoreRef,
	GoalUpdate,
	GoalUpdateSource,
	TokenUsageSnapshot,
} from "./types.ts";
import { resolveTokenBudget, validateObjective, validateTokenBudget } from "./validation.ts";

export { goalFilePath };

const goalMutationTails = new Map<string, Promise<void>>();

function enqueueGoalMutation<T>(ref: GoalStoreRef, mutation: () => Promise<T>): Promise<T> {
	const key = goalFilePath(ref);
	const previous = goalMutationTails.get(key) ?? Promise.resolve();
	const run = previous.then(mutation);
	const tail = run.then(
		() => undefined,
		() => undefined,
	);
	goalMutationTails.set(key, tail);
	void tail.then(() => {
		if (goalMutationTails.get(key) === tail) goalMutationTails.delete(key);
	});
	return run;
}

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
	await enqueueGoalMutation(ref, () => writeGoalFile(ref, goal));
}

export async function createGoal(ref: GoalStoreRef, objective: string, tokenBudget?: number): Promise<Goal> {
	return enqueueGoalMutation(ref, async () => {
		const validatedObjective = validateObjective(objective, objectiveFullTextFileName(ref));
		const current = await readGoalFile(ref);
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
		await writeGoalFile(ref, goal);
		return goal;
	});
}

export async function updateGoal(
	ref: GoalStoreRef,
	update: GoalUpdate,
	source: GoalUpdateSource = "model",
): Promise<Goal> {
	return enqueueGoalMutation(ref, async () => {
		const current = await readGoalFile(ref);
		if (!current) throw new GoalNotFoundError("cannot update goal: no goal exists");

		const validatedObjective =
			update.objective === undefined
				? undefined
				: validateObjective(update.objective, objectiveFullTextFileName(ref));
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
			await writeGoalFile(ref, next);
			return next;
		}

		const next = transitionGoalStatus(
			{ ...current, objective },
			requestedStatus ?? current.status,
			source,
			update.reason,
			now,
		);
		if (next.status !== current.status) {
			next.consecutiveContinuations = 0;
			delete next.lastContinuationSignature;
		}
		if (tokenBudget === undefined) delete next.tokenBudget;
		else next.tokenBudget = tokenBudget;
		if (validatedObjective?.truncated) await writeFullObjectiveText(ref, update.objective ?? "");
		await writeGoalFile(ref, next);
		return next;
	});
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
	return enqueueGoalMutation(ref, async () => {
		const hadGoal = (await readGoalFile(ref)) !== null;
		await writeGoalFile(ref, null);
		return hadGoal;
	});
}

export async function accountGoalUsage(
	ref: GoalStoreRef,
	usage: TokenUsageSnapshot,
	elapsedSeconds: number,
	mode: GoalAccountingMode = "active",
	expectedGoalId?: string,
): Promise<Goal | null> {
	return enqueueGoalMutation(ref, async () => {
		const goal = await readGoalFile(ref);
		if (!goal || (expectedGoalId !== undefined && goal.id !== expectedGoalId) || !canAccountGoalUsage(goal, mode)) {
			return goal;
		}
		const next: Goal = {
			...goal,
			tokensUsed: goal.tokensUsed + Math.max(0, usage.input) + Math.max(0, usage.output),
			timeUsedSeconds: goal.timeUsedSeconds + Math.max(0, Math.trunc(elapsedSeconds)),
			updatedAt: nextUpdatedAt(goal.updatedAt),
		};
		await writeGoalFile(ref, next);
		return next;
	});
}

export async function recordContinuationDelivered(
	ref: GoalStoreRef,
	signature: string,
	expectedGoalId?: string,
): Promise<Goal | null> {
	return enqueueGoalMutation(ref, async () => {
		const goal = await readGoalFile(ref);
		if (!goal || (expectedGoalId !== undefined && goal.id !== expectedGoalId)) return null;
		const next: Goal = {
			...goal,
			consecutiveContinuations: (goal.consecutiveContinuations ?? 0) + 1,
			lastContinuationSignature: signature,
		};
		await writeGoalFile(ref, next);
		return next;
	});
}

export async function resetContinuationStreak(ref: GoalStoreRef): Promise<Goal | null> {
	return enqueueGoalMutation(ref, async () => {
		const goal = await readGoalFile(ref);
		if (!goal) return goal;
		const next: Goal = { ...goal, consecutiveContinuations: 0 };
		delete next.lastContinuationSignature;
		await writeGoalFile(ref, next);
		return next;
	});
}

function canAccountGoalUsage(goal: Goal, mode: GoalAccountingMode): boolean {
	if (mode === "active") return goal.status === "active";
	if (mode === "activeOrBlocked") return goal.status === "active" || goal.status === "blocked";
	return goal.status === "active" || goal.status === "complete";
}

function nextUpdatedAt(previousUpdatedAt: number): number {
	return Math.max(nowSeconds(), previousUpdatedAt + 1);
}

function nowSeconds(): number {
	return Math.trunc(Date.now() / 1000);
}
