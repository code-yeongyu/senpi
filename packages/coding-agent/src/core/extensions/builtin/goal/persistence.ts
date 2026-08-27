import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { InvalidGoalStoreError, UnsupportedGoalStoreVersionError } from "./errors.ts";
import type { Goal, GoalFile, GoalStatus, GoalStoreRef } from "./types.ts";
import { isRecord } from "./types.ts";
import { isGoalStatus, isNonNegativeSafeInteger } from "./validation.ts";

const STORE_VERSION = 1;
const CURRENT_STORE_DIRECTORY = "goal";
const LEGACY_STORE_DIRECTORY = "pi-goal";
const LEGACY_BUDGET_LIMITED_STATUSES = ["budgetLimited", "budget_limited"];

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

/**
 * Imports legacy standalone `pi-goal` state into the current budget-free store.
 *
 * The current store always wins and legacy normalization is confined to this path.
 * Invalid, unsupported, or malformed legacy files are best-effort dead-data imports:
 * they remain untouched and do not block the live current store. Unexpected filesystem
 * failures still propagate.
 *
 * Session-backed stores use their stable thread id. No-session stores enumerate the
 * cwd-keyed legacy bucket because each ephemeral run receives a new thread id, and they
 * inspect both the redirected Senpi-root sibling and the standalone pi agent root.
 * Multiple valid live candidates are reported as a conflict rather than guessed.
 *
 * Returns the imported goal, or null when nothing was migrated.
 */
export async function migrateLegacyGoalFile(ref: GoalStoreRef): Promise<Goal | null> {
	try {
		await readFile(goalFilePath(ref), "utf8");
		return null;
	} catch (error) {
		if (!isMissingFile(error)) throw error;
	}

	const legacyCandidates = await readLegacyGoalCandidates(ref);
	if (legacyCandidates.length > 1) {
		throw new Error(
			`multiple legacy goals found for no-session store: ${legacyCandidates.map(({ path }) => path).join(", ")}`,
		);
	}
	const candidate = legacyCandidates[0];
	if (candidate === undefined) return null;
	const published = await publishMigratedGoalFile(ref, candidate.goal);
	await retireLegacyGoalFile(candidate.path);
	return published ? candidate.goal : null;
}

interface LegacyGoalCandidate {
	path: string;
	goal: Goal;
}

async function readLegacyGoalCandidates(ref: GoalStoreRef): Promise<LegacyGoalCandidate[]> {
	const legacyBaseDir = legacyBaseDirFor(ref.baseDir);
	if (legacyBaseDir === undefined) return [];
	const cwdKey = noSessionCwdKey(ref.baseDir);
	if (cwdKey === undefined) {
		const candidate = await readLegacyGoalCandidate(goalFilePath({ ...ref, baseDir: legacyBaseDir }));
		return candidate === null ? [] : [candidate];
	}

	const standaloneAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const baseDirs = new Set([
		legacyBaseDir,
		join(standaloneAgentDir, "extensions", LEGACY_STORE_DIRECTORY, "no-session", cwdKey),
	]);
	const candidatePaths: string[] = [];
	for (const baseDir of baseDirs) {
		let entries: Dirent<string>[];
		try {
			entries = await readdir(baseDir, { withFileTypes: true });
		} catch (error) {
			if (isMissingFile(error)) continue;
			throw error;
		}
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith(".json")) candidatePaths.push(join(baseDir, entry.name));
		}
	}

	const candidates: LegacyGoalCandidate[] = [];
	for (const path of candidatePaths.sort()) {
		const candidate = await readLegacyGoalCandidate(path);
		if (candidate !== null) candidates.push(candidate);
	}
	return candidates;
}

async function readLegacyGoalCandidate(path: string): Promise<LegacyGoalCandidate | null> {
	let goal: Goal | null;
	try {
		goal = parseGoalFile(await readFile(path, "utf8"), { legacy: true }).goal;
	} catch (error) {
		if (isMissingFile(error) || isIgnoredLegacyStoreError(error)) return null;
		throw error;
	}
	if (goal === null) {
		await retireLegacyGoalFile(path);
		return null;
	}
	return { path, goal };
}

async function retireLegacyGoalFile(path: string): Promise<void> {
	try {
		await rename(path, `${path}.migrated`);
	} catch {
		// Retirement is best-effort: a preserved legacy file must never fail live migration.
	}
}

function isIgnoredLegacyStoreError(error: unknown): boolean {
	return (
		error instanceof InvalidGoalStoreError ||
		error instanceof UnsupportedGoalStoreVersionError ||
		error instanceof SyntaxError
	);
}

/**
 * Maps a current goal-store directory to its legacy `pi-goal` counterpart by replacing
 * the `goal` path segment itself.
 *
 * Both store layouts must map correctly:
 *   <sessionDir>/extensions/goal            -> <sessionDir>/extensions/pi-goal
 *   <agentDir>/extensions/goal/no-session/<cwdKey>
 *                                           -> <agentDir>/extensions/pi-goal/no-session/<cwdKey>
 *
 * Swapping `dirname(baseDir)` only works for the first layout; in the no-session
 * fallback it points inside the current store tree, which both misses real legacy
 * state and can import an unrelated nested directory.
 */
function legacyBaseDirFor(baseDir: string): string | undefined {
	const segments = pathSegments(baseDir);
	const goalIndex = segments.lastIndexOf(CURRENT_STORE_DIRECTORY);
	if (goalIndex === -1) return undefined;
	segments[goalIndex] = LEGACY_STORE_DIRECTORY;
	return segments.join(sep);
}

function noSessionCwdKey(baseDir: string): string | undefined {
	const segments = pathSegments(baseDir);
	const goalIndex = segments.lastIndexOf(CURRENT_STORE_DIRECTORY);
	if (goalIndex === -1 || segments[goalIndex + 1] !== "no-session") return undefined;
	return segments[goalIndex + 2];
}

function pathSegments(path: string): string[] {
	return path.split(/[\\/]/);
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

async function publishMigratedGoalFile(ref: GoalStoreRef, goal: Goal): Promise<boolean> {
	const filePath = goalFilePath(ref);
	await mkdir(dirname(filePath), { recursive: true });
	const contents = `${JSON.stringify({ version: STORE_VERSION, goal }, null, 2)}\n`;
	try {
		await writeFile(filePath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
		return true;
	} catch (error) {
		if (isFileSystemError(error, "EEXIST")) return false;
		throw error;
	}
}

function parseGoalFile(raw: string, { legacy = false }: { legacy?: boolean } = {}): GoalFile {
	const parsed = parseGoalFileJson(raw);
	if (!isRecord(parsed)) throw new InvalidGoalStoreError("goal store must be a JSON object");
	if (parsed.version !== STORE_VERSION) throw new UnsupportedGoalStoreVersionError("unsupported goal store version");
	const goal = legacy ? normalizeLegacyGoal(parsed.goal) : parsed.goal;
	if (goal !== null && !isGoal(goal)) throw new InvalidGoalStoreError("goal store contains an invalid goal");
	return { version: STORE_VERSION, goal: goal === null ? null : sanitizeContinuationState(goal) };
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

/**
 * Drops legacy budget enforcement: `tokenBudget` is a budgeting input in `pi-goal`, and
 * `budgetLimited` is a status this fork removed, so a budget-limited legacy goal resumes
 * as `active`. This runs only on the legacy import path.
 */
function normalizeLegacyGoal(value: unknown): unknown {
	if (!isRecord(value)) return value;
	const normalized = { ...value };
	delete normalized.tokenBudget;
	if (typeof normalized.status === "string" && LEGACY_BUDGET_LIMITED_STATUSES.includes(normalized.status)) {
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
	if (!isNonNegativeSafeInteger(next.unattendedContinuations)) delete next.unattendedContinuations;
	if (typeof next.lastContinuationSignature !== "string") delete next.lastContinuationSignature;
	return next;
}

function isMissingFile(error: unknown): boolean {
	return isFileSystemError(error, "ENOENT");
}

function isFileSystemError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
