import { afterEach, describe, expect, it, vi } from "vitest";
import { TIMEOUT_PAUSE_OP, TIMEOUT_RESUME_OP, withBridgeTimeoutPause } from "../src/timeouts/bridge-timeout.ts";
import { IdleTimeout } from "../src/timeouts/idle-timeout.ts";

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
});
