// senpi#3566 todo 6: job deadlines, the cancel ladder and control liveness against one tool child, under a fake clock.
import { describe, expect, it } from "vitest";
import { JobSupervisor, type SupervisedChild, type SupervisorTimers } from "./job-supervisor.ts";

function fakeClock() {
	let now = 0;
	let queue: Array<{ at: number; fn: () => void; live: boolean }> = [];
	const timers: SupervisorTimers = {
		set: (fn, ms) => {
			const entry = { at: now + ms, fn, live: true };
			queue.push(entry);
			return () => {
				entry.live = false;
			};
		},
	};
	const advance = (ms: number) => {
		const until = now + ms;
		for (;;) {
			const next = queue.filter((entry) => entry.live && entry.at <= until).sort((a, b) => a.at - b.at)[0];
			if (next === undefined) break;
			now = next.at;
			next.live = false;
			next.fn();
		}
		now = until;
		queue = queue.filter((entry) => entry.live);
	};
	return { timers, advance, now: () => now };
}

function recordingChild(clock: { now: () => number }) {
	const events: string[] = [];
	const child: SupervisedChild = {
		sendCancel: (jobId) => events.push(`${clock.now()}:cancel:${jobId}`),
		sendPing: (seq) => events.push(`${clock.now()}:ping:${seq}`),
		signal: (signal) => events.push(`${clock.now()}:${signal}`),
	};
	return { child, events };
}

function rig() {
	const clock = fakeClock();
	const { child, events } = recordingChild(clock);
	const supervisor = new JobSupervisor(child, clock.timers);
	const rejected: Array<{ jobId: string; code: unknown }> = [];
	const track = (jobId: string, extra: { backstopMs?: number; signal?: AbortSignal } = {}) =>
		supervisor.track(jobId, {
			reject: (error) => rejected.push({ jobId, code: Reflect.get(error, "code") }),
			backstopMs: extra.backstopMs,
			userText: "The search took too long and was stopped.",
			...(extra.signal === undefined ? {} : { signal: extra.signal }),
		});
	return { clock, events, supervisor, rejected, track };
}

describe("JobSupervisor", () => {
	it("climbs the cancel ladder when a cancelled job does not settle: TERM at 5 s, KILL at 7 s", () => {
		const { clock, events, track, supervisor } = rig();
		const abort = new AbortController();
		track("j1", { signal: abort.signal });
		abort.abort();
		clock.advance(7_000);
		expect(events.filter((event) => !event.includes(":ping:"))).toEqual([
			"0:cancel:j1",
			"5000:SIGTERM",
			"7000:SIGKILL",
		]);
		supervisor.end();
	});

	it("stops the ladder when the child acknowledges the cancel; the job's backstop still applies", () => {
		const { clock, events, track, supervisor, rejected } = rig();
		const abort = new AbortController();
		track("j1", { signal: abort.signal, backstopMs: 30_000 });
		abort.abort();
		supervisor.cancelAcked("j1");
		for (let elapsed = 0; elapsed < 30_000; elapsed += 5_000) {
			clock.advance(5_000);
			supervisor.pongReceived();
		}
		expect(events.filter((event) => event.includes("SIG"))).toEqual([]);
		expect(rejected).toEqual([{ jobId: "j1", code: "tool_child_deadline" }]);
		supervisor.end();
	});

	it("stops the ladder when the job settles after the cancel", () => {
		const { clock, events, track, supervisor } = rig();
		const abort = new AbortController();
		track("j1", { signal: abort.signal });
		abort.abort();
		clock.advance(4_000);
		supervisor.settle("j1");
		clock.advance(10_000);
		expect(events).toEqual(["0:cancel:j1"]);
	});

	it("rejects a job at its backstop with the kind's user text, then cancels it", () => {
		const { clock, events, rejected, track, supervisor } = rig();
		track("j1", { backstopMs: 120_000 });
		for (let elapsed = 0; elapsed < 120_000; elapsed += 5_000) {
			clock.advance(5_000);
			supervisor.pongReceived();
		}
		expect(rejected).toEqual([{ jobId: "j1", code: "tool_child_deadline" }]);
		expect(events.filter((event) => event.includes("cancel"))).toEqual(["120000:cancel:j1"]);
		supervisor.end();
	});

	it("pings every 5 s while a job is pending and ends the child after three missed pongs", () => {
		const { clock, events, rejected, track } = rig();
		track("j1");
		track("j2");
		clock.advance(20_000);
		expect(events).toEqual(["5000:ping:1", "10000:ping:2", "15000:ping:3", "20000:SIGKILL"]);
		expect(rejected).toEqual([
			{ jobId: "j1", code: "tool_child_unresponsive" },
			{ jobId: "j2", code: "tool_child_unresponsive" },
		]);
	});

	it("keeps a child that answers, and never pings while nothing is pending", () => {
		const { clock, events, track, supervisor } = rig();
		clock.advance(30_000);
		expect(events).toEqual([]);
		track("j1");
		for (let round = 0; round < 10; round++) {
			clock.advance(5_000);
			supervisor.pongReceived();
		}
		expect(events.some((event) => event.includes("SIGKILL"))).toBe(false);
		supervisor.settle("j1");
		const pingsBefore = events.length;
		clock.advance(30_000);
		expect(events.length).toBe(pingsBefore);
	});
});
