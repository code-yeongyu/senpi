import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonPidFile } from "../../src/utils/process-identity.ts";
import {
	clearStartupIntent,
	readStartupAttemptRecord,
	readStartupIntent,
	reconcileStartupIntent,
	type StartupIntent,
	startupIntentPath,
	writeStartupIntent,
} from "../../src/modes/rpc/host-startup-intent.ts";
import { STARTUP_ATTEMPT_FILE } from "../../src/modes/rpc/host-startup-wire.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function daemonDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-startup-intent-"));
	dirs.push(dir);
	return dir;
}

const SETTLED_MS = 284_000;
const launcher: DaemonPidFile = { pid: 101, processStartTime: null };
const child: DaemonPidFile = { pid: 202, processStartTime: "child-start" };
const supervisor: DaemonPidFile = { pid: 303, processStartTime: "supervisor-start" };
const base: StartupIntent = {
	attempt: "a".repeat(32),
	instanceId: "instance-1",
	generation: 0,
	launcher,
	writtenAt: 1_000,
};

function reconcile(
	intent: Awaited<ReturnType<typeof readStartupIntent>>,
	options: {
		readonly live?: readonly number[];
		readonly unreadable?: readonly number[];
		readonly recorded?: DaemonPidFile;
		readonly now?: number;
	} = {},
) {
	return reconcileStartupIntent(intent, {
		matches: async (record) => {
			if (options.unreadable?.includes(record.pid)) throw new Error("identity unreadable");
			return options.live?.includes(record.pid) ?? false;
		},
		attemptRecord: async () => options.recorded,
		expiryMs: SETTLED_MS,
		now: options.now ?? 2_000,
	});
}

describe("startup intent record (senpi#4602)", () => {
	it("round-trips owner-only, with and without the child's identity, and clears", async () => {
		const dir = await daemonDir();
		await writeStartupIntent(dir, base);
		expect((await stat(startupIntentPath(dir))).mode & 0o777).toBe(0o600);
		expect(await readStartupIntent(dir)).toEqual(base);
		await writeStartupIntent(dir, { ...base, child });
		expect(await readStartupIntent(dir)).toEqual({ ...base, child });
		await clearStartupIntent(dir);
		expect(await readStartupIntent(dir)).toBeUndefined();
	});

	it("reads a torn intent as unreadable with its file age, never as absent", async () => {
		const dir = await daemonDir();
		await writeFile(startupIntentPath(dir), "{not json");
		expect(await readStartupIntent(dir)).toMatchObject({ unreadable: true, writtenAt: expect.any(Number) });
	});

	it("finds a supervisor's attempt record only under the same attempt nonce", async () => {
		const generation = await daemonDir();
		await mkdir(generation, { recursive: true });
		await writeFile(join(generation, STARTUP_ATTEMPT_FILE), JSON.stringify({ attempt: base.attempt, ...supervisor }));
		expect(await readStartupAttemptRecord(generation, base.attempt)).toEqual(supervisor);
		expect(await readStartupAttemptRecord(generation, "b".repeat(32))).toBeUndefined();
	});
});

describe("startup intent reconciliation (senpi#4602)", () => {
	it.each([
		["no intent", undefined, {}, "none"],
		["a live bound child", { ...base, child }, { live: [202] }, "candidate_live"],
		["a provably gone bound child", { ...base, child }, {}, "candidate_gone"],
		["a bound child whose identity cannot be read", { ...base, child }, { unreadable: [202] }, "unknown"],
		["a live supervisor found by its attempt nonce", base, { recorded: supervisor, live: [303] }, "candidate_live"],
		["a gone supervisor found by its attempt nonce", base, { recorded: supervisor }, "candidate_gone"],
		["a candidate nobody recorded, inside the settled bound", base, { now: 1_000 + SETTLED_MS - 1 }, "unknown"],
		["a candidate nobody recorded, at the settled bound", base, { now: 1_000 + SETTLED_MS }, "expired"],
		[
			"an unreadable intent past the settled bound",
			{ unreadable: true, writtenAt: 0 },
			{ now: SETTLED_MS },
			"expired",
		],
		[
			"a live candidate past the settled bound",
			{ ...base, child },
			{ live: [202], now: 10 * SETTLED_MS },
			"candidate_live",
		],
	] as const)("%s reconciles to %s", async (_case, intent, options, verdict) => {
		expect(await reconcile(intent, options)).toBe(verdict);
	});

	it("does not let a still-running launcher wedge the endpoint: only the candidate decides", async () => {
		expect(await reconcile({ ...base, child }, { live: [101] })).toBe("candidate_gone");
	});

	it("no longer wedges the endpoint once a crashed launcher's unidentifiable intent outlives the settled bound", async () => {
		const dir = await daemonDir();
		await writeStartupIntent(dir, { ...base, writtenAt: Date.now() - SETTLED_MS });
		expect(await reconcile(await readStartupIntent(dir), { now: Date.now() })).toBe("expired");
	});
});
