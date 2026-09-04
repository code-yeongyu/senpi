import { describe, expect, it, vi } from "vitest";
import { waitForStartTime } from "../../../src/modes/app-server/daemon/process.ts";

/**
 * Regression: PR #1351/#1352 CI failed on Windows with
 * `spawned daemon pid N had no process start time` (runs 33839093178, 33842155236)
 * while the spawned host was perfectly alive.
 *
 * host-ensure.ts calls `waitForStartTime(child.pid, 10_000)` without a probe timeout, so each
 * attempt uses readProcessIdentity's win32 default of 1s. On a loaded runner where Get-CimInstance
 * consistently needs longer than that, EVERY attempt times out, throws, is swallowed by the retry,
 * and the 10s budget dies after ~9 attempts — an observability failure reported as a startup
 * failure. Liveness is never consulted on this path.
 *
 * Timing is injected (fake timers + a stub whose latency we control), never slept on.
 */
describe("waitForStartTime under a slow process-identity probe", () => {
	it("#given every probe outlives its timeout and the process is alive #when the budget expires #then it does not report a missing start time", async () => {
		vi.useFakeTimers();
		try {
			// Given: a CIM-like probe that never answers within its per-attempt timeout,
			// exactly as a loaded Windows runner behaves.
			let attempts = 0;
			const probeLatencyMs = 1_000;
			const slowProbe = async (): Promise<string | undefined> => {
				attempts++;
				await new Promise((resolve) => setTimeout(resolve, probeLatencyMs));
				throw new Error("process identity probe timed out");
			};
			const isLive = () => true;

			// When: the caller waits with the same 10s budget host-ensure.ts uses.
			const result = waitForStartTime(1234, 10_000, slowProbe, isLive);
			const settled = vi.advanceTimersByTimeAsync(30_000).then(() => result);

			// Then: a live process must never be reported as having no start time.
			await expect(settled).resolves.toBeUndefined();
			expect(attempts).toBeGreaterThan(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("#given the probe stays slow and the process is gone #when the budget expires #then the missing start time is still an error", async () => {
		vi.useFakeTimers();
		try {
			// Given: the same starved probe, but the pid is genuinely dead.
			const slowProbe = async (): Promise<string | undefined> => {
				await new Promise((resolve) => setTimeout(resolve, 1_000));
				throw new Error("process identity probe timed out");
			};
			const isLive = () => false;

			// When / Then: a dead pid must still surface the startup failure.
			const result = waitForStartTime(4321, 10_000, slowProbe, isLive);
			const settled = vi.advanceTimersByTimeAsync(30_000).then(() => result);
			await expect(settled).rejects.toThrow("had no process start time");
		} finally {
			vi.useRealTimers();
		}
	});
});
