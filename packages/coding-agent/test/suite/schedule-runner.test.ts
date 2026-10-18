import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type Delivery,
	type DeliveryResult,
	deferWhileSessionOpen,
	POSIX_GATE,
	runDeliveryProcess,
	type ScheduledPromptEvent,
} from "../../src/cli/schedule-delivery.ts";
import {
	ABANDONED_OCCURRENCE_ERROR,
	DEFERRED_RETRY_MS,
	type RunDueOptions,
	runDueJobs,
} from "../../src/cli/schedule-runner.ts";
import {
	cancelScheduledJob,
	claimOccurrence,
	rearmRecurringJob,
	restorePending,
} from "../../src/core/extensions/builtin/schedule/occurrences.ts";
import {
	acquireSessionDeliveryLock,
	removeRunnerLease,
	writeRunnerLease,
} from "../../src/core/extensions/builtin/schedule/runner-lease.ts";
import {
	createScheduledJob,
	listScheduledJobs,
	type NewScheduledJob,
	type RunnerIdentity,
	tombstonePath,
	writeAtomic,
} from "../../src/core/extensions/builtin/schedule/store.ts";
import { MAX_FAILED_RECORDS_PER_JOB, nextRecurringDueAt } from "../../src/core/extensions/builtin/schedule/types.ts";
import { processBootAtMs } from "../../src/core/extensions/builtin/terminal/process-identity.ts";
import { holdSessionFile } from "../../src/core/session-holders.ts";

const T0 = Date.parse("2026-09-27T12:00:00Z");
const RUNNER_A: RunnerIdentity = { pid: 101, processStartedAtMs: 1_000 };
const RUNNER_B: RunnerIdentity = { pid: 202, processStartedAtMs: 2_000 };
const dirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-schedule-"));
	dirs.push(dir);
	return dir;
}

async function tempScheduleDir(): Promise<string> {
	return join(await tempDir(), "schedule");
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function jobInput(overrides: Partial<NewScheduledJob> = {}): NewScheduledJob {
	return {
		sessionId: "session-a",
		sessionFile: "/sessions/a.jsonl",
		cwd: "/work",
		prompt: "remind Howard to stretch",
		dueAt: T0 + 60_000,
		everyMs: null,
		...overrides,
	};
}

function recordingDelivery(result: DeliveryResult = { ok: true }) {
	const events: ScheduledPromptEvent[] = [];
	const deliver: Delivery = async (event) => {
		events.push(event);
		return result;
	};
	return { events, deliver };
}

/** A delivery that parks until released, and signals the moment it starts. */
function gatedDelivery() {
	let release: (result: DeliveryResult) => void = () => {};
	let markStarted: (event: ScheduledPromptEvent) => void = () => {};
	const started = new Promise<ScheduledPromptEvent>((resolve) => {
		markStarted = resolve;
	});
	const deliver: Delivery = (event) => {
		markStarted(event);
		return new Promise((resolve) => {
			release = resolve;
		});
	};
	return { deliver, started, release: (result: DeliveryResult = { ok: true }) => release(result) };
}

function pass(dir: string, overrides: Partial<RunDueOptions> & Pick<RunDueOptions, "deliver">) {
	return runDueJobs({ dir, now: () => T0 + 61_000, owner: RUNNER_A, runners: async () => [], ...overrides });
}

async function states(dir: string) {
	return (await listScheduledJobs(dir)).jobs.map(({ state, job, occurrence }) => ({
		state,
		id: job.id,
		occurrence,
		dueAt: job.dueAt,
	}));
}

describe("schedule runner", () => {
	it("fires a due one-shot job once, with its session and prompt, then forgets it", async () => {
		const dir = await tempScheduleDir();
		const job = await createScheduledJob(dir, jobInput(), T0);
		const { events, deliver } = recordingDelivery();

		const first = await pass(dir, { deliver });
		const second = await pass(dir, { deliver, now: () => T0 + 62_000 });

		expect(first.events).toEqual([
			expect.objectContaining({ event: "fired", id: job.id, occurrence: 1, outcome: "delivered" }),
		]);
		expect(second.events).toEqual([]);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "scheduled_prompt",
			id: job.id,
			sessionId: "session-a",
			sessionFile: "/sessions/a.jsonl",
			cwd: "/work",
			prompt: "remind Howard to stretch",
			fireCount: 1,
			firedAt: T0 + 61_000,
		});
		expect(events[0]?.message.endsWith("\nremind Howard to stretch")).toBe(true);
		expect(await states(dir)).toEqual([]);
	});

	it("leaves a job that is not due yet untouched and reports when it is due", async () => {
		const dir = await tempScheduleDir();
		const job = await createScheduledJob(dir, jobInput({ dueAt: T0 + 300_000 }), T0);
		const { events, deliver } = recordingDelivery();

		const result = await pass(dir, { deliver, now: () => T0 + 299_999 });

		expect(events).toEqual([]);
		expect(result.nextDueAt).toBe(T0 + 300_000);
		expect(await states(dir)).toEqual([{ state: "pending", id: job.id, occurrence: undefined, dueAt: T0 + 300_000 }]);
	});

	it("keeps a failed occurrence in failed/ with the delivery error", async () => {
		const dir = await tempScheduleDir();
		const job = await createScheduledJob(dir, jobInput(), T0);
		const { deliver } = recordingDelivery({ ok: false, error: "exit code 3: inbox missing" });

		const result = await pass(dir, { deliver });

		expect(result.events[0]).toMatchObject({ id: job.id, outcome: "failed", error: "exit code 3: inbox missing" });
		const { jobs } = await listScheduledJobs(dir);
		expect(jobs.map(({ state, occurrence, job }) => ({ state, occurrence, lastError: job.lastError }))).toEqual([
			{ state: "failed", occurrence: 1, lastError: "exit code 3: inbox missing" },
		]);
	});

	it("re-arms a recurring job before delivering it, collapsing missed occurrences", async () => {
		const dir = await tempScheduleDir();
		const job = await createScheduledJob(dir, jobInput({ dueAt: T0, everyMs: 3_600_000 }), T0);
		let pendingDuringDelivery: unknown;
		const deliver: Delivery = async () => {
			pendingDuringDelivery = await states(dir);
			return { ok: true };
		};

		// The runner was down for 2.5 periods: one catch-up delivery, next slot is T0 + 3h.
		const result = await pass(dir, { deliver, now: () => T0 + 9_000_000 });

		expect(pendingDuringDelivery).toEqual(
			expect.arrayContaining([{ state: "pending", id: job.id, occurrence: undefined, dueAt: T0 + 10_800_000 }]),
		);
		expect(result.events).toEqual([
			expect.objectContaining({ id: job.id, outcome: "delivered", nextDueAt: T0 + 10_800_000 }),
		]);
		expect(result.nextDueAt).toBe(T0 + 10_800_000);
		const { jobs } = await listScheduledJobs(dir);
		expect(jobs).toEqual([
			expect.objectContaining({
				state: "pending",
				job: { ...job, dueAt: T0 + 10_800_000, fireCount: 1, lastFiredAt: T0 + 9_000_000 },
			}),
		]);
	});

	it("computes the next recurring slot strictly after now", () => {
		expect(nextRecurringDueAt(T0, 60_000, T0)).toBe(T0 + 60_000);
		expect(nextRecurringDueAt(T0, 60_000, T0 - 1)).toBe(T0);
		expect(nextRecurringDueAt(T0, 60_000, T0 + 59_999)).toBe(T0 + 60_000);
	});

	it("reports malformed and oversized job files and never fires or deletes them", async () => {
		const dir = await tempScheduleDir();
		await mkdir(join(dir, "pending"), { recursive: true });
		await writeFile(join(dir, "pending", "sch_000000000001.json"), "{not json", "utf8");
		await writeFile(join(dir, "pending", "sch_000000000002.json"), " ".repeat(70_000), "utf8");
		const { events, deliver } = recordingDelivery();

		const result = await pass(dir, { deliver });

		expect(events).toEqual([]);
		expect(result.events.map((event) => event.event)).toEqual(["invalid", "invalid"]);
		expect((await readdir(join(dir, "pending"))).sort()).toEqual(["sch_000000000001.json", "sch_000000000002.json"]);
	});

	it("delivers a due job exactly once when two runners race for it", async () => {
		const dir = await tempScheduleDir();
		await createScheduledJob(dir, jobInput(), T0);
		const { events, deliver } = recordingDelivery();

		const results = await Promise.all([pass(dir, { deliver }), pass(dir, { deliver, owner: RUNNER_B })]);

		expect(events).toHaveLength(1);
		expect(results.flatMap((result) => result.events).filter((event) => event.event === "fired")).toHaveLength(1);
	});

	it("never resurrects a recurring job cancelled while its occurrence is being delivered", async () => {
		const dir = await tempScheduleDir();
		const job = await createScheduledJob(dir, jobInput({ dueAt: T0, everyMs: 60_000 }), T0);
		const gate = gatedDelivery();

		const running = pass(dir, { deliver: gate.deliver });
		await gate.started;
		const cancelled = await cancelScheduledJob(dir, job.id, { sessionId: "session-a" });
		gate.release();
		const result = await running;
		const later = recordingDelivery();
		await pass(dir, { deliver: later.deliver, now: () => T0 + 10 * 60_000 });

		expect(cancelled).toMatchObject({ inFlight: true });
		expect(result.events).toEqual([expect.objectContaining({ id: job.id, outcome: "delivered" })]);
		expect(result.events[0]).not.toHaveProperty("nextDueAt");
		expect(later.events).toEqual([]);
		expect(await states(dir)).toEqual([]);
	});

	it("loses a re-arm that races a cancel landing between claim and re-arm", async () => {
		const dir = await tempScheduleDir();
		const job = await createScheduledJob(dir, jobInput({ dueAt: T0, everyMs: 60_000 }), T0);
		const record = await claimOccurrence(dir, job, RUNNER_A);

		const cancelled = await cancelScheduledJob(dir, job.id);
		await rearmRecurringJob(dir, { ...job, fireCount: 1, lastFiredAt: T0, dueAt: T0 + 60_000 });

		expect(record).toBeDefined();
		expect(cancelled).toMatchObject({ inFlight: true });
		expect((await states(dir)).filter(({ state }) => state === "pending")).toEqual([]);
	});

	it("never lets two runner processes deliver into the same session at once", async () => {
		const dir = await tempScheduleDir();
		const first = await createScheduledJob(dir, jobInput({ dueAt: T0 }), T0);
		const second = await createScheduledJob(dir, jobInput({ dueAt: T0 + 1 }), T0);
		const gate = gatedDelivery();
		const deliveredByA: string[] = [];
		const deliverA: Delivery = (event) => {
			deliveredByA.push(event.id);
			return deliveredByA.length === 1 ? gate.deliver(event) : Promise.resolve({ ok: true });
		};

		const runnerA = pass(dir, { deliver: deliverA });
		await gate.started;
		const other = recordingDelivery();
		const leaseA = { ...RUNNER_A, beatAt: T0, watch: true, exec: null };
		const runnerB = await pass(dir, { deliver: other.deliver, owner: RUNNER_B, runners: async () => [leaseA] });
		gate.release();
		await runnerA;

		expect(runnerB.events).toEqual([expect.objectContaining({ event: "deferred", id: second.id })]);
		expect(other.events).toEqual([]);
		expect(deliveredByA).toEqual([first.id, second.id]);
		expect(await states(dir)).toEqual([]);
	});

	it("puts a mistakenly claimed generation back only if no cancel landed and nothing newer is pending", async () => {
		const dir = await tempScheduleDir();
		const job = await createScheduledJob(dir, jobInput({ dueAt: T0, everyMs: 60_000 }), T0);
		const pending = join(dir, "pending", `${job.id}.json`);
		const staged = async (name: string, fireCount: number) => {
			const record = join("firing", `${job.id}@9~${name}.json`);
			await writeAtomic(join(dir, record), JSON.stringify({ ...job, fireCount }));
			return record;
		};

		// A newer generation is pending: the stale one is dropped, the pending file is untouched.
		await restorePending(dir, await staged("1-1", 5), job.id);
		expect(JSON.parse(await readFile(pending, "utf8")).fireCount).toBe(0);

		// A cancel landed between the claim's checks and the put-back: nothing comes back.
		await rm(pending);
		await writeAtomic(tombstonePath(dir, job.id), "cancelled\n");
		await restorePending(dir, await staged("2-2", 1), job.id);
		expect(await states(dir)).toEqual([]);
	});

	it("records nothing for an in-flight occurrence that fails after its job was cancelled", async () => {
		const dir = await tempScheduleDir();
		const job = await createScheduledJob(dir, jobInput(), T0);
		const gate = gatedDelivery();

		const running = pass(dir, { deliver: gate.deliver });
		await gate.started;
		expect(await cancelScheduledJob(dir, job.id)).toMatchObject({ inFlight: true });
		gate.release({ ok: false, error: "failed after cancel" });
		await running;

		expect(await states(dir)).toEqual([]);
	});

	it("does not deliver a job cancelled before the runner claims it", async () => {
		const dir = await tempScheduleDir();
		const job = await createScheduledJob(dir, jobInput(), T0);
		const { events, deliver } = recordingDelivery();

		expect(await cancelScheduledJob(dir, job.id)).toMatchObject({ inFlight: false });
		await pass(dir, { deliver });

		expect(events).toEqual([]);
	});

	it("keeps a recurring schedule alive when its runner dies mid-delivery, and records the lost occurrence", async () => {
		const dir = await tempScheduleDir();
		const job = await createScheduledJob(dir, jobInput({ dueAt: T0, everyMs: 60_000 }), T0);
		// Runner A claims occurrence 1 and re-arms, then dies before settling.
		const record = await claimOccurrence(dir, job, RUNNER_A);
		expect(record).toBeDefined();
		await rearmRecurringJob(dir, { ...job, fireCount: 1, lastFiredAt: T0, dueAt: T0 + 60_000 });
		const { events, deliver } = recordingDelivery();

		// Runner B, with no live runner A, recovers the occurrence and keeps the schedule going.
		const result = await pass(dir, { deliver, owner: RUNNER_B, now: () => T0 + 61_000 });

		expect(result.events).toEqual([
			expect.objectContaining({ event: "abandoned", id: job.id, occurrence: 1, error: ABANDONED_OCCURRENCE_ERROR }),
			expect.objectContaining({ event: "fired", id: job.id, occurrence: 2, outcome: "delivered" }),
		]);
		expect(events.map((event) => event.fireCount)).toEqual([2]);
		expect(await states(dir)).toEqual([
			{ state: "failed", id: job.id, occurrence: 1, dueAt: T0 },
			{ state: "pending", id: job.id, occurrence: undefined, dueAt: T0 + 120_000 },
		]);
	});

	it("restores a recurring schedule whose runner died between the claim and the re-arm", async () => {
		const dir = await tempScheduleDir();
		const job = await createScheduledJob(dir, jobInput({ dueAt: T0, everyMs: 60_000 }), T0);
		// Runner A claims occurrence 1 and dies before it can re-arm the job.
		expect(await claimOccurrence(dir, job, RUNNER_A)).toBeDefined();
		const { events, deliver } = recordingDelivery();

		const result = await pass(dir, { deliver, owner: RUNNER_B, now: () => T0 + 61_000 });

		expect(result.events).toEqual([
			expect.objectContaining({ event: "abandoned", id: job.id, occurrence: 1, error: ABANDONED_OCCURRENCE_ERROR }),
		]);
		expect(events).toEqual([]);
		expect(result.nextDueAt).toBe(T0 + 120_000);
		expect(await states(dir)).toEqual([
			{ state: "failed", id: job.id, occurrence: 1, dueAt: T0 },
			{ state: "pending", id: job.id, occurrence: undefined, dueAt: T0 + 120_000 },
		]);
		const restored = (await listScheduledJobs(dir)).jobs.find((record) => record.state === "pending");
		expect(restored?.job.fireCount).toBe(1);
	});

	it("reports an error in one session and still delivers the others", async () => {
		const dir = await tempScheduleDir();
		const broken = await createScheduledJob(dir, jobInput({ sessionId: "session-a", dueAt: T0 }), T0);
		const later = await createScheduledJob(dir, jobInput({ sessionId: "session-a", dueAt: T0 + 1 }), T0);
		const healthy = await createScheduledJob(dir, jobInput({ sessionId: "session-b", dueAt: T0 }), T0);
		const { events, deliver } = recordingDelivery();

		const result = await pass(dir, {
			deliver,
			shouldDefer: async (job) => {
				if (job.sessionId === "session-a") throw new Error("EACCES: permission denied");
				return undefined;
			},
		});

		expect(result.events).toEqual(
			expect.arrayContaining([
				{ event: "error", id: broken.id, sessionId: "session-a", error: "EACCES: permission denied" },
				expect.objectContaining({ event: "fired", id: healthy.id, outcome: "delivered" }),
			]),
		);
		expect(result.events).toHaveLength(2);
		expect(events.map((event) => event.id)).toEqual([healthy.id]);
		expect(result.nextDueAt).toBe(T0 + 61_000 + DEFERRED_RETRY_MS);
		expect((await states(dir)).filter((record) => record.state === "pending").map((record) => record.id)).toEqual([
			broken.id,
			later.id,
		]);
	});

	it("keeps only the most recent failed records of a recurring job that keeps failing", async () => {
		const dir = await tempScheduleDir();
		const job = await createScheduledJob(dir, jobInput({ dueAt: T0, everyMs: 60_000 }), T0);
		const { deliver } = recordingDelivery({ ok: false, error: "inbox unavailable" });

		for (let slot = 0; slot < MAX_FAILED_RECORDS_PER_JOB + 2; slot += 1) {
			await pass(dir, { deliver, now: () => T0 + slot * 60_000 + 1 });
		}

		const failed = (await states(dir)).filter((record) => record.state === "failed");
		expect(failed.map((record) => record.occurrence).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
			Array.from({ length: MAX_FAILED_RECORDS_PER_JOB }, (_, index) => index + 3),
		);
		expect((await states(dir)).filter((record) => record.state === "pending").map((record) => record.id)).toEqual([
			job.id,
		]);
	});

	it("does not restore an abandoned recurring job that was cancelled", async () => {
		const dir = await tempScheduleDir();
		const job = await createScheduledJob(dir, jobInput({ dueAt: T0, everyMs: 60_000 }), T0);
		expect(await claimOccurrence(dir, job, RUNNER_A)).toBeDefined();
		await cancelScheduledJob(dir, job.id);

		await pass(dir, { deliver: recordingDelivery().deliver, owner: RUNNER_B, now: () => T0 + 61_000 });

		expect(await states(dir)).toEqual([]);
	});

	it("leaves an occurrence alone while the runner that claimed it is alive", async () => {
		const dir = await tempScheduleDir();
		const job = await createScheduledJob(dir, jobInput(), T0);
		await claimOccurrence(dir, job, RUNNER_A);
		const runnerA = { ...RUNNER_A, beatAt: T0, watch: true, exec: null };

		const result = await pass(dir, {
			deliver: recordingDelivery().deliver,
			owner: RUNNER_B,
			runners: async () => [runnerA],
		});

		expect(result.events).toEqual([]);
		expect((await states(dir)).map(({ state }) => state)).toEqual(["firing"]);
	});

	it("defers a job whose session is busy and holds that session's later jobs behind it", async () => {
		const dir = await tempScheduleDir();
		const first = await createScheduledJob(dir, jobInput({ dueAt: T0 }), T0);
		await createScheduledJob(dir, jobInput({ dueAt: T0 + 1 }), T0);
		const other = await createScheduledJob(dir, jobInput({ sessionId: "session-b", dueAt: T0 }), T0);
		const { events, deliver } = recordingDelivery();

		const result = await pass(dir, {
			deliver,
			shouldDefer: async (job) => (job.sessionId === "session-a" ? "session is open" : undefined),
		});

		expect(events.map((event) => event.id)).toEqual([other.id]);
		expect(result.events).toContainEqual({
			event: "deferred",
			id: first.id,
			sessionId: "session-a",
			reason: "session is open",
		});
		expect((await states(dir)).filter(({ state }) => state === "pending")).toHaveLength(2);
		expect(result.nextDueAt).toBe(T0 + 61_000 + DEFERRED_RETRY_MS);
	});

	it("does not let a stuck delivery for one session hold back another session", async () => {
		const dir = await tempScheduleDir();
		const stuck = await createScheduledJob(dir, jobInput({ sessionId: "slow", dueAt: T0 }), T0);
		const quick = await createScheduledJob(dir, jobInput({ sessionId: "fast", dueAt: T0 + 1 }), T0);
		const gate = gatedDelivery();
		let quickDelivered: () => void = () => {};
		const quickDone = new Promise<void>((resolve) => {
			quickDelivered = resolve;
		});
		const deliver: Delivery = (event) => {
			if (event.id === stuck.id) return gate.deliver(event);
			quickDelivered();
			return Promise.resolve({ ok: true });
		};

		const running = pass(dir, { deliver, concurrency: 2 });
		await Promise.all([gate.started, quickDone]);
		gate.release();
		const result = await running;

		expect(result.events.map((event) => (event.event === "fired" ? event.id : event.event)).sort()).toEqual(
			[stuck.id, quick.id].sort(),
		);
	});

	it.skipIf(process.platform === "win32")(
		"keeps a dead runner's session lock while the delivery it started is still running",
		async () => {
			const dir = await tempScheduleDir();
			const exited = (child: ReturnType<typeof spawn>) =>
				new Promise<void>((resolve) => child.once("exit", () => resolve()));
			const gone = spawn("/usr/bin/true");
			await exited(gone);
			const delivery = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
			const deliveryExited = exited(delivery);
			const lockFile = join(dir, "sessions", `${encodeURIComponent("session-a")}.lock`);
			await writeAtomic(
				lockFile,
				JSON.stringify({
					pid: gone.pid,
					bootAtMs: processBootAtMs(),
					processStartedAtMs: 1,
					deliveryPid: delivery.pid,
					deliveryStartedAtMs: Math.floor(Date.now() / 1000) * 1000,
				}),
			);

			const whileRunning = await acquireSessionDeliveryLock(dir, "session-a");
			process.kill(-(delivery.pid ?? 0), "SIGKILL");
			await deliveryExited;
			const afterExit = await acquireSessionDeliveryLock(dir, "session-a");

			expect(whileRunning).toEqual({ acquired: false, heldByPid: delivery.pid });
			expect(afterExit.acquired).toBe(true);
			if (afterExit.acquired) await afterExit.release();
		},
	);

	it.skipIf(process.platform === "win32")(
		"reports a timed-out delivery only after its process has exited, and names it on spawn",
		async () => {
			const spawned: number[] = [];

			const result = await runDeliveryProcess({ command: "/bin/sh", args: ["-c", "sleep 60 & wait"] }, 200, {
				onSpawn: async (pid) => {
					spawned.push(pid);
				},
			});

			expect(result).toEqual({ ok: false, error: "delivery timed out after 0s" });
			expect(spawned).toHaveLength(1);
			expect(() => process.kill(spawned[0] ?? 0, 0)).toThrow();
		},
	);

	it.skipIf(process.platform === "win32")("does not treat a reused pid as the dead runner's delivery", async () => {
		const dir = await tempScheduleDir();
		const gone = spawn("/usr/bin/true");
		await new Promise<void>((resolve) => gone.once("exit", () => resolve()));
		// A live group leader whose start time is not the recorded one: a reused pid.
		const unrelated = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
		const unrelatedExited = new Promise<void>((resolve) => unrelated.once("exit", () => resolve()));
		const lockFile = join(dir, "sessions", `${encodeURIComponent("session-a")}.lock`);
		await writeAtomic(
			lockFile,
			JSON.stringify({
				pid: gone.pid,
				bootAtMs: processBootAtMs(),
				processStartedAtMs: 1,
				deliveryPid: unrelated.pid,
				deliveryStartedAtMs: 1,
			}),
		);

		const lock = await acquireSessionDeliveryLock(dir, "session-a");
		process.kill(-(unrelated.pid ?? 0), "SIGKILL");
		await unrelatedExited;

		expect(lock.acquired).toBe(true);
		if (lock.acquired) await lock.release();
	});

	it.skipIf(process.platform === "win32")(
		"does not trust a live delivery leader whose start time cannot be read",
		async () => {
			const dir = await tempScheduleDir();
			const gone = spawn("/usr/bin/true");
			await new Promise<void>((resolve) => gone.once("exit", () => resolve()));
			const leader = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
			const leaderExited = new Promise<void>((resolve) => leader.once("exit", () => resolve()));
			const lockFile = join(dir, "sessions", `${encodeURIComponent("session-a")}.lock`);
			await writeAtomic(
				lockFile,
				JSON.stringify({
					pid: gone.pid,
					bootAtMs: processBootAtMs(),
					processStartedAtMs: 1,
					deliveryPid: leader.pid,
					deliveryStartedAtMs: Math.floor(Date.now() / 1000) * 1000,
				}),
			);

			const lock = await acquireSessionDeliveryLock(dir, "session-a", { readProcessStartMs: async () => undefined });
			process.kill(-(leader.pid ?? 0), "SIGKILL");
			await leaderExited;

			expect(lock.acquired).toBe(true);
			if (lock.acquired) await lock.release();
		},
	);

	it("holds a dead runner's ungated lock until its delivery time limit has passed", async () => {
		const dir = await tempScheduleDir();
		const gone = spawn(process.execPath, ["-e", ""]);
		await new Promise<void>((resolve) => gone.once("exit", () => resolve()));
		const lockFile = join(dir, "sessions", `${encodeURIComponent("session-a")}.lock`);
		const deadRunner = { pid: gone.pid, bootAtMs: processBootAtMs(), processStartedAtMs: 1, gated: false };
		await writeAtomic(lockFile, JSON.stringify({ ...deadRunner, maxDeliveryMs: 3_600_000 }));
		const withinLimit = await acquireSessionDeliveryLock(dir, "session-a");
		await writeAtomic(lockFile, JSON.stringify({ ...deadRunner, maxDeliveryMs: 0 }));
		await utimes(lockFile, new Date(T0), new Date(T0));
		const pastLimit = await acquireSessionDeliveryLock(dir, "session-a");

		expect(withinLimit).toEqual({ acquired: false, heldByPid: gone.pid });
		expect(pastLimit.acquired).toBe(true);
		if (pastLimit.acquired) await pastLimit.release();
	});

	it("serializes a pending attach with release so the lock is never left behind", async () => {
		const dir = await tempScheduleDir();
		const lockFile = join(dir, "sessions", `${encodeURIComponent("session-a")}.lock`);
		const lock = await acquireSessionDeliveryLock(dir, "session-a");
		if (!lock.acquired) throw new Error("expected the lock");

		const attaching = lock.attachDelivery(process.pid);
		await lock.release();
		await attaching;

		expect(existsSync(lockFile)).toBe(false);
	});

	it.skipIf(process.platform === "win32")(
		"leaves no session lock behind after fast deliveries, attaching each before release",
		async () => {
			const dir = await tempScheduleDir();
			for (let index = 0; index < 20; index += 1) {
				await createScheduledJob(dir, jobInput({ dueAt: T0 }), T0);
			}
			const lockFile = join(dir, "sessions", `${encodeURIComponent("session-a")}.lock`);
			const lockSeen: string[] = [];
			const deliver: Delivery = (_event, context) =>
				runDeliveryProcess({ command: "/usr/bin/true", args: [] }, 30_000, {
					onSpawn: async (pid) => {
						await context?.onSpawn?.(pid);
						lockSeen.push(
							JSON.parse(await readFile(lockFile, "utf8")).deliveryPid === pid ? "attached" : "missing",
						);
					},
				});

			const result = await runDueJobs({
				dir,
				now: () => T0 + 1,
				owner: { pid: process.pid, processStartedAtMs: 0 },
				deliver,
				runners: async () => [],
			});

			expect(result.events.filter((event) => event.event === "fired" && event.outcome === "delivered")).toHaveLength(
				20,
			);
			expect(lockSeen).toEqual(Array.from({ length: 20 }, () => "attached"));
			expect(existsSync(lockFile)).toBe(false);
		},
	);

	it.skipIf(process.platform === "win32")("never starts a delivery whose registration failed", async () => {
		const root = await tempDir();
		const marker = join(root, "ran");

		// The gate is never released (proven to hold by the gate test below), so the command cannot run.
		const result = await runDeliveryProcess({ command: "/bin/sh", args: ["-c", `touch '${marker}'`] }, 30_000, {
			onSpawn: async () => {
				throw new Error("lock lost");
			},
		});

		expect(result).toEqual({ ok: false, error: "could not register the delivery: lock lost" });
		expect(existsSync(marker)).toBe(false);
	});

	it.skipIf(process.platform === "win32")(
		"the POSIX gate runs the command only after the release line, and nothing when closed without it",
		async () => {
			const root = await tempDir();
			const gated = (marker: string, release: boolean) =>
				new Promise<number | null>((resolve, reject) => {
					const child = spawn("/bin/sh", ["-c", POSIX_GATE, "/bin/sh", "-c", `touch '${marker}'`], {
						stdio: ["ignore", "ignore", "ignore", "pipe"],
					});
					child.once("error", reject);
					child.once("exit", (code) => resolve(code));
					const gate = child.stdio[3];
					if (gate === null || gate === undefined || !("end" in gate)) throw new Error("no gate pipe");
					if (release) gate.end("go\n");
					else gate.end();
				});

			const closed = await gated(join(root, "closed"), false);
			const released = await gated(join(root, "released"), true);

			expect(closed).toBe(75);
			expect(existsSync(join(root, "closed"))).toBe(false);
			expect(released).toBe(0);
			expect(existsSync(join(root, "released"))).toBe(true);
		},
	);

	it("cancels only the owning session's job when a session id is given", async () => {
		const dir = await tempScheduleDir();
		const job = await createScheduledJob(dir, jobInput(), T0);

		expect(await cancelScheduledJob(dir, job.id, { sessionId: "session-b" })).toBeUndefined();
		expect(await states(dir)).toHaveLength(1);
		expect(await cancelScheduledJob(dir, job.id, { sessionId: "session-a" })).toMatchObject({ job, inFlight: false });
		expect(await states(dir)).toEqual([]);
	});

	it("defers default delivery while another process holds the session file", async () => {
		const root = await tempDir();
		const sessionFile = join(root, "sessions", "s.jsonl");
		await mkdir(join(root, "sessions"), { recursive: true });
		await writeFile(sessionFile, "", "utf8");
		const job = await createScheduledJob(join(root, "schedule"), jobInput({ sessionId: "s", sessionFile }), T0);

		const hold = holdSessionFile(sessionFile, "s", { expectExisting: true });
		const whileOpen = await deferWhileSessionOpen(job);
		hold.release();
		const afterClose = await deferWhileSessionOpen(job);

		expect(whileOpen).toBeDefined();
		expect(afterClose).toBeUndefined();
	});

	it.skipIf(process.platform === "win32")("writes versioned job files readable only by the owner", async () => {
		const dir = await tempScheduleDir();
		const job = await createScheduledJob(dir, jobInput(), T0);
		const path = join(dir, "pending", `${job.id}.json`);
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1, id: job.id });
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect((await stat(join(dir, "pending"))).mode & 0o777).toBe(0o700);

		// The runner lease records the --exec command; the session lock is owner-only too.
		await writeRunnerLease(dir, { startedAt: T0, watch: true, exec: "deliver --token x" }, T0);
		const lock = await acquireSessionDeliveryLock(dir, "session-a");
		if (!lock.acquired) throw new Error("expected the lock");
		await lock.attachDelivery(process.pid);
		try {
			expect((await stat(join(dir, "runners", `${process.pid}.json`))).mode & 0o777).toBe(0o600);
			expect((await stat(join(dir, "sessions", "session-a.lock"))).mode & 0o777).toBe(0o600);
		} finally {
			await lock.release();
			await removeRunnerLease(dir);
		}
	});
});
