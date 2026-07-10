import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	accountGoalUsage,
	clearGoal,
	createGoal,
	goalFilePath,
	readGoal,
	updateGoal,
	writeGoal,
} from "../../src/core/extensions/builtin/goal/store.ts";
import type { GoalStoreRef } from "../../src/core/extensions/builtin/goal/types.ts";

const tempDirs: string[] = [];

async function tempStore(threadId = "thread-test"): Promise<GoalStoreRef> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-goal-"));
	tempDirs.push(dir);
	return { baseDir: join(dir, "extensions", "goal"), threadId };
}

async function writeRawGoalFile(ref: GoalStoreRef, contents: string): Promise<void> {
	await mkdir(ref.baseDir, { recursive: true });
	await writeFile(goalFilePath(ref), contents, "utf8");
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("goal store JSON recovery", () => {
	it("reads an unchanged valid goal file", async () => {
		// Given
		const ref = await tempStore("thread-valid-json");
		const goal = await createGoal(ref, "Keep reading valid goals");

		// When
		const persisted = await readGoal(ref);

		// Then
		expect(persisted).toEqual(goal);
	});

	it("recovers a complete goal file followed by stale closing braces", async () => {
		// Given
		const ref = await tempStore("thread-stale-braces");
		const goal = await createGoal(ref, 'Resume } the "named" session \\ safely');
		const validContents = await readFile(goalFilePath(ref), "utf8");
		await writeRawGoalFile(ref, `${validContents}}\n}\n`);

		// When
		const recovered = await readGoal(ref);

		// Then
		expect(recovered).toEqual(goal);
	});

	it("rejects truncated JSON", async () => {
		// Given
		const ref = await tempStore("thread-truncated-json");
		await writeRawGoalFile(ref, '{"version":1,"goal":');

		// When / Then
		await expect(readGoal(ref)).rejects.toBeInstanceOf(SyntaxError);
	});

	it("rejects arbitrary trailing text", async () => {
		// Given
		const ref = await tempStore("thread-trailing-text");
		await createGoal(ref, "Reject arbitrary suffixes");
		const validContents = await readFile(goalFilePath(ref), "utf8");
		await writeRawGoalFile(ref, `${validContents}not-stale-write-bytes`);

		// When / Then
		await expect(readGoal(ref)).rejects.toBeInstanceOf(SyntaxError);
	});

	it("rejects adversarial stale-brace suffixes without blocking", async () => {
		// Given
		const ref = await tempStore("thread-adversarial-stale-braces");
		await createGoal(ref, "Reject adversarial stale-brace suffixes");
		const validContents = await readFile(goalFilePath(ref), "utf8");
		await writeRawGoalFile(ref, `${validContents}${"} ".repeat(24)}X`);

		// When / Then
		const startedAt = performance.now();
		await expect(readGoal(ref)).rejects.toBeInstanceOf(SyntaxError);
		const elapsedMs = performance.now() - startedAt;
		expect(elapsedMs).toBeLessThan(500);
	});

	it("rejects unsupported versions even with stale closing braces", async () => {
		// Given
		const ref = await tempStore("thread-unsupported-version");
		await writeRawGoalFile(ref, '{"version":2,"goal":null}\n}\n');

		// When / Then
		await expect(readGoal(ref)).rejects.toThrow("unsupported goal store version");
	});

	it("rejects invalid goal shapes even with stale closing braces", async () => {
		// Given
		const ref = await tempStore("thread-invalid-goal");
		await writeRawGoalFile(ref, '{"version":1,"goal":{"id":1}}\n}\n');

		// When / Then
		await expect(readGoal(ref)).rejects.toThrow("goal store contains an invalid goal");
	});
});

describe("goal store atomic writes", () => {
	it("leaves complete JSON after overlapping long and short writes", async () => {
		// Given
		const ref = await tempStore("thread-overlapping-writes");
		const goal = await createGoal(ref, "Initial goal");
		const longGoal = { ...goal, objective: "x".repeat(4_000_000), updatedAt: goal.updatedAt + 1 };
		const shortGoal = { ...goal, objective: "short", updatedAt: goal.updatedAt + 2 };

		// When / Then
		for (let iteration = 0; iteration < 50; iteration += 1) {
			await Promise.all([writeGoal(ref, longGoal), writeGoal(ref, shortGoal)]);
			const parsed: unknown = JSON.parse(await readFile(goalFilePath(ref), "utf8"));
			expect(parsed).toMatchObject({ version: 1 });
		}
		expect(await readdir(ref.baseDir)).toEqual([basename(goalFilePath(ref))]);
	});
});

describe("goal store (budget-free)", () => {
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
