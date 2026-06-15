import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	accountGoalUsage,
	clearGoal,
	createGoal,
	goalFilePath,
	readGoal,
	updateGoal,
} from "../../src/core/extensions/builtin/goal/store.ts";
import type { GoalStoreRef } from "../../src/core/extensions/builtin/goal/types.ts";

const tempDirs: string[] = [];

async function tempStore(threadId = "thread-test"): Promise<GoalStoreRef> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-goal-"));
	tempDirs.push(dir);
	return { baseDir: join(dir, "extensions", "goal"), threadId };
}

describe("goal store (budget-free)", () => {
	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("creates a persisted active goal with no budget field", async () => {
		const ref = await tempStore("thread-create");
		const goal = await createGoal(ref, "  Ship the extension  ");

		expect(goal.threadId).toBe("thread-create");
		expect(goal.objective).toBe("Ship the extension");
		expect(goal.status).toBe("active");
		expect(goal).not.toHaveProperty("tokenBudget");
		expect(await readGoal(ref)).toMatchObject({ id: goal.id, objective: "Ship the extension" });
		expect(goalFilePath(ref)).toContain(join("extensions", "goal", "thread-create.json"));

		const fileContents = await readFile(goalFilePath(ref), "utf8");
		expect(fileContents).toContain('"version": 1');
		expect(fileContents).not.toContain("tokenBudget");
		expect(fileContents).not.toContain("budget");
	});

	it("does not replace an existing goal when createGoal is called again", async () => {
		const ref = await tempStore("thread-duplicate-create");
		const original = await createGoal(ref, "Original");

		await expect(createGoal(ref, "Replacement")).rejects.toThrow(
			"cannot create a new goal because this thread already has a goal",
		);

		expect(await readGoal(ref)).toMatchObject({ id: original.id, objective: "Original" });
	});

	it("replaces changed objectives and preserves usage for status updates", async () => {
		const ref = await tempStore();
		const first = await createGoal(ref, "Original");
		await accountGoalUsage(ref, { input: 23, output: 2, cacheRead: 0, cacheWrite: 4, totalTokens: 25 }, 70);

		const paused = await updateGoal(ref, { status: "paused" });
		expect(paused.id).toBe(first.id);
		expect(paused.tokensUsed).toBe(25);
		expect(paused.timeUsedSeconds).toBe(70);

		const replaced = await updateGoal(ref, { objective: "Replacement" });
		expect(replaced.id).not.toBe(first.id);
		expect(replaced.tokensUsed).toBe(0);
		expect(replaced.timeUsedSeconds).toBe(0);
		expect(replaced.status).toBe("active");
	});

	it("resumes a matching nonterminal goal when the objective is set again", async () => {
		const ref = await tempStore();
		const first = await createGoal(ref, "Same");
		const paused = await updateGoal(ref, { status: "paused" });

		const resumed = await updateGoal(ref, { objective: "Same" });

		expect(paused.id).toBe(first.id);
		expect(resumed.id).toBe(first.id);
		expect(resumed.status).toBe("active");
	});

	it("counts non-cached input plus output tokens", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Tracked");

		const goal = await accountGoalUsage(
			ref,
			{ input: 100, output: 20, cacheRead: 70, cacheWrite: 0, totalTokens: 999 },
			0,
		);

		expect(goal).toMatchObject({ tokensUsed: 120 });
	});

	it("never transitions status from accounting, regardless of token volume", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Tracked");

		const goal = await accountGoalUsage(
			ref,
			{ input: 10_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10_000_000 },
			4,
		);

		expect(goal?.status).toBe("active");
		expect(goal?.tokensUsed).toBe(10_000_000);
		expect(goal?.timeUsedSeconds).toBe(4);
	});

	it("only accounts active usage unless the completing turn is finalized", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Tracked");
		await updateGoal(ref, { status: "paused" });

		const activeOnly = await accountGoalUsage(
			ref,
			{ input: 25, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 25 },
			3,
			"active",
		);
		expect(activeOnly).toMatchObject({ status: "paused", tokensUsed: 0, timeUsedSeconds: 0 });
	});

	it("marks a goal complete and stamps completedAt", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Finish me");

		const completed = await updateGoal(ref, { status: "complete" });
		expect(completed.status).toBe("complete");
		expect(typeof completed.completedAt).toBe("number");
		expect(completed.lastStartedAt).toBeUndefined();
	});

	it("clears the store while preserving the versioned file", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Temporary");

		expect(await clearGoal(ref)).toBe(true);
		expect(await readGoal(ref)).toBeNull();
		expect(await readFile(goalFilePath(ref), "utf8")).toContain('"version": 1');
	});
});
