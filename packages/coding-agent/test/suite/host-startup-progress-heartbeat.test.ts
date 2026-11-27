/**
 * A coordinated producer reports `progress` only to a launcher that advertised it reads progress records (a launcher
 * built before them fails the attempt on one), only while the process is actually doing work (CPU spent since the
 * last tick, not just a turning event loop), and only until its own last startup milestone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startStartupProgress } from "../../src/modes/rpc/host-startup-beacon.ts";
import { beginStartupAttempt } from "../../src/modes/rpc/host-startup-run.ts";
import {
	parseStartupHandOff,
	STARTUP_PROGRESS_INTERVAL_MS,
	STARTUP_PROGRESS_MIN_CPU_MS,
	type StartupHandOff,
} from "../../src/modes/rpc/host-startup-wire.ts";

const binding = {
	attempt: "a".repeat(32),
	endpoint: "/tmp/senpi-test/host.sock",
	instanceId: "instance-1",
	generation: 0,
	launchKind: "initial",
	predecessor: null,
} as const;

/** A hand-off exactly as a launcher built before progress records writes it. */
const preProgressHandOff: StartupHandOff = { binding, role: "supervisor", budgetMs: 180_000, fillers: [] };
const progressHandOff: StartupHandOff = { ...preProgressHandOff, progress: true };

function busyCpu() {
	let spent = 0;
	return { cpuMs: () => spent, work: (ms: number) => void (spent += ms) };
}

describe("startup progress heartbeat", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("advertises progress in the hand-off a launcher of this build gives its supervisor", () => {
		const attempt = beginStartupAttempt({
			socket: binding.endpoint,
			instanceId: "i",
			generation: 0,
			coordinated: true,
			attempt: "n",
		});
		attempt.stdio(["ignore", "ignore", "ignore"]);
		const [value] = Object.values(attempt.env);
		expect(parseStartupHandOff(value)?.progress).toBe(true);
	});

	it("sends no progress to a launcher that never advertised it, however busy the producer is", () => {
		const report = vi.fn();
		const cpu = busyCpu();
		const handOff = parseStartupHandOff(JSON.stringify(preProgressHandOff));
		if (!handOff) throw new Error("the pre-progress hand-off must still parse");
		const progress = startStartupProgress(handOff, report, cpu.cpuMs);
		for (let tick = 0; tick < 10; tick++) {
			cpu.work(10 * STARTUP_PROGRESS_MIN_CPU_MS);
			vi.advanceTimersByTime(STARTUP_PROGRESS_INTERVAL_MS);
		}
		expect(progress).toBeUndefined();
		expect(report).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reports a tick only when the producer spent CPU on its work since the last one", () => {
		const report = vi.fn();
		const cpu = busyCpu();
		startStartupProgress(progressHandOff, report, cpu.cpuMs);
		cpu.work(STARTUP_PROGRESS_MIN_CPU_MS);
		vi.advanceTimersByTime(STARTUP_PROGRESS_INTERVAL_MS);
		expect(report).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(5 * STARTUP_PROGRESS_INTERVAL_MS);
		expect(report).toHaveBeenCalledTimes(1);
		cpu.work(STARTUP_PROGRESS_MIN_CPU_MS - 1);
		vi.advanceTimersByTime(STARTUP_PROGRESS_INTERVAL_MS);
		expect(report).toHaveBeenCalledTimes(1);
		cpu.work(STARTUP_PROGRESS_MIN_CPU_MS);
		vi.advanceTimersByTime(STARTUP_PROGRESS_INTERVAL_MS);
		expect(report).toHaveBeenCalledTimes(2);
	});

	it("stops at the producer's own last milestone and leaves no timer behind", () => {
		const report = vi.fn();
		const cpu = busyCpu();
		const progress = startStartupProgress({ ...progressHandOff, role: "host" }, report, cpu.cpuMs);
		progress?.milestone("host_bootstrap");
		cpu.work(STARTUP_PROGRESS_MIN_CPU_MS);
		vi.advanceTimersByTime(STARTUP_PROGRESS_INTERVAL_MS);
		expect(report).toHaveBeenCalledTimes(1);
		progress?.milestone("host_runtime");
		cpu.work(STARTUP_PROGRESS_MIN_CPU_MS);
		vi.advanceTimersByTime(10 * STARTUP_PROGRESS_INTERVAL_MS);
		expect(report).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stops at the attempt's decision budget", () => {
		const report = vi.fn();
		const cpu = busyCpu();
		startStartupProgress({ ...progressHandOff, budgetMs: 3 * STARTUP_PROGRESS_INTERVAL_MS + 1 }, report, cpu.cpuMs);
		for (let tick = 0; tick < 10; tick++) {
			cpu.work(STARTUP_PROGRESS_MIN_CPU_MS);
			vi.advanceTimersByTime(STARTUP_PROGRESS_INTERVAL_MS);
		}
		expect(report).toHaveBeenCalledTimes(3);
		expect(vi.getTimerCount()).toBe(0);
	});
});
