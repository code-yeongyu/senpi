import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { noteChildExit } from "../../../src/modes/rpc/host-child-exit.ts";
import { hostCrashRecordFile, readHostCrashRecords } from "../../../src/modes/rpc/host-crash-record.ts";
import { createHostDaemonPaths, generationPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";

/**
 * senpi#5090: after a task harness removed its owned sandbox, the supervised RPC host's idle
 * shutdown still wrote its terminal record - `recordTerminalHostRecord`'s recursive `mkdirSync`
 * recreated the deleted agent tree and dropped `crashes.jsonl` plus `crashes.lock` into it.
 *
 * The contract here: storage removal is final. A terminal record annotates existing daemon
 * state; it never creates it. Both cases drive the REAL supervisor seam (`noteChildExit`,
 * exactly the incident's engine-stop/idle/stopIntent=false path), never a re-implementation.
 */
const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface IdleStopFixture {
	readonly root: string;
	readonly daemonDir: string;
	readonly crashFile: string;
	readonly stopIdleHostAfterCleanup: () => Promise<void>;
}

/** A live endpoint: the launch (`host-daemon-paths.ts`) created the daemon dir before any record. */
const idleStopFixture = (): IdleStopFixture => {
	const root = mkdtempSync(join(tmpdir(), "senpi-5090-"));
	directories.push(root);
	const paths = createHostDaemonPaths({ socket: join(root, "rpc.sock"), agentDir: root });
	mkdirSync(paths.dir, { recursive: true });
	const instanceId = randomUUID();
	const generation = generationPaths(paths, instanceId);
	const childStartedAt = Date.now() - 902_233;
	const stopIdleHostAfterCleanup = () =>
		noteChildExit({
			daemonDir: paths.dir,
			generation,
			instanceId,
			code: null,
			signal: "SIGTERM",
			childStartedAt,
			shutdown: { reason: "idle", supervisor: { pid: 509_090, kind: "supervisor", generation: instanceId } },
		});
	return { root, daemonDir: paths.dir, crashFile: hostCrashRecordFile(paths.dir), stopIdleHostAfterCleanup };
};

describe("senpi#5090: terminal records never recreate a cleaned sandbox", () => {
	it("keeps the removed agent root absent when the idle-stop record lands after cleanup", async () => {
		const qa = idleStopFixture();
		// The harness cleanup trap removes its owned sandbox while the supervised host still idles.
		rmSync(qa.root, { recursive: true, force: true });
		expect(existsSync(qa.root)).toBe(false);

		await qa.stopIdleHostAfterCleanup();

		expect(existsSync(qa.root)).toBe(false);
		expect(existsSync(qa.daemonDir)).toBe(false);
		expect(existsSync(qa.crashFile)).toBe(false);
	});

	it("still records the idle engine stop while the daemon dir is live", async () => {
		const qa = idleStopFixture();

		await qa.stopIdleHostAfterCleanup();

		expect(readHostCrashRecords(qa.daemonDir)).toHaveLength(1);
		expect(readHostCrashRecords(qa.daemonDir)[0]).toMatchObject({
			kind: "rpc-host",
			detection: "engine_stop",
			reason: "idle",
			stopIntent: false,
			sender: { kind: "supervisor", pid: 509_090 },
		});
	});
});
