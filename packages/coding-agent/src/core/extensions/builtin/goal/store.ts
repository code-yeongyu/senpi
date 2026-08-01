import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GoalAlreadyExistsError, GoalNotFoundError } from "./errors.ts";
import {
	encodedThreadId,
	readGoalFile,
	withGoalStoreMutation,
	writeGoalFile,
	writePrivateFileAtomic,
} from "./persistence.ts";
import { transitionGoalStatus } from "./transitions.ts";
import type {
	Goal,
	GoalAccountingMode,
	GoalExpectation,
	GoalStoreRef,
	GoalUpdate,
	GoalUpdateSource,
	TokenUsageSnapshot,
} from "./types.ts";
import { resolveTokenBudget, truncationMarker, validateObjective, validateTokenBudget } from "./validation.ts";

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
	return withHardenedGoalStoreMutation(ref, async () => readGoalFile(ref));
}

export async function readObjectiveForPrompt(ref: GoalStoreRef, goal: Pick<Goal, "id" | "objective">): Promise<string> {
	return withHardenedGoalStoreMutation(ref, async () => {
		const current = await readGoalFile(ref);
		if (current?.id !== goal.id || current.objective !== goal.objective) return goal.objective;
		await hardenGoalAuxiliaryFilePermissions(ref);

		const fullTextFileName = objectiveFullTextFileName(ref);
		if (!goal.objective.endsWith(truncationMarker(fullTextFileName))) return goal.objective;

		let fullObjective: string;
		try {
			fullObjective = (await readFile(objectiveFullTextFilePath(ref), "utf8")).trim();
		} catch (error) {
			if (isMissingFileError(error) || isFileNameTooLongError(error)) return goal.objective;
			throw error;
		}

		try {
			const validated = validateObjective(fullObjective, fullTextFileName);
			return validated.truncated && validated.objective === goal.objective ? fullObjective : goal.objective;
		} catch {
			return goal.objective;
		}
	});
}

export async function writeGoal(ref: GoalStoreRef, goal: Goal | null): Promise<void> {
	await withHardenedGoalStoreMutation(ref, async () => writeGoalFile(ref, goal));
}

export async function createGoal(ref: GoalStoreRef, objective: string, tokenBudget?: number): Promise<Goal> {
	return withHardenedGoalStoreMutation(ref, async () => {
		const validatedObjective = validateObjective(objective, objectiveFullTextFileName(ref));
		const current = await readGoalFile(ref);
		if (current !== null && current.status !== "complete") {
			throw new GoalAlreadyExistsError("cannot create a new goal because this thread already has a goal");
		}
		if (current?.status === "complete") await archiveGoalUnlocked(ref, current);
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
		await writeGoalAndSidecar(ref, current, goal, validatedObjective.truncated ? objective : null);
		return goal;
	});
}

export function updateGoal(ref: GoalStoreRef, update: GoalUpdate, source?: GoalUpdateSource): Promise<Goal>;
export function updateGoal(
	ref: GoalStoreRef,
	update: GoalUpdate,
	source: GoalUpdateSource,
	expected: GoalExpectation,
): Promise<Goal | null>;
export async function updateGoal(
	ref: GoalStoreRef,
	update: GoalUpdate,
	source: GoalUpdateSource = "model",
	expected?: GoalExpectation,
): Promise<Goal | null> {
	return withHardenedGoalStoreMutation(ref, async () => updateGoalUnlocked(ref, update, source, expected));
}

async function updateGoalUnlocked(
	ref: GoalStoreRef,
	update: GoalUpdate,
	source: GoalUpdateSource,
	expected: GoalExpectation | undefined,
): Promise<Goal | null> {
	const current = await readGoalFile(ref);
	if (!current) throw new GoalNotFoundError("cannot update goal: no goal exists");
	if (expected !== undefined && !matchesGoalExpectation(current, expected)) return null;

	const validatedObjective =
		update.objective === undefined ? undefined : validateObjective(update.objective, objectiveFullTextFileName(ref));
	const objective = validatedObjective?.objective ?? current.objective;
	const tokenBudget = resolveTokenBudget(current.tokenBudget, update.tokenBudget);
	const now = nextUpdatedAt(current.updatedAt);
	const hasObjectiveUpdate = update.objective !== undefined;
	const replacesSameTruncatedObjective =
		validatedObjective?.truncated === true &&
		objective === current.objective &&
		(await readFullObjectiveText(ref))?.trim() !== update.objective?.trim();
	const replacesGoal =
		hasObjectiveUpdate &&
		(objective !== current.objective || current.status === "complete" || replacesSameTruncatedObjective);
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
		await writeGoalAndSidecar(ref, current, next, validatedObjective?.truncated ? (update.objective ?? "") : null);
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
	await writeGoalAndSidecar(
		ref,
		current,
		next,
		validatedObjective === undefined ? undefined : validatedObjective.truncated ? (update.objective ?? "") : null,
	);
	return next;
}

export async function archiveGoal(ref: GoalStoreRef, goal: Goal): Promise<void> {
	await withHardenedGoalStoreMutation(ref, async () => archiveGoalUnlocked(ref, goal));
}

async function archiveGoalUnlocked(ref: GoalStoreRef, goal: Goal): Promise<void> {
	const filePath = goalHistoryFilePath(ref);
	await mkdir(dirname(filePath), { recursive: true });
	try {
		await chmod(filePath, 0o600);
	} catch (error) {
		if (!isMissingFileError(error)) throw error;
	}
	await appendFile(filePath, `${JSON.stringify(goal)}\n`, { encoding: "utf8", mode: 0o600 });
	await chmod(filePath, 0o600);
}

async function writeGoalAndSidecar(
	ref: GoalStoreRef,
	previousGoal: Goal | null,
	goal: Goal | null,
	sidecar: string | null | undefined,
): Promise<void> {
	await hardenGoalAuxiliaryFilePermissions(ref);
	if (sidecar === undefined) {
		await writeGoalFile(ref, goal);
		return;
	}
	if (sidecar === null) {
		await writeGoalFile(ref, goal);
		try {
			await removeFullObjectiveText(ref);
		} catch (error) {
			await restoreGoalFile(ref, previousGoal, error);
		}
		return;
	}

	const previousSidecar = await readFullObjectiveText(ref);
	await writeFullObjectiveText(ref, sidecar);
	try {
		await writeGoalFile(ref, goal);
	} catch (error) {
		try {
			if (previousSidecar === undefined) await removeFullObjectiveText(ref);
			else await writeFullObjectiveText(ref, previousSidecar);
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"goal store write failed and its full-objective sidecar could not be restored",
			);
		}
		throw error;
	}
}

async function hardenGoalAuxiliaryFilePermissions(ref: GoalStoreRef): Promise<void> {
	for (const filePath of [objectiveFullTextFilePath(ref), goalHistoryFilePath(ref)]) {
		try {
			await chmod(filePath, 0o600);
		} catch (error) {
			if (!isMissingFileError(error) && !isFileNameTooLongError(error)) throw error;
		}
	}
}

async function withHardenedGoalStoreMutation<T>(ref: GoalStoreRef, operation: () => Promise<T>): Promise<T> {
	return withGoalStoreMutation(ref, async () => {
		await hardenGoalAuxiliaryFilePermissions(ref);
		return operation();
	});
}

async function restoreGoalFile(ref: GoalStoreRef, previousGoal: Goal | null, error: unknown): Promise<never> {
	try {
		await writeGoalFile(ref, previousGoal);
	} catch (cleanupError) {
		throw new AggregateError(
			[error, cleanupError],
			"full-objective sidecar cleanup failed and the goal store could not be restored",
		);
	}
	throw error;
}

async function readFullObjectiveText(ref: GoalStoreRef): Promise<string | undefined> {
	try {
		return await readFile(objectiveFullTextFilePath(ref), "utf8");
	} catch (error) {
		if (isMissingFileError(error) || isFileNameTooLongError(error)) return undefined;
		throw error;
	}
}

async function writeFullObjectiveText(ref: GoalStoreRef, objective: string): Promise<void> {
	await writePrivateFileAtomic(objectiveFullTextFilePath(ref), objective);
}

async function removeFullObjectiveText(ref: GoalStoreRef): Promise<void> {
	try {
		await rm(objectiveFullTextFilePath(ref), { force: true });
	} catch (error) {
		if (isFileNameTooLongError(error)) return;
		throw error;
	}
}

export async function clearGoal(ref: GoalStoreRef): Promise<boolean> {
	return withHardenedGoalStoreMutation(ref, async () => {
		const current = await readGoalFile(ref);
		await writeGoalAndSidecar(ref, current, null, null);
		return current !== null;
	});
}

export async function accountGoalUsage(
	ref: GoalStoreRef,
	usage: TokenUsageSnapshot,
	elapsedSeconds: number,
	mode: GoalAccountingMode = "active",
	expectedGoalId?: string,
): Promise<Goal | null> {
	return withHardenedGoalStoreMutation(ref, async () => {
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
	expected?: GoalExpectation,
): Promise<Goal | null> {
	return withHardenedGoalStoreMutation(ref, async () => {
		const goal = await readGoalFile(ref);
		if (!goal || (expected !== undefined && !matchesGoalExpectation(goal, expected))) return null;
		const next: Goal = {
			...goal,
			consecutiveContinuations: (goal.consecutiveContinuations ?? 0) + 1,
			lastContinuationSignature: signature,
		};
		await writeGoalFile(ref, next);
		return next;
	});
}

export async function rollbackContinuationDelivered(
	ref: GoalStoreRef,
	previous: Pick<Goal, "id" | "status" | "consecutiveContinuations" | "lastContinuationSignature">,
	signature: string,
): Promise<Goal | null> {
	return withHardenedGoalStoreMutation(ref, async () => {
		const goal = await readGoalFile(ref);
		const previousCount = previous.consecutiveContinuations ?? 0;
		if (
			!goal ||
			goal.id !== previous.id ||
			goal.status !== previous.status ||
			goal.consecutiveContinuations !== previousCount + 1 ||
			goal.lastContinuationSignature !== signature
		) {
			return null;
		}
		const next: Goal = { ...goal, consecutiveContinuations: previousCount };
		if (previous.lastContinuationSignature === undefined) delete next.lastContinuationSignature;
		else next.lastContinuationSignature = previous.lastContinuationSignature;
		await writeGoalFile(ref, next);
		return next;
	});
}

export async function resetContinuationStreak(ref: GoalStoreRef, expected?: GoalExpectation): Promise<Goal | null> {
	return withHardenedGoalStoreMutation(ref, async () => {
		const goal = await readGoalFile(ref);
		if (!goal || (expected !== undefined && !matchesGoalExpectation(goal, expected))) return null;
		const next: Goal = { ...goal, consecutiveContinuations: 0 };
		delete next.lastContinuationSignature;
		await writeGoalFile(ref, next);
		return next;
	});
}

function matchesGoalExpectation(goal: Goal, expected: GoalExpectation): boolean {
	if (goal.id !== expected.id || goal.status !== expected.status) return false;
	if (expected.continuation === undefined) return true;
	return (
		(goal.consecutiveContinuations ?? 0) === expected.continuation.consecutiveContinuations &&
		goal.lastContinuationSignature === expected.continuation.lastContinuationSignature
	);
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

function isMissingFileError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isFileNameTooLongError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENAMETOOLONG";
}
