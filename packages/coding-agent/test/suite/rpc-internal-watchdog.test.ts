import { afterEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
	identity: undefined as string | undefined,
	ticks: undefined as string | undefined,
	fail: false,
	calls: 0,
}));
// Both clock domains (senpi#3816 review): macOS compares ps lstart, Linux compares /proc start ticks.
vi.mock("../../src/utils/process-identity.ts", async (original) => ({
	...(await original<typeof import("../../src/utils/process-identity.ts")>()),
	readProcessStartTime: async () => {
		probe.calls++;
		if (probe.fail) throw new Error("identity unavailable");
		return probe.identity;
	},
}));
vi.mock("../../src/utils/process-start-identity.ts", async (original) => ({
	...(await original<typeof import("../../src/utils/process-start-identity.ts")>()),
	readProcessStartTicks: () => {
		probe.calls++;
		if (probe.fail) throw new Error("identity unavailable");
		return probe.ticks;
	},
}));

import { armHostWatchdog, readHostWatchdogConfig } from "../../src/modes/rpc/host-watchdog.ts";

const start = "Tue Oct 20 10:00:00 2026";
const startTicks = "123456";
// The identity check is rare (senpi#3816 review); this window covers its slowest cadence.
const IDENTITY_WINDOW_MS = 61_000;
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	probe.identity = undefined;
	probe.ticks = undefined;
	probe.fail = false;
	probe.calls = 0;
});

// senpi#3795 v7.1: wrappers change ppid, never the recorded supervisor identity.
describe("recorded supervisor lifetime", () => {
	it("does not arm slot three for a supervised POSIX child", () => {
		const config = readHostWatchdogConfig({
			SENPI_RPC_HOST_WATCH_FD: "3",
			SENPI_RPC_HOST_WATCH_PPID: "4242",
			SENPI_RPC_HOST_WATCH_PSTART: start,
			SENPI_RPC_HOST_WATCH_PSTART_TICKS: startTicks,
		});
		expect(config?.fd).toBe(process.platform === "win32" ? 3 : undefined);
		expect(config?.processStartTime).toBe(start);
		expect(config?.processStartTicks).toBe(startTicks);
	});

	it.each(["wrapper", "missing", "unreadable", "permission"] as const)(
		"keeps a live supervisor up with %s identity",
		async (kind) => {
			vi.useFakeTimers();
			vi.spyOn(process, "kill").mockImplementation(() => {
				if (kind === "permission") throw Object.assign(new Error("denied"), { code: "EPERM" });
				return true;
			});
			probe.identity = kind === "wrapper" ? start : undefined;
			probe.ticks = kind === "wrapper" ? startTicks : undefined;
			probe.fail = kind === "unreadable";
			const fired = vi.fn();
			const stop = armHostWatchdog({ ppid: 4242, processStartTime: start, processStartTicks: startTicks }, fired);
			try {
				await vi.advanceTimersByTimeAsync(IDENTITY_WINDOW_MS);
				expect(fired).not.toHaveBeenCalled();
			} finally {
				stop();
			}
		},
	);

	it.each(["ESRCH", "reuse"] as const)("ends the host on confirmed %s", async (kind) => {
		vi.useFakeTimers();
		vi.spyOn(process, "kill").mockImplementation(() => {
			if (kind === "ESRCH") throw Object.assign(new Error("gone"), { code: "ESRCH" });
			return true;
		});
		probe.identity = "Tue Oct 20 11:00:00 2026";
		probe.ticks = "999999";
		const fired = vi.fn();
		const stop = armHostWatchdog({ ppid: 4242, processStartTime: start, processStartTicks: startTicks }, fired);
		try {
			await vi.advanceTimersByTimeAsync(IDENTITY_WINDOW_MS);
			expect(fired).toHaveBeenCalledTimes(1);
		} finally {
			stop();
		}
	});

	// senpi#3816 review (M1, senpi#3738): on Linux an idle supervised host has no stdin lifetime fd and no slot 3, so the
	// recorded identity is its only binding. It wakes once a second for the free liveness check, not four times.
	it("an idle host whose only binding is the recorded identity wakes once a second", async () => {
		vi.useFakeTimers();
		const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
		const stop = armHostWatchdog({ ppid: 4242, processStartTime: start, processStartTicks: startTicks }, vi.fn());
		try {
			await vi.advanceTimersByTimeAsync(10_000);
			expect(kill.mock.calls.filter(([pid, signal]) => pid === 4242 && signal === 0)).toHaveLength(10);
		} finally {
			stop();
		}
	});
});
