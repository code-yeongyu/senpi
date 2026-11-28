// senpi#7556: a stdio RPC engine that stays silent during startup must say where it is. A launch that wrote 0 bytes
// before its client gave up left no way to name the blocking step; this notice turns that into a named phase on stderr.
import { describe, expect, it } from "vitest";
import {
	armStartupStallNotice,
	isStdioRpcLaunch,
	type StartupStallClock,
} from "../../../src/core/startup-stall-notice.ts";
import { lastTimedPhase, type TimedPhase, time } from "../../../src/core/timings.ts";

class ManualClock implements StartupStallClock {
	private current = 0;
	private readonly pending = new Map<number, { readonly at: number; readonly run: () => void }>();
	private nextId = 0;

	now(): number {
		return this.current;
	}

	schedule(callback: () => void, delayMs: number): () => void {
		const id = this.nextId++;
		this.pending.set(id, { at: this.current + delayMs, run: callback });
		return () => this.pending.delete(id);
	}

	advance(ms: number): void {
		const target = this.current + ms;
		for (;;) {
			const due = [...this.pending.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort(([, a], [, b]) => a.at - b.at)[0];
			if (due === undefined) break;
			const [id, timer] = due;
			this.pending.delete(id);
			this.current = timer.at;
			timer.run();
		}
		this.current = target;
	}
}

function arm(clock: ManualClock, phase: () => TimedPhase | undefined) {
	const lines: string[] = [];
	const notice = armStartupStallNotice({
		deadlineMs: 10_000,
		label: "senpi rpc",
		lastPhase: phase,
		write: (line) => lines.push(line),
		clock,
	});
	return { lines, notice };
}

describe("rpc startup stall notice (senpi#7556)", () => {
	it("names the last completed phase when startup has not finished by the deadline", () => {
		const clock = new ManualClock();
		const { lines } = arm(clock, () => ({ label: "createSessionManager", atMs: 1_500 }));

		clock.advance(9_999);
		expect(lines).toEqual([]);
		clock.advance(1);
		expect(lines).toEqual([
			"senpi rpc: startup has not finished after 10s; last completed phase: createSessionManager (8.5s ago)\n",
		]);
	});

	it("repeats every interval with the phase reached by then", () => {
		const clock = new ManualClock();
		let phase: TimedPhase = { label: "runMigrations", atMs: 500 };
		const { lines } = arm(clock, () => phase);

		clock.advance(10_000);
		phase = { label: "createRuntime", atMs: 12_000 };
		clock.advance(10_000);
		expect(lines).toEqual([
			"senpi rpc: startup has not finished after 10s; last completed phase: runMigrations (9.5s ago)\n",
			"senpi rpc: startup has not finished after 20s; last completed phase: createRuntime (8.0s ago)\n",
		]);
	});

	it("says no phase completed when the stall precedes the first mark", () => {
		const clock = new ManualClock();
		const { lines } = arm(clock, () => undefined);

		clock.advance(10_000);
		expect(lines).toEqual(["senpi rpc: startup has not finished after 10s; no startup phase has completed yet\n"]);
	});

	it("writes nothing once startup is ready, before or after a notice", () => {
		const early = new ManualClock();
		const quiet = arm(early, () => ({ label: "parseArgs", atMs: 10 }));
		early.advance(3_000);
		quiet.notice.ready();
		early.advance(60_000);
		expect(quiet.lines).toEqual([]);

		const late = new ManualClock();
		const once = arm(late, () => ({ label: "parseArgs", atMs: 10 }));
		late.advance(10_000);
		once.notice.ready();
		late.advance(60_000);
		expect(once.lines).toHaveLength(1);
	});

	it("records the last timed phase even when PI_TIMING is off", () => {
		expect(process.env.PI_TIMING).not.toBe("1");
		time("phase-a");
		time("phase-b");
		expect(lastTimedPhase()?.label).toBe("phase-b");
		time("load", "extensions");
		expect(lastTimedPhase()?.label).toBe("extensions:load");
	});

	it.each([
		[["--mode", "rpc"], true],
		[["--mode=rpc", "--no-session"], true],
		[["--offline", "--mode", "rpc", "--extension", "x.ts"], true],
		[["--mode", "rpc", "--multi-session", "--listen", "unix:///tmp/h.sock"], false],
		[["--mode", "json"], false],
		[["-p", "hello"], false],
		[[], false],
	])("treats %j as a stdio rpc launch: %s", (args, expected) => {
		expect(isStdioRpcLaunch(args)).toBe(expected);
	});
});
