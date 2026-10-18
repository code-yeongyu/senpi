/**
 * Standalone worker for cross-process goal-store atomicity tests.
 *
 * Usage:
 *   bun <this-file> <baseDir> <threadId> <iterations>   account one input token per iteration
 *   bun <this-file> <baseDir> <threadId> hold           take the goal lock and keep it until killed
 *
 * The first stdout line ("first-update-committed" or "lock-held") lets a test order its own
 * step after this process has reached that point, without sleeping.
 */
import lockfile from "proper-lockfile";
import { GOAL_LOCK_OPTIONS, goalLockFilePath } from "../../src/core/extensions/builtin/goal/goal-file-lock.ts";
import { accountGoalUsage, goalFilePath } from "../../src/core/extensions/builtin/goal/store.ts";
import type { GoalStoreRef, TokenUsageSnapshot } from "../../src/core/extensions/builtin/goal/types.ts";

const ONE_INPUT_TOKEN: TokenUsageSnapshot = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 };
const USAGE = "usage: bun goal-cross-process-worker.ts <baseDir> <threadId> <iterations|hold>\n";

const [baseDir, threadId, mode] = process.argv.slice(2);
if (!baseDir || !threadId || !mode) {
	process.stderr.write(USAGE);
	process.exit(2);
}
const ref: GoalStoreRef = { baseDir, threadId };

if (mode === "hold") {
	await lockfile.lock(goalFilePath(ref), { ...GOAL_LOCK_OPTIONS, lockfilePath: goalLockFilePath(ref) });
	process.stdout.write("lock-held\n");
	setInterval(() => undefined, 60_000);
} else {
	const iterations = Number(mode);
	if (!Number.isInteger(iterations) || iterations < 1) {
		process.stderr.write(USAGE);
		process.exit(2);
	}
	try {
		for (let i = 0; i < iterations; i++) {
			await accountGoalUsage(ref, ONE_INPUT_TOKEN, 0, "active");
			if (i === 0) process.stdout.write("first-update-committed\n");
		}
	} catch (error) {
		const name = error instanceof Error ? error.name : "Error";
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${name}: ${message}\n`);
		process.exit(1);
	}
}
