import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateLegacyGoalFile } from "../../src/core/extensions/builtin/goal/persistence.ts";
import {
	accountGoalUsage,
	clearGoal,
	createGoal,
	goalFilePath,
	readGoal,
	recordContinuationDelivered,
	resetContinuationStreak,
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

	it("preserves the original parse error for mismatched container corruption", async () => {
		// Given
		const ref = await tempStore("thread-mismatched-container");
		const raw = '{"version":1,"goal":[}}}';
		let originalMessage = "";
		try {
			JSON.parse(raw);
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
			originalMessage = error.message;
		}
		await writeRawGoalFile(ref, raw);

		// When
		const read = readGoal(ref);

		// Then
		await expect(read).rejects.toThrow(originalMessage);
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
	it("writes a goal whose valid basename leaves no room for an appended temp suffix", async () => {
		// Given
		const ref = await tempStore("x".repeat(250));
		expect(Buffer.byteLength(basename(goalFilePath(ref)))).toBe(255);

		// When
		const goal = await createGoal(ref, "Persist at the component limit");

		// Then
		expect(await readGoal(ref)).toEqual(goal);
	});

	it.skipIf(process.platform === "win32")("preserves mode 0600 across atomic replacement", async () => {
		// Given
		const ref = await tempStore("thread-private-mode");
		const goal = await createGoal(ref, "Keep this private");
		await chmod(goalFilePath(ref), 0o600);
		const previousUmask = process.umask(0o022);

		// When
		try {
			await writeGoal(ref, { ...goal, objective: "Still private" });
		} finally {
			process.umask(previousUmask);
		}

		// Then
		const fileStat = await stat(goalFilePath(ref));
		expect(fileStat.mode & 0o777).toBe(0o600);
	});

	it("leaves exact bytes from one overlapping submitted goal", async () => {
		// Given
		const ref = await tempStore("thread-overlapping-writes");
		const goal = await createGoal(ref, "Initial goal");
		const longGoal = { ...goal, objective: "x".repeat(4_000_000), updatedAt: goal.updatedAt + 1 };
		const shortGoal = { ...goal, objective: "short", updatedAt: goal.updatedAt + 2 };
		const submittedFiles = [
			Buffer.from(`${JSON.stringify({ version: 1, goal: longGoal }, null, 2)}\n`),
			Buffer.from(`${JSON.stringify({ version: 1, goal: shortGoal }, null, 2)}\n`),
		];

		// When
		for (let iteration = 0; iteration < 50; iteration += 1) {
			await Promise.all([writeGoal(ref, longGoal), writeGoal(ref, shortGoal)]);
			const persisted = await readFile(goalFilePath(ref));

			// Then
			expect(submittedFiles.some((submittedFile) => submittedFile.equals(persisted))).toBe(true);
		}
		expect(await readdir(ref.baseDir)).toEqual([basename(goalFilePath(ref))]);
	});

	it("cleans its temp sibling after a deterministic rename failure", async () => {
		// Given
		const ref = await tempStore("thread-rename-failure");
		await mkdir(goalFilePath(ref), { recursive: true });

		// When
		const write = writeGoal(ref, null);

		// Then
		await expect(write).rejects.toBeInstanceOf(Error);
		expect(await readdir(ref.baseDir)).toEqual([basename(goalFilePath(ref))]);
		expect((await stat(goalFilePath(ref))).isDirectory()).toBe(true);
	});
});

describe("goal store (budget-free)", () => {
	it("migrates a legacy budget-limited goal as active without a budget", async () => {
		const ref = await tempStore("thread-legacy-budget");
		const legacyRef = { ...ref, baseDir: join(ref.baseDir, "..", "pi-goal") };
		const legacyGoal = {
			id: "legacy-goal",
			threadId: ref.threadId,
			objective: "Finish the inherited work",
			status: "budgetLimited",
			tokenBudget: 512,
			tokensUsed: 2_800_000,
			timeUsedSeconds: 120,
			createdAt: 100,
			updatedAt: 200,
		};
		await mkdir(legacyRef.baseDir, { recursive: true });
		await writeFile(
			goalFilePath(legacyRef),
			`${JSON.stringify({ version: 1, goal: legacyGoal }, null, 2)}\n`,
			"utf8",
		);

		const migrated = await migrateLegacyGoalFile(ref);

		expect(migrated).toMatchObject({
			id: "legacy-goal",
			objective: "Finish the inherited work",
			status: "active",
			tokensUsed: 2_800_000,
		});
		expect(migrated).not.toHaveProperty("tokenBudget");
		expect(await readGoal(ref)).toEqual(migrated);
		expect(await readFile(goalFilePath(ref), "utf8")).not.toContain("tokenBudget");
		expect(await readFile(goalFilePath(legacyRef), "utf8")).toContain('"tokenBudget": 512');
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

		const paused = await updateGoal(ref, { status: "paused" }, "user");
		expect(paused.id).toBe(first.id);
		expect(paused.tokensUsed).toBe(25);
		expect(paused.timeUsedSeconds).toBe(70);

		const replaced = await updateGoal(ref, { objective: "Replacement" }, "user");
		expect(replaced.id).not.toBe(first.id);
		expect(replaced.tokensUsed).toBe(0);
		expect(replaced.timeUsedSeconds).toBe(0);
		expect(replaced.status).toBe("active");
	});

	it("resumes a matching nonterminal goal when the objective is set again", async () => {
		const ref = await tempStore();
		const first = await createGoal(ref, "Same");
		const paused = await updateGoal(ref, { status: "paused" }, "user");

		const resumed = await updateGoal(ref, { objective: "Same" }, "user");

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
		await updateGoal(ref, { status: "paused" }, "user");

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

describe("goal continuation streak persistence", () => {
	it("starts new goals at zero continuations with no signature", async () => {
		const ref = await tempStore("thread-streak-new");
		const goal = await createGoal(ref, "Start clean");

		expect(goal.consecutiveContinuations).toBe(0);
		expect(goal.lastContinuationSignature).toBeUndefined();
		expect(await readGoal(ref)).toMatchObject({ consecutiveContinuations: 0 });
	});

	it("round-trips delivered continuations and their signature", async () => {
		const ref = await tempStore("thread-streak-roundtrip");
		const goal = await createGoal(ref, "Count continuations");

		const first = await recordContinuationDelivered(ref, `${goal.id}:0/3:hash-a`);
		expect(first).toMatchObject({
			consecutiveContinuations: 1,
			lastContinuationSignature: `${goal.id}:0/3:hash-a`,
		});

		const second = await recordContinuationDelivered(ref, `${goal.id}:0/3:hash-b`);
		expect(second?.consecutiveContinuations).toBe(2);

		const persisted = await readGoal(ref);
		expect(persisted).toMatchObject({
			consecutiveContinuations: 2,
			lastContinuationSignature: `${goal.id}:0/3:hash-b`,
		});

		const fileContents = await readFile(goalFilePath(ref), "utf8");
		expect(fileContents).toContain('"consecutiveContinuations": 2');
		expect(fileContents).toContain("hash-b");
	});

	it("leaves updatedAt unchanged when a continuation is delivered", async () => {
		const ref = await tempStore("thread-streak-updated-at");
		const goal = await createGoal(ref, "Steady clock");

		const delivered = await recordContinuationDelivered(ref, `${goal.id}:1/2:hash-c`);

		expect(delivered?.updatedAt).toBe(goal.updatedAt);
		expect((await readGoal(ref))?.updatedAt).toBe(goal.updatedAt);
	});

	it("parses goals written before continuation tracking with default streak semantics", async () => {
		const ref = await tempStore("thread-streak-legacy");
		await createGoal(ref, "Legacy goal");
		const raw = JSON.parse(await readFile(goalFilePath(ref), "utf8")) as { goal: Record<string, unknown> };
		delete raw.goal.consecutiveContinuations;
		delete raw.goal.lastContinuationSignature;
		await writeRawGoalFile(ref, `${JSON.stringify(raw, null, 2)}\n`);

		const persisted = await readGoal(ref);

		expect(persisted?.consecutiveContinuations ?? 0).toBe(0);
		expect(persisted?.lastContinuationSignature).toBeUndefined();
		expect(persisted).not.toHaveProperty("consecutiveContinuations");

		const delivered = await recordContinuationDelivered(ref, `${persisted?.id ?? ""}:0/1:hash-legacy`);
		expect(delivered?.consecutiveContinuations).toBe(1);
	});

	it("drops corrupt continuation fields without throwing", async () => {
		const ref = await tempStore("thread-streak-corrupt");
		await createGoal(ref, "Corrupt streak");
		const raw = JSON.parse(await readFile(goalFilePath(ref), "utf8")) as { goal: Record<string, unknown> };
		raw.goal.consecutiveContinuations = "eight";
		raw.goal.lastContinuationSignature = 42;
		await writeRawGoalFile(ref, `${JSON.stringify(raw, null, 2)}\n`);

		const persisted = await readGoal(ref);
		expect(persisted?.consecutiveContinuations).toBeUndefined();
		expect(persisted?.lastContinuationSignature).toBeUndefined();

		raw.goal.consecutiveContinuations = -3;
		await writeRawGoalFile(ref, `${JSON.stringify(raw, null, 2)}\n`);
		const reread = await readGoal(ref);
		expect(reread?.consecutiveContinuations).toBeUndefined();
		expect((await recordContinuationDelivered(ref, "sig-corrupt"))?.consecutiveContinuations).toBe(1);
	});

	it("resets the streak when the goal status changes", async () => {
		const ref = await tempStore("thread-streak-status-reset");
		const goal = await createGoal(ref, "Reset on status");
		await recordContinuationDelivered(ref, `${goal.id}:0/1:hash-d`);
		await recordContinuationDelivered(ref, `${goal.id}:0/1:hash-d`);

		const paused = await updateGoal(ref, { status: "paused" }, "user");

		expect(paused.consecutiveContinuations).toBe(0);
		expect(paused.lastContinuationSignature).toBeUndefined();
		expect(await readGoal(ref)).toMatchObject({ consecutiveContinuations: 0 });
	});

	it("resets the streak when the objective is replaced", async () => {
		const ref = await tempStore("thread-streak-objective-reset");
		const goal = await createGoal(ref, "Original objective");
		await recordContinuationDelivered(ref, `${goal.id}:0/1:hash-e`);

		const replaced = await updateGoal(ref, { objective: "Replacement objective" }, "user");

		expect(replaced.id).not.toBe(goal.id);
		expect(replaced.consecutiveContinuations).toBe(0);
		expect(replaced.lastContinuationSignature).toBeUndefined();
	});

	it("resetContinuationStreak clears count and signature without bumping updatedAt", async () => {
		const ref = await tempStore("thread-streak-reset");
		const goal = await createGoal(ref, "Reset helper");
		const delivered = await recordContinuationDelivered(ref, `${goal.id}:2/5:hash-f`);
		expect(delivered?.consecutiveContinuations).toBe(1);

		const reset = await resetContinuationStreak(ref);

		expect(reset?.consecutiveContinuations).toBe(0);
		expect(reset?.lastContinuationSignature).toBeUndefined();
		expect(reset?.updatedAt).toBe(goal.updatedAt);
		const persisted = await readGoal(ref);
		expect(persisted?.consecutiveContinuations).toBe(0);
		expect(persisted?.lastContinuationSignature).toBeUndefined();
	});

	it("returns null from streak helpers when no goal exists", async () => {
		const ref = await tempStore("thread-streak-no-goal");

		expect(await recordContinuationDelivered(ref, "sig")).toBeNull();
		expect(await resetContinuationStreak(ref)).toBeNull();
	});
});
