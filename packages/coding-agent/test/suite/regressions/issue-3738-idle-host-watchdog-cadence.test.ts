import { execFileSync } from "node:child_process";
import { constants, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	armHostWatchdog,
	HOST_WATCH_PPID_BACKUP_INTERVAL_MS,
	HOST_WATCH_PPID_INTERVAL_MS,
} from "../../../src/modes/rpc/host-watchdog.ts";

// senpi#3738, idle per-thread hosts (omo-desktop-app#3359): the supervisor arms BOTH the inherited pipe and the
// ppid fallback. While the pipe is armed, EOF is the primary signal, so the ppid check must not
// wake the idle host four times a second.
const WINDOW_MS = 10_000;

function livenessChecksOf(spy: { mock: { calls: unknown[][] } }, pid: number): number {
	return spy.mock.calls.filter(([target, signal]) => target === pid && signal === 0).length;
}

describe.skipIf(process.platform === "win32")("host watchdog cadence with an armed pipe", () => {
	const dirs: string[] = [];
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	// A FIFO opened read-write never reaches EOF, so it stands for a live supervisor's pipe.
	const livePipeFd = (): number => {
		const dir = mkdtempSync(join(tmpdir(), "senpi-watchdog-fifo-"));
		dirs.push(dir);
		const fifo = join(dir, "pipe");
		execFileSync("mkfifo", [fifo]);
		return openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
	};

	it("checks the supervisor pid only at the backup cadence while the pipe is armed", async () => {
		vi.useFakeTimers();
		const kill = vi.spyOn(process, "kill");
		const supervisor = process.ppid;
		const disarm = armHostWatchdog({ fd: livePipeFd(), ppid: supervisor }, () => {});
		try {
			await vi.advanceTimersByTimeAsync(WINDOW_MS);
			expect(livenessChecksOf(kill, supervisor)).toBe(WINDOW_MS / HOST_WATCH_PPID_BACKUP_INTERVAL_MS);
		} finally {
			disarm();
		}
	});

	it("keeps the fast cadence when the pipe cannot be armed", async () => {
		vi.useFakeTimers();
		const kill = vi.spyOn(process, "kill");
		const supervisor = process.ppid;
		const disarm = armHostWatchdog({ ppid: supervisor }, () => {});
		try {
			await vi.advanceTimersByTimeAsync(WINDOW_MS);
			expect(livenessChecksOf(kill, supervisor)).toBe(WINDOW_MS / HOST_WATCH_PPID_INTERVAL_MS);
		} finally {
			disarm();
		}
	});

	it("still notices a dead supervisor within the backup cadence while the pipe is armed", async () => {
		vi.useFakeTimers();
		let fired = "";
		const disarm = armHostWatchdog({ fd: livePipeFd(), ppid: 999_999 }, (reason) => {
			fired = reason;
		});
		try {
			await vi.advanceTimersByTimeAsync(HOST_WATCH_PPID_BACKUP_INTERVAL_MS);
			expect(fired).toContain("999999");
		} finally {
			disarm();
		}
	});
});
