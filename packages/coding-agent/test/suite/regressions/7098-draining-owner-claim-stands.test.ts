// Regression for senpi#7098 (oh-my-openagent#14429): during a generation handoff a reopen of a
// detached retained session whose turn was still running in the draining predecessor took the
// file's claim over, because a superseded claim published `attached: false` was read as "parked".
// A detached lane mid-turn is exactly what a drain keeps, so the successor built a second runtime
// over a file the predecessor was still writing. A claim published under the strict-transfer
// contract stands for as long as its owner runs: the owner removes it itself once it parks.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDaemonPaths, type HostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { createSessionPathReservations, reservationFile } from "../../../src/modes/rpc/host-reservations.ts";
import { readProcessStartTime } from "../../../src/utils/process-identity.ts";
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

describe("a strict-transfer claim of a superseded generation", () => {
	it("stands while its owner runs, although no client is attached", async () => {
		const daemon = await daemonDirectory("detached-busy");
		const owner = await stranger();
		const sessionPath = join(daemon.root, "lane.jsonl");
		await writeClaim(daemon.paths, sessionPath, {
			instanceId: "draining",
			...owner,
			sessionPath,
			attached: false,
			strict_transfer: true,
		});
		await writePointer(daemon.paths, "successor");

		const successor = createSessionPathReservations({ daemonDir: daemon.paths.dir, instanceId: "successor" });

		expect(await successor.claim(sessionPath)).toMatchObject({
			instanceId: "draining",
			pid: owner.pid,
			current: false,
			strict_transfer: true,
		});
		expect(await readClaim(daemon.paths, sessionPath)).toMatchObject({ instanceId: "draining", pid: owner.pid });
	});

	it("is released once its owner is gone", async () => {
		const daemon = await daemonDirectory("owner-gone");
		const owner = await stranger();
		const sessionPath = join(daemon.root, "lane.jsonl");
		await writeClaim(daemon.paths, sessionPath, {
			instanceId: "draining",
			...owner,
			sessionPath,
			attached: false,
			strict_transfer: true,
		});
		await writePointer(daemon.paths, "successor");
		process.kill(owner.pid, "SIGKILL");
		await waitForPidGone(owner.pid, 20_000);

		const successor = createSessionPathReservations({ daemonDir: daemon.paths.dir, instanceId: "successor" });

		expect(await successor.claim(sessionPath)).toBeUndefined();
		expect(await readClaim(daemon.paths, sessionPath)).toMatchObject({ instanceId: "successor", pid: process.pid });
	});
});

describe("a claim this host publishes", () => {
	it("carries the strict-transfer contract, attached or detached", async () => {
		const daemon = await daemonDirectory("publish");
		const sessionPath = join(daemon.root, "mine.jsonl");
		const reservations = createSessionPathReservations({ daemonDir: daemon.paths.dir, instanceId: "mine" });

		expect(await reservations.claim(sessionPath, false)).toBeUndefined();

		expect(await readClaim(daemon.paths, sessionPath)).toMatchObject({
			instanceId: "mine",
			attached: false,
			strict_transfer: true,
		});
	});
});

interface DaemonScratch {
	readonly root: string;
	readonly paths: HostDaemonPaths;
}

async function daemonDirectory(label: string): Promise<DaemonScratch> {
	const root = realpathSync(await mkdtemp(join(tmpdir(), `s7098-${label}-`)));
	roots.push(root);
	const agentDir = join(root, "a");
	await mkdir(agentDir, { recursive: true });
	const paths = createHostDaemonPaths({ socket: join(root, "rpc.sock"), agentDir });
	await mkdir(paths.generationsDir, { recursive: true, mode: 0o700 });
	await mkdir(paths.reservationsDir, { recursive: true, mode: 0o700 });
	return { root, paths };
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

async function writeClaim(paths: HostDaemonPaths, sessionPath: string, owner: Record<string, unknown>): Promise<void> {
	await writeFile(reservationFile(paths.reservationsDir, sessionPath), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
}

async function readClaim(paths: HostDaemonPaths, sessionPath: string): Promise<Record<string, unknown> | undefined> {
	try {
		return JSON.parse(await readFile(reservationFile(paths.reservationsDir, sessionPath), "utf8"));
	} catch {
		return undefined;
	}
}

async function writePointer(paths: HostDaemonPaths, instanceId: string): Promise<void> {
	await writeFile(
		paths.pointerFile,
		`${JSON.stringify({ layout: 2, instance_id: instanceId, generation_dir: `generations/${instanceId}` })}\n`,
		{ mode: 0o600 },
	);
}
