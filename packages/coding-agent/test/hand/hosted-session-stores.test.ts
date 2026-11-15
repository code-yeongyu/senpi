// senpi#6754 (ST): a hosted loop's goal, schedule and relocation tools run on the user's machine through the session
// port. What they keep beside the session (the goal and /loop stores) travels as the loop's session documents, a
// schedule becomes a wake the loop keeps (with no key material), and a move becomes a request the loop applies. Nothing
// of the session's state stays on the user's machine.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAgentDir } from "../../src/config.ts";
import { createLoopScheduler } from "../../src/core/extensions/builtin/loop/scheduler.ts";
import { loopStateFilePath, writeLoopState } from "../../src/core/extensions/builtin/loop/store.ts";
import { hostedLoop, textOf, userMachine, userMessage } from "./hosted-session-fixture.ts";
import { cleanupHands, handDirs } from "./remote-hand-fixture.ts";

afterEach(cleanupHands);

const SESSION_TOOLS = ["read", "create_goal", "update_goal", "get_goal", "schedule_prompt", "schedule_wakeup"];

describe("a hosted loop's stores, wakes and moves stay with the loop (senpi#6754)", () => {
	it("goal tools keep the goal in the loop's session documents, across hand processes", async () => {
		const dirs = await handDirs("st-goal");
		const { loop, port } = hostedLoop({ activeTools: SESSION_TOOLS, documents: {} });

		const first = userMachine(dirs, port);
		const created = await first.call("g1", "create_goal", { objective: "ship the release" });
		await first.close();
		const second = userMachine(dirs, port);
		const current = await second.call("g2", "get_goal", {});
		const blocked = await second.call("g3", "update_goal", { status: "blocked", reason: "waiting on review" });
		await second.close();

		expect([created.isError, current.isError, blocked.isError], textOf(created)).toEqual([false, false, false]);
		expect(textOf(current)).toContain("ship the release");
		const goalFiles = Object.keys(loop.documents ?? {});
		expect(goalFiles.length).toBeGreaterThan(0);
		expect(goalFiles.every((path) => path.startsWith("extensions/goal/"))).toBe(true);
		expect(JSON.stringify(loop.documents)).toContain('\\"status\\":\\"blocked\\"');
		expect(existsSync(join(getAgentDir(), "extensions", "goal"))).toBe(false);
	}, 90_000);

	it("schedule_prompt arms, lists and cancels a wake the loop keeps, which carries no key material", async () => {
		const dirs = await handDirs("st-schedule");
		const { loop, port } = hostedLoop({ activeTools: SESSION_TOOLS });
		const machine = userMachine(dirs, port);
		const before = Date.now();

		const created = await machine.call("s1", "schedule_prompt", {
			action: "create",
			prompt: "check the deploy",
			delaySeconds: 600,
		});
		const armed = loop.wakes[0];
		const listed = await machine.call("s2", "schedule_prompt", { action: "list" });
		const cancelled = await machine.call("s3", "schedule_prompt", { action: "cancel", id: armed?.id ?? "" });
		await machine.close();

		expect([created.isError, listed.isError, cancelled.isError], textOf(created)).toEqual([false, false, false]);
		expect(armed?.source).toBe("schedule_prompt");
		expect(armed?.prompt).toBe("check the deploy");
		expect(armed?.dueAt).toBeGreaterThanOrEqual(before + 600_000);
		// The wake is the schedule and what to run, and nothing else: no key, token or grant rides with it.
		expect(Object.keys(armed ?? {}).sort()).toEqual(["createdAt", "dueAt", "id", "prompt", "source"]);
		expect(textOf(listed)).toContain(armed?.id ?? "<none>");
		expect(loop.committed[2]?.effects.wakes).toEqual([{ op: "cancel", id: armed?.id }]);
		expect(loop.wakes).toEqual([]);
		expect(existsSync(join(getAgentDir(), "schedule"))).toBe(false);
	}, 90_000);

	it("schedule_wakeup re-arms the attributed dynamic /loop as a wake, its state in the loop's documents", async () => {
		const dirs = await handDirs("st-wakeup");
		const { loop, port } = hostedLoop({ activeTools: SESSION_TOOLS });
		const scratch = mkdtempSync(join(tmpdir(), "st-loop-store-"));
		const ref = { baseDir: join(scratch, "extensions", "loop"), sessionId: loop.sessionId };
		const scheduler = createLoopScheduler({
			sessionId: loop.sessionId,
			clock: { now: () => Date.now() },
			timers: { arm: () => {}, cancel: () => {}, cancelAll: () => {} },
			ids: { loopId: () => "loop-1", wakeupId: () => "wakeup-0", deliveryId: () => "delivery-1" },
		});
		const started = scheduler.createDynamic({
			originalArgs: "check the deploy",
			reentryPrompt: "/loop check the deploy",
			payload: { type: "prompt", prompt: "check the deploy" },
		});
		await writeLoopState(ref, scheduler.getState());
		const storePath = loopStateFilePath(ref);
		loop.documents = { [relative(scratch, storePath)]: readFileSync(storePath, "utf8") };
		rmSync(scratch, { recursive: true, force: true });
		// The tick that started this turn, as the hand's /loop wrote it, then its delivered prompt.
		loop.branch.push(
			{
				type: "custom",
				id: "tick-1",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				customType: "loop-tick",
				data: { loopId: "loop-1", deliveryId: "delivery-1" },
			},
			userMessage("user-2", "check the deploy"),
		);
		const machine = userMachine(dirs, port);
		const before = Date.now();

		const scheduled = await machine.call("w1", "schedule_wakeup", {
			delaySeconds: 1200,
			reason: "nothing changed yet",
			prompt: "/loop check the deploy",
		});
		loop.branch.push(userMessage("user-3", "what is the status?"));
		const unattributed = await machine.call("w2", "schedule_wakeup", {
			delaySeconds: 1200,
			reason: "again",
			prompt: "/loop check the deploy",
		});
		await machine.close();

		expect(started.ok).toBe(true);
		expect(scheduled.isError, textOf(scheduled)).toBe(false);
		expect(loop.wakes).toEqual([
			expect.objectContaining({ id: "loop:loop-1", source: "schedule_wakeup", prompt: "/loop check the deploy" }),
		]);
		expect(loop.wakes[0]?.dueAt).toBeGreaterThanOrEqual(before + 1_200_000);
		expect(Object.values(loop.documents ?? {}).join("")).toContain("nothing changed yet");
		expect(unattributed.isError).toBe(true);
		expect(textOf(unattributed)).toContain("can only be used while a dynamic /loop is active");
	}, 90_000);

	it("relocate tools list the loop's targets and return the move for the loop to apply", async () => {
		const dirs = await handDirs("st-relocate");
		const { loop, port } = hostedLoop({
			activeTools: ["read", "list_relocation_targets", "relocate_session"],
			relocationTargets: [
				{ name: "studio", online: true, capacity: "high" },
				{ name: "laptop", online: false },
			],
		});
		const machine = userMachine(dirs, port);

		const listed = await machine.call("r1", "list_relocation_targets", {});
		const moved = await machine.call("r2", "relocate_session", { target: "studio", reason: "a heavier build" });
		await machine.close();

		expect(textOf(listed)).toContain("- studio (online, capacity: high)");
		expect(textOf(listed)).toContain("- laptop (offline)");
		expect(textOf(moved)).toContain("The session will continue on studio when this turn ends");
		expect(loop.moves).toEqual([{ target: "studio", reason: "a heavier build", moveId: expect.any(String) }]);
	}, 90_000);
});
