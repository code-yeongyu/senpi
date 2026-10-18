import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../../config.ts";
import { noteChildExit } from "./host-child-exit.ts";
import {
	HOST_CRASH_RECORD_LIMIT,
	hostCrashRecordFile,
	isHostCrash,
	readHostCrashRecords,
	recordHostCrash,
	recordTerminalHostRecord,
} from "./host-crash-record.ts";
import { createHostDaemonPaths, generationPaths, type HostDaemonPaths } from "./host-daemon-paths.ts";

/**
 * senpi#1950: the supervisor already separated a crashed child from a clean idle exit and then
 * reported the crash only to stderr - which the next host start truncates. A host dying hourly
 * left nothing countable behind, so every investigation had to correlate OS crash reports by hand.
 */
const directories: string[] = [];
const endpoints = new Map<string, HostDaemonPaths>();
const daemonDir = (): string => {
	const root = mkdtempSync(join(tmpdir(), "senpi-crash-record-"));
	directories.push(root);
	const paths = createHostDaemonPaths({ socket: join(root, "rpc.sock"), agentDir: root });
	endpoints.set(paths.dir, paths);
	return paths.dir;
};
const generationIn = (dir: string, instanceId: string) => {
	const paths = endpoints.get(dir);
	if (paths === undefined) throw new Error(`${dir} is not a scratch endpoint`);
	return generationPaths(paths, instanceId);
};

afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Drives the REAL seam the supervisor's exit handler calls, so removing that call or inverting the
 * crash condition fails these tests. A local re-implementation would pass either way.
 */
const observeChildExit = (
	dir: string,
	code: number | null,
	signal: NodeJS.Signals | null,
	uptimeMs: number,
): Promise<void> => {
	const now = Date.now();
	const instanceId = randomUUID();
	const generation = generationIn(dir, instanceId);
	return noteChildExit({ daemonDir: dir, generation, instanceId, code, signal, childStartedAt: now - uptimeMs, now });
};

describe("host crash records", () => {
	it("names the process kind and the runtime that crashed (senpi#2194)", async () => {
		const dir = daemonDir();
		await observeChildExit(dir, null, "SIGSEGV", 1_000);

		expect(readHostCrashRecords(dir)[0]).toMatchObject({
			kind: "rpc-host",
			detection: "supervisor",
			senpiVersion: VERSION,
			...(process.versions.bun === undefined ? {} : { bunVersion: process.versions.bun }),
		});
	});

	it("keeps the first crash readable after a replacement host starts", async () => {
		const dir = daemonDir();
		await observeChildExit(dir, null, "SIGBUS", 3_061_000);

		// A replacement generation boots and writes its own daemon state. This is exactly the
		// moment the stderr log was lost, so it is the moment the record has to survive.
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ coldStart: "transient" }));

		const records = readHostCrashRecords(dir);
		expect(records).toHaveLength(1);
		expect(records[0]?.signal).toBe("SIGBUS");
		expect(records[0]?.uptimeMs).toBe(3_061_000);
	});

	it("accumulates repeated crashes in order so they can be counted", async () => {
		const dir = daemonDir();
		await observeChildExit(dir, null, "SIGSEGV", 5_000);
		await observeChildExit(dir, null, "SIGBUS", 9_000);

		const records = readHostCrashRecords(dir);
		expect(records).toHaveLength(2);
		expect(records.map((record) => record.signal)).toEqual(["SIGSEGV", "SIGBUS"]);
	});

	it("records a non-zero exit code when the child exited instead of signalling", async () => {
		const dir = daemonDir();
		await observeChildExit(dir, 1, null, 1_500);

		const records = readHostCrashRecords(dir);
		expect(records).toHaveLength(1);
		expect(records[0]?.code).toBe(1);
		expect(records[0]?.signal).toBeUndefined();
	});

	it("writes nothing for a clean idle exit, so the line count is a crash count", async () => {
		const dir = daemonDir();
		await observeChildExit(dir, 0, null, 900_000);

		expect(readHostCrashRecords(dir)).toEqual([]);
		expect(() => readFileSync(hostCrashRecordFile(dir), "utf8")).toThrow();
	});

	it("bounds the file so a crash loop cannot grow it forever", () => {
		const dir = daemonDir();
		for (let index = 0; index < HOST_CRASH_RECORD_LIMIT + 10; index++) {
			recordHostCrash(dir, { at: new Date().toISOString(), signal: "SIGBUS", uptimeMs: index });
		}

		const records = readHostCrashRecords(dir);
		expect(records).toHaveLength(HOST_CRASH_RECORD_LIMIT);
		// Pruning keeps the NEWEST: the oldest uptimes are the ones that must be gone.
		expect(records[0]?.uptimeMs).toBe(10);
		expect(records.at(-1)?.uptimeMs).toBe(HOST_CRASH_RECORD_LIMIT + 9);
	});

	it("survives an unwritable directory rather than throwing into the shutdown path", () => {
		expect(() =>
			recordHostCrash(join("/nonexistent-root-for-senpi-1950", "daemon"), {
				at: new Date().toISOString(),
				signal: "SIGBUS",
				uptimeMs: 1,
			}),
		).not.toThrow();
	});

	it("skips a torn final line from a host killed mid-append", () => {
		const dir = daemonDir();
		recordHostCrash(dir, { at: new Date().toISOString(), signal: "SIGSEGV", uptimeMs: 42 });
		writeFileSync(hostCrashRecordFile(dir), `${readFileSync(hostCrashRecordFile(dir), "utf8")}{"at":"tru`);

		const records = readHostCrashRecords(dir);
		expect(records).toHaveLength(1);
		expect(records[0]?.uptimeMs).toBe(42);
	});

	it("keeps every senpi#2566 field through a round trip, and an older record still parses", async () => {
		const dir = daemonDir();
		recordHostCrash(dir, { at: new Date().toISOString(), signal: "SIGSEGV", uptimeMs: 7 });
		const sender = { pid: 41, kind: "ensure", generation: "g0" } as const;
		await recordTerminalHostRecord(dir, {
			at: new Date().toISOString(),
			signal: "SIGKILL",
			uptimeMs: 5,
			generation: "g1",
			detection: "engine_stop",
			sender,
			chain: [sender, { pid: 42, kind: "supervisor", generation: "g1" }],
			reason: "readiness_timeout -> idle",
			stopIntent: true,
			stall: { driftMs: 6_000, at: new Date().toISOString(), attributedSessionId: "s1" },
		});

		const [older, newer] = readHostCrashRecords(dir);
		expect(older).toMatchObject({ signal: "SIGSEGV", uptimeMs: 7 });
		expect(newer).toMatchObject({
			kind: "rpc-host",
			generation: "g1",
			sender,
			chain: [sender, { kind: "supervisor" }],
			stall: { driftMs: 6_000, attributedSessionId: "s1" },
		});
	});

	it("keeps one terminal record per generation, beside that generation's watchdog line", async () => {
		const dir = daemonDir();
		const terminal = {
			at: new Date().toISOString(),
			uptimeMs: 1,
			generation: "g1",
			detection: "engine_stop",
		} as const;
		await recordTerminalHostRecord(dir, { ...terminal, reason: "first" });
		recordHostCrash(dir, { at: new Date().toISOString(), uptimeMs: 2, kind: "rpc-host-watchdog", generation: "g1" });
		await recordTerminalHostRecord(dir, { ...terminal, reason: "second" });
		await recordTerminalHostRecord(dir, { ...terminal, generation: "g2", reason: "other generation" });

		expect(readHostCrashRecords(dir).map((record) => [record.kind, record.generation, record.reason])).toEqual([
			["rpc-host", "g1", "first"],
			["rpc-host-watchdog", "g1", undefined],
			["rpc-host", "g2", "other generation"],
		]);
	});

	it("counts as crashes only the deaths no engine process asked for", () => {
		const at = new Date().toISOString();
		expect(isHostCrash({ at, uptimeMs: 1, signal: "SIGSEGV" })).toBe(true);
		expect(isHostCrash({ at, uptimeMs: 1, kind: "rpc-host", detection: "external" })).toBe(true);
		expect(isHostCrash({ at, uptimeMs: 1, kind: "rpc-host", detection: "engine_stop" })).toBe(false);
		expect(isHostCrash({ at, uptimeMs: 1, kind: "rpc-host-watchdog" })).toBe(false);
	});

	it("reads a torn stop intent as none, so a SIGKILL from outside is external", async () => {
		const dir = daemonDir();
		const instanceId = randomUUID();
		const generation = generationIn(dir, instanceId);
		mkdirSync(generation.dir, { recursive: true });
		writeFileSync(generation.stopIntentFile, '{"sender":{"pid":1,"kind":"ens');

		await noteChildExit({ daemonDir: dir, generation, instanceId, code: null, signal: "SIGKILL", childStartedAt: 0 });

		expect(readHostCrashRecords(dir)).toEqual([
			expect.objectContaining({ generation: instanceId, detection: "external", stopIntent: false }),
		]);
	});
});
