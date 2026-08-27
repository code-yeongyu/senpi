import { afterEach, describe, expect, it, vi } from "vitest";
import { TIMEOUT_PAUSE_OP, TIMEOUT_RESUME_OP, withBridgeTimeoutPause } from "../src/timeouts/bridge-timeout.ts";
import { DEFAULT_MAX_PAUSE_GRACE_MS, IdleTimeout } from "../src/timeouts/idle-timeout.ts";

describe("codemode timeout infrastructure", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("re-exports canonical bridge timeout operations", () => {
		expect({ TIMEOUT_PAUSE_OP, TIMEOUT_RESUME_OP }).toEqual({
			TIMEOUT_PAUSE_OP: "timeout-pause",
			TIMEOUT_RESUME_OP: "timeout-resume",
		});
	});

	it("interrupts a cell once when active work exceeds the budget", () => {
		vi.useFakeTimers();
		const interrupted: string[] = [];
		const watchdog = new IdleTimeout({
			cellId: "cell-timeout",
			timeoutMs: 1_000,
			onTimeout: (event) => interrupted.push(`${event.cellId}:${event.error.message}`),
		});

		vi.advanceTimersByTime(999);
		expect(interrupted).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(interrupted).toHaveLength(1);
		expect(interrupted[0]).toMatch(/^cell-timeout:Cell timed out after 1000ms$/u);
		expect(watchdog.signal.aborted).toBe(true);

		vi.advanceTimersByTime(5_000);
		expect(interrupted).toHaveLength(1);
	});

	it("does not time out while a bridge pause is active", async () => {
		vi.useFakeTimers();
		const interrupted: string[] = [];
		const watchdog = new IdleTimeout({
			cellId: "paused-cell",
			timeoutMs: 1_000,
			onTimeout: (event) => interrupted.push(event.cellId),
		});

		const bridgeCall = withBridgeTimeoutPause(watchdog, async () => {
			vi.advanceTimersByTime(5_000);
			return "tool-result";
		});

		await expect(bridgeCall).resolves.toBe("tool-result");
		expect(interrupted).toEqual([]);
	});

	describe("bounded pause grace", () => {
		it("expires while still paused once the grace is exhausted", () => {
			vi.useFakeTimers();
			const interrupted: string[] = [];
			const watchdog = new IdleTimeout({
				cellId: "stuck-bridge-cell",
				timeoutMs: 1_000,
				maxPauseGraceMs: 10_000,
				onTimeout: (event) => interrupted.push(event.cellId),
			});

			// A bridge call that never returns must not suspend the cell forever.
			watchdog.pause();
			vi.advanceTimersByTime(9_999);
			expect(interrupted).toEqual([]);

			vi.advanceTimersByTime(1);
			expect(interrupted).toEqual(["stuck-bridge-cell"]);
			expect(watchdog.signal.aborted).toBe(true);
			expect((watchdog.signal.reason as Error).name).toBe("TimeoutError");
		});

		it("fires the paused deadline exactly once and stays settled", () => {
			vi.useFakeTimers();
			const interrupted: string[] = [];
			const watchdog = new IdleTimeout({
				cellId: "once-cell",
				timeoutMs: 1_000,
				maxPauseGraceMs: 5_000,
				onTimeout: (event) => interrupted.push(event.cellId),
			});

			watchdog.pause();
			vi.advanceTimersByTime(60_000);
			expect(interrupted).toEqual(["once-cell"]);

			// A late resume from the finally-block of the dead bridge call must not revive the cell.
			watchdog.resume();
			vi.advanceTimersByTime(60_000);
			expect(interrupted).toEqual(["once-cell"]);
		});

		it("lets a long bridge call inside the grace finish uninterrupted", async () => {
			vi.useFakeTimers();
			const interrupted: string[] = [];
			const watchdog = new IdleTimeout({
				cellId: "slow-build-cell",
				timeoutMs: 1_000,
				maxPauseGraceMs: 600_000,
				onTimeout: (event) => interrupted.push(event.cellId),
			});

			// A 5-minute build far exceeds the 1s cell budget but fits the grace.
			const build = withBridgeTimeoutPause(watchdog, async () => {
				vi.advanceTimersByTime(300_000);
				return "built";
			});

			await expect(build).resolves.toBe("built");
			expect(interrupted).toEqual([]);
			expect(watchdog.signal.aborted).toBe(false);
		});

		it("keeps the cell alive when resume lands before the paused deadline", async () => {
			vi.useFakeTimers();
			const interrupted: string[] = [];
			const watchdog = new IdleTimeout({
				cellId: "resumed-in-time-cell",
				timeoutMs: 1_000,
				maxPauseGraceMs: 10_000,
				onTimeout: (event) => interrupted.push(event.cellId),
			});

			await withBridgeTimeoutPause(watchdog, async () => {
				vi.advanceTimersByTime(9_000);
			});
			expect(interrupted).toEqual([]);

			// Resume restores a full fresh idle window rather than the leftover grace.
			vi.advanceTimersByTime(999);
			expect(interrupted).toEqual([]);
			vi.advanceTimersByTime(1);
			expect(interrupted).toEqual(["resumed-in-time-cell"]);
		});

		it("gives every sequential bridge call its own full grace", async () => {
			vi.useFakeTimers();
			const interrupted: string[] = [];
			const watchdog = new IdleTimeout({
				cellId: "sequential-grace-cell",
				timeoutMs: 1_000,
				maxPauseGraceMs: 10_000,
				onTimeout: (event) => interrupted.push(event.cellId),
			});

			for (let call = 0; call < 3; call++) {
				await withBridgeTimeoutPause(watchdog, async () => {
					vi.advanceTimersByTime(9_000);
				});
			}

			expect(interrupted).toEqual([]);
		});

		it("bounds the outermost pause when pauses are nested", () => {
			vi.useFakeTimers();
			const interrupted: string[] = [];
			const watchdog = new IdleTimeout({
				cellId: "nested-pause-cell",
				timeoutMs: 1_000,
				maxPauseGraceMs: 10_000,
				onTimeout: (event) => interrupted.push(event.cellId),
			});

			watchdog.pause();
			vi.advanceTimersByTime(5_000);
			watchdog.pause();
			vi.advanceTimersByTime(4_999);
			expect(interrupted).toEqual([]);

			// Inner pauses do not restart the grace clock of the outer one.
			vi.advanceTimersByTime(1);
			expect(interrupted).toEqual(["nested-pause-cell"]);
		});

		it("never lets the grace shorten a cell's own explicit timeout", () => {
			vi.useFakeTimers();
			const interrupted: string[] = [];
			const watchdog = new IdleTimeout({
				cellId: "long-timeout-cell",
				timeoutMs: 120_000,
				maxPauseGraceMs: 10_000,
				onTimeout: (event) => interrupted.push(event.cellId),
			});

			watchdog.pause();
			vi.advanceTimersByTime(119_999);
			expect(interrupted).toEqual([]);
			vi.advanceTimersByTime(1);
			expect(interrupted).toEqual(["long-timeout-cell"]);
		});

		it("applies a default grace when the caller does not supply one", () => {
			vi.useFakeTimers();
			const interrupted: string[] = [];
			const watchdog = new IdleTimeout({
				cellId: "default-grace-cell",
				timeoutMs: 1_000,
				onTimeout: (event) => interrupted.push(event.cellId),
			});

			watchdog.pause();
			vi.advanceTimersByTime(DEFAULT_MAX_PAUSE_GRACE_MS - 1);
			expect(interrupted).toEqual([]);
			vi.advanceTimersByTime(1);
			expect(interrupted).toEqual(["default-grace-cell"]);
		});

		it("stops the paused deadline when the cell is disposed mid-bridge-call", () => {
			vi.useFakeTimers();
			const interrupted: string[] = [];
			const watchdog = new IdleTimeout({
				cellId: "disposed-while-paused-cell",
				timeoutMs: 1_000,
				maxPauseGraceMs: 10_000,
				onTimeout: (event) => interrupted.push(event.cellId),
			});

			watchdog.pause();
			watchdog.dispose();
			vi.advanceTimersByTime(60_000);

			expect(interrupted).toEqual([]);
			expect(watchdog.signal.aborted).toBe(false);
		});
	});

	it("restarts a fresh window after a bridge call releases", async () => {
		vi.useFakeTimers();
		const interrupted: string[] = [];
		const watchdog = new IdleTimeout({
			cellId: "resume-cell",
			timeoutMs: 1_000,
			onTimeout: (event) => interrupted.push(event.cellId),
		});

		vi.advanceTimersByTime(400);
		await withBridgeTimeoutPause(watchdog, async () => {
			vi.advanceTimersByTime(10_000);
		});

		vi.advanceTimersByTime(999);
		expect(interrupted).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(interrupted).toEqual(["resume-cell"]);
	});

	it("restarts a fresh window after sequential bridge pauses", async () => {
		vi.useFakeTimers();
		const interrupted: string[] = [];
		const watchdog = new IdleTimeout({
			cellId: "sequential-cell",
			timeoutMs: 1_000,
			onTimeout: (event) => interrupted.push(event.cellId),
		});

		vi.advanceTimersByTime(250);
		await withBridgeTimeoutPause(watchdog, async () => {
			vi.advanceTimersByTime(5_000);
		});
		vi.advanceTimersByTime(250);
		await withBridgeTimeoutPause(watchdog, async () => {
			vi.advanceTimersByTime(5_000);
		});

		vi.advanceTimersByTime(999);
		expect(interrupted).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(interrupted).toEqual(["sequential-cell"]);
	});

	it("resumes after bridge failure and still fires once", async () => {
		vi.useFakeTimers();
		const interrupted: string[] = [];
		const watchdog = new IdleTimeout({
			cellId: "failed-bridge-cell",
			timeoutMs: 1_000,
			onTimeout: (event) => interrupted.push(event.cellId),
		});

		await expect(
			withBridgeTimeoutPause(watchdog, async () => {
				vi.advanceTimersByTime(5_000);
				throw new Error("denied");
			}),
		).rejects.toThrow("denied");

		vi.advanceTimersByTime(999);
		expect(interrupted).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(interrupted).toEqual(["failed-bridge-cell"]);
		vi.advanceTimersByTime(1_000);
		expect(interrupted).toEqual(["failed-bridge-cell"]);
	});

	it("runs a bridge operation once when no watchdog is wired", async () => {
		let calls = 0;

		const result = await withBridgeTimeoutPause(undefined, async () => {
			calls++;
			return 42;
		});

		expect(result).toBe(42);
		expect(calls).toBe(1);
	});

	it("reference-counts overlapping pauses before starting a fresh timeout window", () => {
		vi.useFakeTimers();
		const interrupted: string[] = [];
		const watchdog = new IdleTimeout({
			cellId: "overlapping-pauses",
			timeoutMs: 1_000,
			onTimeout: (event) => interrupted.push(event.cellId),
		});

		watchdog.pause();
		watchdog.pause();
		vi.advanceTimersByTime(5_000);
		watchdog.resume();
		vi.advanceTimersByTime(5_000);
		expect(interrupted).toEqual([]);

		watchdog.resume();
		vi.advanceTimersByTime(999);
		expect(interrupted).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(interrupted).toEqual(["overlapping-pauses"]);
	});

	it("never fires after disposal", () => {
		vi.useFakeTimers();
		const interrupted: string[] = [];
		const watchdog = new IdleTimeout({
			cellId: "disposed-cell",
			timeoutMs: 1_000,
			onTimeout: (event) => interrupted.push(event.cellId),
		});

		watchdog.dispose();
		vi.advanceTimersByTime(5_000);

		expect(interrupted).toEqual([]);
		expect(watchdog.signal.aborted).toBe(false);
	});

	it("ignores pause and resume after the watchdog has already fired", () => {
		vi.useFakeTimers();
		const interrupted: string[] = [];
		const watchdog = new IdleTimeout({
			cellId: "settled-cell",
			timeoutMs: 1_000,
			onTimeout: (event) => interrupted.push(event.cellId),
		});

		vi.advanceTimersByTime(1_000);
		watchdog.pause();
		watchdog.resume();
		vi.advanceTimersByTime(5_000);

		expect(interrupted).toEqual(["settled-cell"]);
		expect(watchdog.signal.aborted).toBe(true);
	});
});
