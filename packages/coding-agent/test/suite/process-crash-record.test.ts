import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	crashingRuntimeVersions,
	installProcessLifetimeMarker,
	processCrashPaths,
	readProcessCrashRecords,
	recordProcessLifetime,
	sweepDeadProcessMarkers,
} from "../../src/core/process-crash-record.ts";

/**
 * senpi#2194: an interactive or print process has no supervising parent (the omo launcher execve's
 * into it), so its native crash left no countable trace. It now leaves a lifetime marker that only a
 * death JavaScript cannot observe leaves behind, and the next start turns that into a record.
 */
const directories: string[] = [];
const agentDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "senpi-process-crash-"));
	directories.push(dir);
	return dir;
};

afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DEAD_PID = 999_001;
const LIVE_PID = 999_002;
const SWEEPER_PID = 999_003;
const onlyLive = (pid: number): boolean => pid === LIVE_PID;

function leaveMarker(dir: string, pid: number, startedAt: number, lastHeartbeatMs: number): string {
	const { liveDir } = processCrashPaths(dir);
	mkdirSync(liveDir, { recursive: true });
	const file = join(liveDir, `${pid}.json`);
	writeFileSync(
		file,
		JSON.stringify({
			kind: "interactive",
			pid,
			startedAt,
			bunVersion: "1.4.2",
			senpiVersion: "2026.9.27",
			productVersion: "5.0.1",
		}),
	);
	utimesSync(file, new Date(lastHeartbeatMs), new Date(lastHeartbeatMs));
	return file;
}

describe("process crash records", () => {
	it("turns the marker of a dead process into exactly one crash record", () => {
		const dir = agentDir();
		const startedAt = Date.UTC(2026, 8, 27, 10, 0, 0);
		const lastHeartbeat = startedAt + 3_600_000;
		const marker = leaveMarker(dir, DEAD_PID, startedAt, lastHeartbeat);

		expect(sweepDeadProcessMarkers(dir, { pid: SWEEPER_PID, isAlive: onlyLive })).toBe(1);
		expect(sweepDeadProcessMarkers(dir, { pid: SWEEPER_PID + 1, isAlive: onlyLive })).toBe(0);

		expect(readProcessCrashRecords(dir)).toEqual([
			{
				at: new Date(lastHeartbeat).toISOString(),
				kind: "interactive",
				detection: "unclean_exit",
				uptimeMs: 3_600_000,
				bunVersion: "1.4.2",
				senpiVersion: "2026.9.27",
				productVersion: "5.0.1",
			},
		]);
		expect(existsSync(marker)).toBe(false);
		expect(readdirSync(processCrashPaths(dir).liveDir)).toEqual([]);
	});

	it("leaves the marker of a live process alone and records nothing", () => {
		const dir = agentDir();
		const marker = leaveMarker(dir, LIVE_PID, Date.now() - 5_000, Date.now());

		expect(sweepDeadProcessMarkers(dir, { pid: SWEEPER_PID, isAlive: onlyLive })).toBe(0);

		expect(existsSync(marker)).toBe(true);
		expect(readProcessCrashRecords(dir)).toEqual([]);
	});

	it("discards a malformed marker without inventing a crash", () => {
		const dir = agentDir();
		const { liveDir } = processCrashPaths(dir);
		mkdirSync(liveDir, { recursive: true });
		writeFileSync(join(liveDir, `${DEAD_PID}.json`), '{"kind":"interactive","pid":');

		expect(sweepDeadProcessMarkers(dir, { pid: SWEEPER_PID, isAlive: onlyLive })).toBe(0);

		expect(readdirSync(liveDir)).toEqual([]);
		expect(readProcessCrashRecords(dir)).toEqual([]);
	});

	it("writes this process's marker with its kind and versions, and removes it on dispose", () => {
		const dir = agentDir();
		const dispose = installProcessLifetimeMarker(dir, "print", { pid: SWEEPER_PID, now: () => 1_000 });
		const file = join(processCrashPaths(dir).liveDir, `${SWEEPER_PID}.json`);

		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			kind: "print",
			pid: SWEEPER_PID,
			startedAt: 1_000,
			...crashingRuntimeVersions(),
		});

		dispose();
		expect(existsSync(file)).toBe(false);
	});

	it("sweeps but writes no marker for a supervised process", () => {
		const dir = agentDir();
		leaveMarker(dir, DEAD_PID, 0, 1_000);

		recordProcessLifetime(dir, "rpc", { supervised: true, pid: SWEEPER_PID, isAlive: onlyLive })();

		expect(readProcessCrashRecords(dir)).toHaveLength(1);
		expect(readdirSync(processCrashPaths(dir).liveDir)).toEqual([]);
	});
});
