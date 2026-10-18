import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import { GOAL_LOCK_OPTIONS, goalLockFilePath } from "../../src/core/extensions/builtin/goal/goal-file-lock.ts";
import { writeGoalFile } from "../../src/core/extensions/builtin/goal/persistence.ts";
import {
	accountGoalUsage,
	createGoal,
	goalFilePath,
	readGoal,
	updateGoal,
} from "../../src/core/extensions/builtin/goal/store.ts";
import type { GoalStoreRef, TokenUsageSnapshot } from "../../src/core/extensions/builtin/goal/types.ts";

const tempDirs: string[] = [];
const children: ChildProcess[] = [];
const workerPath = join(import.meta.dirname, "goal-cross-process-worker.ts");
const packageRoot = join(import.meta.dirname, "../..");
const ONE_INPUT_TOKEN: TokenUsageSnapshot = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 };

interface WorkerRun {
	child: ChildProcess;
	firstLine: Promise<void>;
	exited: Promise<{ exitCode: number; stderr: string }>;
}

async function tempStore(threadId: string): Promise<{ ref: GoalStoreRef; agentDir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-goal-xproc-"));
	tempDirs.push(dir);
	return { ref: { baseDir: join(dir, "extensions", "goal"), threadId }, agentDir: join(dir, "agent") };
}

function spawnWorker(ref: GoalStoreRef, agentDir: string, mode: number | "hold"): WorkerRun {
	const child = spawn("bun", [workerPath, ref.baseDir, ref.threadId, String(mode)], {
		cwd: packageRoot,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, SENPI_CODING_AGENT_DIR: agentDir },
	});
	children.push(child);
	const stderrChunks: Buffer[] = [];
	child.on("error", (error) => stderrChunks.push(Buffer.from(`spawn failed: ${error.message}\n`)));
	child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
	const exited = new Promise<{ exitCode: number; stderr: string }>((resolve) => {
		child.on("close", (code) => {
			resolve({ exitCode: code ?? 1, stderr: Buffer.concat(stderrChunks).toString("utf8") });
		});
	});
	const firstLine = new Promise<void>((resolve, reject) => {
		child.stdout?.once("data", () => resolve());
		void exited.then(({ stderr }) => reject(new Error(`worker exited before its first line: ${stderr}`)));
	});
	firstLine.catch(() => undefined);
	return { child, firstLine, exited };
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("goal store cross-process atomicity", () => {
	it("keeps 600 of 600 usage updates from two real processes", async () => {
		// Given: one active goal shared by two separate processes.
		const { ref, agentDir } = await tempStore("two-process-race");
		await createGoal(ref, "Cross-process atomicity probe");

		// When: each process runs 300 read-modify-write usage updates concurrently.
		const [a, b] = await Promise.all([
			spawnWorker(ref, agentDir, 300).exited,
			spawnWorker(ref, agentDir, 300).exited,
		]);

		// Then: no update is lost and the status is untouched.
		expect(a).toEqual({ exitCode: 0, stderr: "" });
		expect(b).toEqual({ exitCode: 0, stderr: "" });
		const goal = await readGoal(ref);
		expect(goal?.tokensUsed).toBe(600);
		expect(goal?.status).toBe("active");
	}, 120_000);

	it("never reverts a completion applied while another process is still accounting usage", async () => {
		// Given: a second process already committing usage updates to the active goal.
		const { ref, agentDir } = await tempStore("status-revert-race");
		await createGoal(ref, "Status revert probe");
		const worker = spawnWorker(ref, agentDir, 2_000);
		await worker.firstLine;

		// When: this process completes the goal mid-stream.
		const completed = await updateGoal(ref, { status: "complete" }, "model");
		const result = await worker.exited;

		// Then: the completion is the last transition and no stale writer brought the goal back.
		expect(result.exitCode).toBe(0);
		const goal = await readGoal(ref);
		expect(goal?.status).toBe("complete");
		expect(goal?.tokensUsed).toBe(completed.tokensUsed);
	}, 120_000);

	it("rejects a writer visibly instead of overwriting the newer goal held under a live lock", async () => {
		// Given: this process holds the goal lock and has written a newer value under it.
		const { ref, agentDir } = await tempStore("lock-busy-rejection");
		const seeded = await createGoal(ref, "Lock busy rejection probe");
		const release = await lockfile.lock(goalFilePath(ref), {
			...GOAL_LOCK_OPTIONS,
			lockfilePath: goalLockFilePath(ref),
		});
		let result: { exitCode: number; stderr: string };
		try {
			await writeGoalFile(ref, { ...seeded, tokensUsed: 42 });

			// When: another process tries to update the same goal past the lock wait budget.
			result = await spawnWorker(ref, agentDir, 1).exited;
		} finally {
			await release();
		}

		// Then: the other writer fails loudly with the busy reason and the newer value survives.
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("GoalStoreBusyError: Goal store is busy");
		expect((await readGoal(ref))?.tokensUsed).toBe(42);
	}, 60_000);

	it("recovers the lock of a process killed while holding it instead of wedging the goal", async () => {
		// Given: another process took the goal lock and was killed without releasing it.
		const { ref, agentDir } = await tempStore("crashed-holder-recovery");
		await createGoal(ref, "Crashed holder probe");
		const holder = spawnWorker(ref, agentDir, "hold");
		await holder.firstLine;
		holder.child.kill("SIGKILL");
		await holder.exited;
		expect(existsSync(goalLockFilePath(ref))).toBe(true);

		// When: this process mutates the goal.
		const goal = await accountGoalUsage(ref, ONE_INPUT_TOKEN, 0, "active");

		// Then: the dead holder's lock is reclaimed, the update lands, and the lock is released.
		expect(goal?.tokensUsed).toBe(1);
		expect((await readGoal(ref))?.tokensUsed).toBe(1);
		expect(existsSync(goalLockFilePath(ref))).toBe(false);
	}, 60_000);

	it("lands all updates from two concurrent loops in one process", async () => {
		// Given: one goal and a single process.
		const { ref } = await tempStore("single-process-fast-path");
		await createGoal(ref, "Single-process concurrency probe");

		// When: two concurrent loops each account 300 usage updates.
		const loop = async () => {
			for (let i = 0; i < 300; i++) await accountGoalUsage(ref, ONE_INPUT_TOKEN, 0, "active");
		};
		await Promise.all([loop(), loop()]);

		// Then: the in-process tail keeps every update.
		expect((await readGoal(ref))?.tokensUsed).toBe(600);
	}, 60_000);
});
