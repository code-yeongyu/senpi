import { describe, expect, it } from "vitest";
import { createStartupFinalizer, type StartupFailure } from "../../src/modes/rpc/host-startup-finalizer.ts";
import type { StartupClock } from "../../src/modes/rpc/host-startup-policy.ts";

function manualClock(): StartupClock & { fireAll(): void } {
	const pending = new Map<number, () => void>();
	let next = 0;
	return {
		now: () => 0,
		scheduleAt(_at, fire) {
			const id = next++;
			pending.set(id, fire);
			return id;
		},
		cancel(handle) {
			pending.delete(handle as number);
		},
		fireAll() {
			for (const [id, fire] of [...pending]) {
				pending.delete(id);
				fire();
			}
		},
	};
}

const timeout: StartupFailure = {
	kind: "timeout",
	phase: "host_runtime",
	limit: "phase",
	phaseBudgetMs: 60_000,
	elapsedMs: 80_000,
};

describe("startup finalizer (senpi#4602)", () => {
	it("runs cleanup once and reports a completed cleanup in the timeout detail", async () => {
		let runs = 0;
		const finalize = createStartupFinalizer({
			clock: manualClock(),
			cleanupBudgetMs: 104_000,
			cleanup: async () => {
				runs += 1;
			},
		});
		const [first, second] = await Promise.all([finalize(timeout), finalize({ ...timeout, phase: "host_bootstrap" })]);
		expect(runs).toBe(1);
		expect(second).toBe(first);
		expect(first.cleanup).toBe("completed");
		expect(first.detail).toMatch(/^RPC host startup timed out: phase=host_runtime;.*; cleanup=completed$/);
	});

	it("keeps the original cause first and appends a cleanup failure", async () => {
		const finalize = createStartupFinalizer({
			clock: manualClock(),
			cleanupBudgetMs: 104_000,
			cleanup: () => Promise.reject(new Error("child exit unproven")),
		});
		const report = await finalize({
			kind: "failed",
			phase: "internal_ready",
			cause: new Error("internal proof rejected"),
			elapsedMs: 5_000,
		});
		expect(report.cleanup).toBe("incomplete");
		expect(report.detail.split("\n")).toEqual(["internal proof rejected", "cleanup failed: child exit unproven"]);
	});

	it("settles at the cleanup allowance with cleanup=incomplete when teardown hangs", async () => {
		const clock = manualClock();
		const finalize = createStartupFinalizer({
			clock,
			cleanupBudgetMs: 104_000,
			cleanup: () => new Promise(() => {}),
		});
		const settled = finalize(timeout);
		clock.fireAll();
		const report = await settled;
		expect(report.cleanup).toBe("incomplete");
		expect(report.detail.split("\n")).toEqual([
			expect.stringMatching(/cleanup=incomplete$/),
			"cleanup did not finish within 104000ms",
		]);
	});
});
