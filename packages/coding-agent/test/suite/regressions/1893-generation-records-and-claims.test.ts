// Regression for senpi issue #1893: the daemon directory kept records of generations that had
// ended (`host status` listed only dead pids while three supervisors were alive), and a claim in
// `reservations/` was honored purely because its owner process still existed - so a superseded,
// attachment-less generation could make a session file unopenable for as long as it lived.
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProcessStartTime } from "../../../src/modes/app-server/daemon/process.ts";
import { createHostDaemonPaths, type HostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { pruneDeadGenerations } from "../../../src/modes/rpc/host-generations.ts";
import { createSessionPathReservations, reservationFile } from "../../../src/modes/rpc/host-reservations.ts";
import { readHostStatus } from "../../../src/modes/rpc/host-status.ts";
import { waitForPidGone } from "../../helpers/spawned-host-reaper.ts";

const roots: string[] = [];
const strangers: number[] = [];

afterEach(async () => {
	for (const pid of strangers.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone; the wait below still confirms it.
		}
		await waitForPidGone(pid, 20_000);
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("a session-path claim across generations", () => {
	it("is reclaimable once its owner is superseded and holds no attachment", async () => {
		const daemon = await daemonDirectory("reclaim");
		const owner = await stranger();
		const sessionPath = join(daemon.root, "held.jsonl");
		await writeClaim(daemon.paths, { instanceId: "old", ...owner, sessionPath, attached: false });
		await writePointer(daemon.paths, "current");

		const reservations = createSessionPathReservations({ daemonDir: daemon.paths.dir, instanceId: "current" });

		expect(await reservations.claim(sessionPath)).toBeUndefined();
		expect(await readClaim(daemon.paths, sessionPath)).toMatchObject({ instanceId: "current", pid: process.pid });
	});

	it("is honored while the superseded owner still has a client attached", async () => {
		const daemon = await daemonDirectory("attached");
		const owner = await stranger();
		const sessionPath = join(daemon.root, "held.jsonl");
		await writeClaim(daemon.paths, { instanceId: "old", ...owner, sessionPath, attached: true });
		await writePointer(daemon.paths, "current");

		const reservations = createSessionPathReservations({ daemonDir: daemon.paths.dir, instanceId: "current" });

		expect(await reservations.claim(sessionPath)).toMatchObject({
			instanceId: "old",
			pid: owner.pid,
			current: false,
		});
	});

	it("is honored while its owner is the generation serving the socket", async () => {
		const daemon = await daemonDirectory("serving");
		const owner = await stranger();
		const sessionPath = join(daemon.root, "held.jsonl");
		await writeClaim(daemon.paths, { instanceId: "serving", ...owner, sessionPath, attached: false });
		await writePointer(daemon.paths, "serving");

		const reservations = createSessionPathReservations({ daemonDir: daemon.paths.dir, instanceId: "other" });

		expect(await reservations.claim(sessionPath)).toMatchObject({ instanceId: "serving", current: true });
	});

	it("publishes the attachment state its owner last reported", async () => {
		const daemon = await daemonDirectory("detach");
		const sessionPath = join(daemon.root, "mine.jsonl");
		const reservations = createSessionPathReservations({ daemonDir: daemon.paths.dir, instanceId: "mine" });

		expect(await reservations.claim(sessionPath)).toBeUndefined();
		expect(await readClaim(daemon.paths, sessionPath)).toMatchObject({ attached: true });

		reservations.setAttached(sessionPath, false);
		await waitFor(async () => (await readClaim(daemon.paths, sessionPath))?.attached === false);

		expect(await readClaim(daemon.paths, sessionPath)).toMatchObject({ instanceId: "mine", attached: false });
	});
});

describe("the daemon directory", () => {
	it("is pruned of dead generations, their pointer and their claims", async () => {
		const daemon = await daemonDirectory("prune");
		const dead = await endedPid();
		const alive = await stranger();
		await writeGeneration(daemon.paths, { instanceId: "gone", pid: dead, generation: 0 });
		await writeGeneration(daemon.paths, { instanceId: "live", pid: alive.pid, generation: 1 });
		await writePointer(daemon.paths, "gone");
		await writeClaim(daemon.paths, {
			instanceId: "gone",
			pid: dead,
			processStartTime: null,
			sessionPath: join(daemon.root, "orphan.jsonl"),
			attached: true,
		});

		const pruned = await pruneDeadGenerations(daemon.paths);

		expect(pruned).toMatchObject({ generations: ["gone"], pointer: true });
		expect(pruned.claims).toEqual([join(daemon.root, "orphan.jsonl")]);
		expect(await readdir(daemon.paths.generationsDir)).toEqual(["live"]);
		expect(await claimFiles(daemon.paths.reservationsDir)).toEqual([]);
		expect(existsSync(daemon.paths.pointerFile)).toBe(false);
	});

	it("is reported by host status as one row per alive generation", async () => {
		const daemon = await daemonDirectory("status");
		const dead = await endedPid();
		await writeGeneration(daemon.paths, { instanceId: "gone", pid: dead, generation: 0 });
		await writeGeneration(daemon.paths, { instanceId: "serving", pid: process.pid, generation: 1 });
		await writePointer(daemon.paths, "serving");
		const processStartTime = (await readProcessStartTime(process.pid).catch(() => null)) ?? null;
		for (const name of ["one.jsonl", "two.jsonl"]) {
			await writeClaim(daemon.paths, {
				instanceId: "serving",
				pid: process.pid,
				processStartTime,
				sessionPath: join(daemon.root, name),
				attached: true,
			});
		}

		const status = await readHostStatus({ socket: daemon.socket, agentDir: daemon.agentDir });

		expect(status.reachable).toBe(false);
		expect(status.generations).toHaveLength(1);
		const row = status.generations[0];
		expect(row).toMatchObject({
			instanceId: "serving",
			pid: process.pid,
			sessions: 2,
			current: true,
			alive: true,
		});
		// `ps` can be unavailable or too slow to answer under load, and the field's contract is
		// `number | null` for exactly that reason: assert it is published, not that it was measured.
		expect(row?.rss_mb === null || typeof row?.rss_mb === "number").toBe(true);
		expect(await readdir(daemon.paths.generationsDir)).toEqual(["serving"]);
	});
});

interface DaemonScratch {
	readonly root: string;
	readonly agentDir: string;
	readonly socket: string;
	readonly paths: HostDaemonPaths;
}

async function daemonDirectory(label: string): Promise<DaemonScratch> {
	const root = realpathSync(await mkdtemp(join(tmpdir(), `sg93-${label}-`)));
	roots.push(root);
	const agentDir = join(root, "a");
	const socket = join(root, "rpc.sock");
	await mkdir(agentDir, { recursive: true });
	const paths = createHostDaemonPaths({ socket, agentDir });
	await mkdir(paths.generationsDir, { recursive: true, mode: 0o700 });
	await mkdir(paths.reservationsDir, { recursive: true, mode: 0o700 });
	return { root, agentDir, socket, paths };
}

/** A live process this test does not own the identity of: a foreign claim needs a real owner. */
async function stranger(): Promise<{ pid: number; processStartTime: string | null }> {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
	const pid = child.pid;
	if (pid === undefined) throw new Error("could not spawn a stranger process");
	strangers.push(pid);
	child.unref();
	return { pid, processStartTime: (await readProcessStartTime(pid).catch(() => null)) ?? null };
}

/** A pid that is certainly nobody's: spawned, killed, and waited out. */
async function endedPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
	const pid = child.pid;
	if (pid === undefined) throw new Error("could not spawn a process to end");
	child.kill("SIGKILL");
	await waitForPidGone(pid, 20_000);
	return pid;
}

async function writeClaim(
	paths: HostDaemonPaths,
	owner: {
		instanceId: string;
		pid: number;
		processStartTime: string | null;
		sessionPath: string;
		attached: boolean;
	},
): Promise<void> {
	await writeFile(reservationFile(paths.reservationsDir, owner.sessionPath), `${JSON.stringify(owner)}\n`, {
		mode: 0o600,
	});
}

async function readClaim(paths: HostDaemonPaths, sessionPath: string): Promise<Record<string, unknown> | undefined> {
	try {
		return JSON.parse(await readFile(reservationFile(paths.reservationsDir, sessionPath), "utf8"));
	} catch {
		return undefined;
	}
}

async function writeGeneration(
	paths: HostDaemonPaths,
	record: { instanceId: string; pid: number; generation: number },
): Promise<void> {
	const dir = join(paths.generationsDir, record.instanceId);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await writeFile(
		join(dir, "host.pid"),
		`${JSON.stringify({
			pid: record.pid,
			processStartTime: null,
			instance_id: record.instanceId,
			generation: record.generation,
			engineVersion: "test",
		})}\n`,
		{ mode: 0o600 },
	);
}

async function writePointer(paths: HostDaemonPaths, instanceId: string): Promise<void> {
	await writeFile(
		paths.pointerFile,
		`${JSON.stringify({ layout: 2, instance_id: instanceId, generation_dir: `generations/${instanceId}` })}\n`,
		{ mode: 0o600 },
	);
}

async function claimFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir).catch(() => [] as string[]);
	return entries.filter((entry) => entry.endsWith(".json")).sort();
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await condition()) return;
		if (Date.now() >= deadline) throw new Error("the claim never carried the reported attachment state");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
