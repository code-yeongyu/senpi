/**
 * senpi#4602: the bounded, progress-aware startup readiness policy (A-amended).
 *
 * The startup controller owns one generation attempt from the moment before spawn: each startup
 * phase gets a finite allowance from the moment it is entered, every deadline is clipped to
 * 180 s after spawn, and an accepted milestone grants the NEXT phase its allowance. Everything here
 * runs on an injected virtual clock, so no test sleeps or depends on how loaded the machine is.
 */
import { describe, expect, it } from "vitest";
import {
	STARTUP_DECISION_BUDGET_MS,
	STARTUP_PHASE_ALLOWANCE_MS,
	type StartupClock,
	type StartupPhase,
	startStartupController,
	startupEnvelope,
	startupTimeoutDetail,
} from "../../src/modes/rpc/host-startup-policy.ts";

const INITIAL_PATH: readonly StartupPhase[] = [
	"supervisor_bootstrap",
	"supervisor_setup",
	"host_bootstrap",
	"host_runtime",
	"internal_ready",
	"observer_ready",
	"public_published",
	"presenter_resolved",
	"public_verified",
];

function virtualClock(): StartupClock & { advanceTo(at: number): void } {
	let now = 1_000_000;
	const origin = now;
	const scheduled = new Map<number, { at: number; fire: () => void }>();
	let next = 0;
	return {
		now: () => now,
		scheduleAt(at, fire) {
			const id = next++;
			scheduled.set(id, { at, fire });
			return id;
		},
		cancel(handle) {
			scheduled.delete(handle as number);
		},
		advanceTo(elapsed) {
			const target = origin + elapsed;
			for (;;) {
				const due = [...scheduled.entries()]
					.filter(([, entry]) => entry.at <= target)
					.sort(([, a], [, b]) => a.at - b.at)[0];
				if (!due) break;
				now = Math.max(now, due[1].at);
				scheduled.delete(due[0]);
				due[1].fire();
			}
			now = target;
		},
	};
}

describe("startup policy constants (senpi#4602)", () => {
	it("publishes the A-amended phase allowances and the 180 s spawn-origin ceiling", () => {
		expect(STARTUP_DECISION_BUDGET_MS).toBe(180_000);
		expect(STARTUP_PHASE_ALLOWANCE_MS).toEqual({
			supervisor_bootstrap: 30_000,
			supervisor_setup: 15_000,
			host_bootstrap: 30_000,
			host_runtime: 60_000,
			internal_ready: 15_000,
			observer_ready: 15_000,
			public_published: 15_000,
			presenter_resolved: 30_000,
			public_verified: 10_000,
		});
	});

	it("derives the stop, cleanup, settled-result and lock-wait envelope from the child-stall setting", () => {
		expect(startupEnvelope()).toEqual({
			decision: 180_000,
			stop: 97_000,
			cleanup: 104_000,
			settled: 284_000,
			discovery: 90_000,
			holder: 471_000,
			lockWait: 481_000,
			handoverReply: 962_000,
		});
		expect(startupEnvelope(120_000)).toEqual({
			decision: 180_000,
			stop: 157_000,
			cleanup: 164_000,
			settled: 344_000,
			discovery: 90_000,
			holder: 591_000,
			lockWait: 601_000,
			handoverReply: 1_202_000,
		});
	});
});

describe("startup controller (senpi#4602)", () => {
	it("accepts a start whose phases keep progressing well past the old 10 s readiness budget", () => {
		const clock = virtualClock();
		const controller = startStartupController({ launchKind: "initial", clock });
		const completions = [8_000, 14_000, 30_000, 70_000, 75_000, 78_000, 80_000, 80_000, 82_000];
		INITIAL_PATH.forEach((phase, index) => {
			clock.advanceTo(completions[index]!);
			expect(controller.complete(phase)).toBe("accepted");
		});
		expect(controller.terminal).toEqual({ kind: "ready", elapsedMs: 82_000 });
	});

	it("fails a stalled phase at that phase's allowance, long before the overall ceiling", () => {
		const clock = virtualClock();
		const controller = startStartupController({ launchKind: "initial", clock });
		clock.advanceTo(5_000);
		controller.complete("supervisor_bootstrap");
		clock.advanceTo(10_000);
		controller.complete("supervisor_setup");
		clock.advanceTo(20_000);
		controller.complete("host_bootstrap");
		clock.advanceTo(20_000 + 60_000 - 1);
		expect(controller.terminal).toBeUndefined();
		clock.advanceTo(20_000 + 60_000);
		expect(controller.terminal).toEqual({
			kind: "timeout",
			phase: "host_runtime",
			limit: "phase",
			phaseBudgetMs: 60_000,
			elapsedMs: 80_000,
		});
	});

	it("refuses at the 180 s overall ceiling even when every phase finishes inside its own allowance", () => {
		const clock = virtualClock();
		const controller = startStartupController({ launchKind: "initial", clock });
		let elapsed = 0;
		for (const phase of INITIAL_PATH.slice(0, 7)) {
			elapsed += STARTUP_PHASE_ALLOWANCE_MS[phase] - 1;
			clock.advanceTo(elapsed);
			expect(controller.complete(phase)).toBe("accepted");
		}
		expect(elapsed).toBe(179_993);
		clock.advanceTo(STARTUP_DECISION_BUDGET_MS - 1);
		expect(controller.terminal).toBeUndefined();
		clock.advanceTo(STARTUP_DECISION_BUDGET_MS);
		expect(controller.terminal).toEqual({
			kind: "timeout",
			phase: "presenter_resolved",
			limit: "overall",
			phaseBudgetMs: 30_000,
			elapsedMs: 180_000,
		});
	});

	it("lets the deadline win at equality and never revives a terminal attempt", () => {
		const clock = virtualClock();
		const controller = startStartupController({ launchKind: "initial", clock });
		clock.advanceTo(30_000);
		expect(controller.complete("supervisor_bootstrap")).toBe("rejected");
		expect(controller.terminal).toMatchObject({ kind: "timeout", phase: "supervisor_bootstrap", limit: "phase" });
		clock.advanceTo(31_000);
		expect(controller.complete("supervisor_setup")).toBe("rejected");
		expect(controller.terminal).toMatchObject({ kind: "timeout", phase: "supervisor_bootstrap" });
	});

	it("grants no time for replayed or out-of-order milestones", () => {
		const clock = virtualClock();
		const controller = startStartupController({ launchKind: "initial", clock });
		clock.advanceTo(1_000);
		controller.complete("supervisor_bootstrap");
		clock.advanceTo(10_000);
		expect(controller.complete("supervisor_bootstrap")).toBe("ignored");
		expect(controller.complete("host_bootstrap")).toBe("rejected");
		clock.advanceTo(1_000 + 15_000);
		expect(controller.terminal).toMatchObject({ kind: "timeout", phase: "supervisor_setup", phaseBudgetMs: 15_000 });
	});

	it("runs a successor's presenter enrollment before public publication", () => {
		const clock = virtualClock();
		const controller = startStartupController({ launchKind: "successor", clock });
		for (const phase of INITIAL_PATH.slice(0, 6)) expect(controller.complete(phase)).toBe("accepted");
		expect(controller.complete("public_published")).toBe("rejected");
		expect(controller.complete("presenter_resolved")).toBe("accepted");
		expect(controller.complete("public_published")).toBe("accepted");
		expect(controller.complete("public_verified")).toBe("accepted");
		expect(controller.terminal).toEqual({ kind: "ready", elapsedMs: 0 });
	});

	it("keeps an explicit failure latched over a later ready", () => {
		const clock = virtualClock();
		const controller = startStartupController({ launchKind: "initial", clock });
		clock.advanceTo(2_000);
		controller.fail(new Error("internal proof rejected"));
		expect(controller.complete("supervisor_bootstrap")).toBe("rejected");
		expect(controller.terminal).toMatchObject({ kind: "failed", phase: "supervisor_bootstrap", elapsedMs: 2_000 });
	});
});

describe("startup timeout detail (senpi#4602)", () => {
	it("names the phase, which limit fired, both budgets, elapsed time and cleanup state", () => {
		const detail = startupTimeoutDetail(
			{ kind: "timeout", phase: "host_runtime", limit: "phase", phaseBudgetMs: 60_000, elapsedMs: 80_000 },
			"completed",
		);
		const fields = Object.fromEntries(
			detail
				.replace(/^RPC host startup timed out: /, "")
				.split("; ")
				.map((field) => field.split("=") as [string, string]),
		);
		expect(fields).toEqual({
			phase: "host_runtime",
			limit: "phase",
			phase_budget_ms: "60000",
			startup_budget_ms: "180000",
			elapsed_ms: "80000",
			cleanup: "completed",
		});
	});
});
