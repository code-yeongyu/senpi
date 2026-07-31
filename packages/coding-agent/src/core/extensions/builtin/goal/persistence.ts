import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { InvalidGoalStoreError, UnsupportedGoalStoreVersionError } from "./errors.ts";
import type { Goal, GoalFile, GoalStatus, GoalStoreRef } from "./types.ts";
import { isRecord } from "./types.ts";
import { isGoalStatus, isNonNegativeSafeInteger } from "./validation.ts";

const STORE_VERSION = 1;

export function encodedThreadId(ref: GoalStoreRef): string {
	return encodeURIComponent(ref.threadId);
}

export function goalFilePath(ref: GoalStoreRef): string {
	return join(ref.baseDir, `${encodedThreadId(ref)}.json`);
}

export async function readGoalFile(ref: GoalStoreRef): Promise<Goal | null> {
	try {
		return parseGoalFile(await readFile(goalFilePath(ref), "utf8")).goal;
	} catch (error) {
		if (isMissingFile(error)) return null;
		throw error;
	}
}

export async function migrateLegacyGoalFile(ref: GoalStoreRef): Promise<Goal | null> {
	try {
		await readFile(goalFilePath(ref), "utf8");
		return null;
	} catch (error) {
		if (!isMissingFile(error)) throw error;
	}

	const legacyRef = { ...ref, baseDir: join(dirname(ref.baseDir), "pi-goal") };
	let legacyGoal: Goal | null;
	try {
		legacyGoal = parseGoalFile(await readFile(goalFilePath(legacyRef), "utf8")).goal;
	} catch (error) {
		if (isMissingFile(error)) return null;
		throw error;
	}
	if (legacyGoal === null) return null;
	await writeGoalFile(ref, legacyGoal);
	return legacyGoal;
}

export async function writeGoalFile(ref: GoalStoreRef, goal: Goal | null): Promise<void> {
	const filePath = goalFilePath(ref);
	await mkdir(dirname(filePath), { recursive: true });
	await writeGoalFileAtomic(filePath, `${JSON.stringify({ version: STORE_VERSION, goal }, null, 2)}\n`);
}

async function writeGoalFileAtomic(filePath: string, contents: string): Promise<void> {
	const tempPath = join(dirname(filePath), `.goal-${randomUUID()}.tmp`);
	try {
		await writeFile(tempPath, contents, { encoding: "utf8", mode: 0o600 });
		await rename(tempPath, filePath);
	} catch (error) {
		try {
			await rm(tempPath, { force: true });
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"goal store write failed and its temporary file could not be removed",
			);
		}
		throw error;
	}
}

function parseGoalFile(raw: string): GoalFile {
	const parsed = parseGoalFileJson(raw);
	if (!isRecord(parsed)) throw new InvalidGoalStoreError("goal store must be a JSON object");
	if (parsed.version !== STORE_VERSION) throw new UnsupportedGoalStoreVersionError("unsupported goal store version");
	const normalizedGoal = normalizeLegacyGoal(parsed.goal);
	if (normalizedGoal !== null && !isGoal(normalizedGoal))
		throw new InvalidGoalStoreError("goal store contains an invalid goal");
	return {
		version: STORE_VERSION,
		goal: normalizedGoal === null ? null : sanitizeContinuationState(normalizedGoal),
	};
}

function parseGoalFileJson(raw: string): unknown {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		const recovered = recoverGoalFileWithStaleClosingBraces(raw);
		if (recovered === undefined) throw error;
		try {
			parsed = JSON.parse(recovered);
		} catch {
			throw error;
		}
	}
	return parsed;
}

function normalizeLegacyGoal(value: unknown): unknown {
	if (!isRecord(value)) return value;
	const normalized = { ...value };
	delete normalized.tokenBudget;
	if (normalized.status === "budgetLimited" || normalized.status === "budget_limited") {
		normalized.status = "active";
	}
	return normalized;
}

function recoverGoalFileWithStaleClosingBraces(raw: string): string | undefined {
	let rootStart = 0;
	while (rootStart < raw.length && /[\t\n\r ]/.test(raw[rootStart] ?? "")) rootStart += 1;
	if (raw[rootStart] !== "{") return undefined;

	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = rootStart; index < raw.length; index += 1) {
		const character = raw[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') inString = true;
		else if (character === "{" || character === "[") depth += 1;
		else if (character === "}" || character === "]") {
			depth -= 1;
			if (depth < 0) return undefined;
			if (depth === 0) {
				let hasStaleClosingBrace = false;
				for (let suffixIndex = index + 1; suffixIndex < raw.length; suffixIndex += 1) {
					const suffix = raw[suffixIndex];
					if (suffix === "}") hasStaleClosingBrace = true;
					else if (suffix !== " " && suffix !== "\t" && suffix !== "\n" && suffix !== "\r") return undefined;
				}
				return hasStaleClosingBrace ? raw.slice(0, index + 1) : undefined;
			}
		}
	}
	return undefined;
}

function isGoal(value: unknown): value is Goal {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.threadId === "string" &&
		typeof value.objective === "string" &&
		isGoalStatus(value.status) &&
		(value.tokenBudget === undefined || isNonNegativeSafeInteger(value.tokenBudget)) &&
		hasValidBlockedFields(value, value.status) &&
		isNonNegativeSafeInteger(value.tokensUsed) &&
		isNonNegativeSafeInteger(value.timeUsedSeconds) &&
		isNonNegativeSafeInteger(value.createdAt) &&
		isNonNegativeSafeInteger(value.updatedAt) &&
		(value.lastStartedAt === undefined || isNonNegativeSafeInteger(value.lastStartedAt)) &&
		(value.completedAt === undefined || isNonNegativeSafeInteger(value.completedAt))
	);
}

function hasValidBlockedFields(value: Record<string, unknown>, status: GoalStatus): boolean {
	if (status === "blocked") {
		return (
			typeof value.blockedReason === "string" &&
			value.blockedReason.trim().length > 0 &&
			isNonNegativeSafeInteger(value.blockedAt)
		);
	}
	return value.blockedReason === undefined && value.blockedAt === undefined;
}

function sanitizeContinuationState(goal: Goal): Goal {
	const next: Goal = { ...goal };
	if (!isNonNegativeSafeInteger(next.consecutiveContinuations)) delete next.consecutiveContinuations;
	if (typeof next.lastContinuationSignature !== "string") delete next.lastContinuationSignature;
	return next;
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
