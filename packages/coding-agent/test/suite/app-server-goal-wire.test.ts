import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { goalFilePath, readGoal, writeGoal } from "../../src/core/extensions/builtin/goal/store.ts";
import type { Goal, GoalStoreRef } from "../../src/core/extensions/builtin/goal/types.ts";
import { toThreadGoal } from "../../src/modes/app-server/threads/goal-wire.ts";

describe("app-server goal wire adapter", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
	});

	it.each([
		["active", "active"],
		["paused", "paused"],
		["complete", "complete"],
	] as const)("maps the store status %s to the wire status %s", (status, wireStatus) => {
		// Given: a persisted goal in each status supported by the store.
		const goal = makeGoal({ status });

		// When: the store goal is adapted to the app-server wire shape.
		const wireGoal = toThreadGoal(goal);

		// Then: the status is preserved exactly, including Codex's complete spelling.
		expect(wireGoal.status).toBe(wireStatus);
		expect(wireGoal.status).not.toBe("completed");
	});

	it("always emits tokenBudget and maps an omitted store budget to null", () => {
		// Given: an old goal file shape without the additive optional budget field.
		const goal = makeGoal();

		// When: the old goal is adapted for the wire.
		const wireGoal = toThreadGoal(goal);

		// Then: the required wire member is present and uses null for the omitted budget.
		expect(wireGoal).toHaveProperty("tokenBudget", null);
	});

	it("preserves a numeric token budget without confusing it with the set/clear tri-state", () => {
		// Given: a store goal with an explicitly persisted numeric budget.
		const goal = makeGoal({ tokenBudget: 4096 });

		// When: the goal is adapted to a wire ThreadGoal.
		const wireGoal = toThreadGoal(goal);

		// Then: the number is emitted as-is; absent/null clearing remains a request-layer concern.
		expect(wireGoal.tokenBudget).toBe(4096);
	});

	it("reads old goal files that predate tokenBudget", async () => {
		// Given: a version-one goal file written without the newly optional field.
		const baseDir = await mkdtemp(join(tmpdir(), "senpi-goal-wire-"));
		tempDirs.push(baseDir);
		const ref: GoalStoreRef = { baseDir, threadId: "thread-old" };
		const oldGoal = makeGoal({ threadId: ref.threadId });
		await writeFile(goalFilePath(ref), `${JSON.stringify({ version: 1, goal: oldGoal })}\n`, "utf8");

		// When: the existing goal store reads the old file.
		const loaded = await readGoal(ref);

		// Then: the goal remains readable and the optional budget is absent rather than fabricated.
		expect(loaded).toEqual(oldGoal);
		expect(loaded).not.toHaveProperty("tokenBudget");
	});

	it("round-trips the additive budget field through the goal store", async () => {
		// Given: a goal with a numeric budget persisted through the normal store writer.
		const baseDir = await mkdtemp(join(tmpdir(), "senpi-goal-wire-"));
		tempDirs.push(baseDir);
		const ref: GoalStoreRef = { baseDir, threadId: "thread-budget" };
		const goal = makeGoal({ threadId: ref.threadId, tokenBudget: 8192 });

		// When: the goal is written and then read back.
		await writeGoal(ref, goal);
		const loaded = await readGoal(ref);

		// Then: the budget remains available to the wire adapter.
		expect(loaded?.tokenBudget).toBe(8192);
		expect(JSON.parse(await readFile(goalFilePath(ref), "utf8"))).toMatchObject({
			goal: { tokenBudget: 8192 },
		});
	});
});

function makeGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		threadId: "thread-1",
		objective: "Keep the wire contract stable",
		status: "active",
		tokensUsed: 12,
		timeUsedSeconds: 34,
		createdAt: 100,
		updatedAt: 200,
		...overrides,
	};
}
