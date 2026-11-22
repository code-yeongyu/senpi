// Regression for senpi issue #1911: pruning a pointer that named a dead generation left the live
// registered generation ownerless, so `host stop` / `host handoff` refused with `unknown_owner`. The
// prune also removed the pointer it had read earlier without looking again, so a registration that
// replaced it in between lost its pointer too.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDaemonPaths, type HostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { readHostRegistration } from "../../../src/modes/rpc/host-daemon-registration.ts";
import { pruneDeadGenerations } from "../../../src/modes/rpc/host-generations.ts";
import { readHostStatus } from "../../../src/modes/rpc/host-status.ts";
import { readProcessStartTime } from "../../../src/utils/process-identity.ts";
import { waitForPidGone } from "../../helpers/spawned-host-reaper.ts";

type PruneWithSeam = (
	paths: HostDaemonPaths,
	options: { readonly _test: { readonly beforePointerRemoval: () => Promise<void> } },
) => Promise<unknown>;
const pruneWithSeam: PruneWithSeam = pruneDeadGenerations;

const roots: string[] = [];
const owned: number[] = [];

afterEach(async () => {
	for (const pid of owned.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone; the wait below still confirms it.
		}
		await waitForPidGone(pid, 20_000);
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("the pointer of a daemon directory whose generation died", () => {
	it("survives a registration that replaced it while the prune ran", async () => {
		const daemon = await daemonDirectory("race");
		await writeGeneration(daemon, "gone", await endedPid(), null);
		const live = await liveProcess();
		await writeGeneration(daemon, "next", live.pid, live.processStartTime);
		await writePointer(daemon.paths, "gone");
		let replaced = false;

		await pruneWithSeam(daemon.paths, {
			_test: {
				// The interleaving the issue names: an ensure registers `next` after the prune read the old pointer.
				beforePointerRemoval: async () => {
					await writePointer(daemon.paths, "next", `${daemon.paths.pointerFile}.racer`);
					await rename(`${daemon.paths.pointerFile}.racer`, daemon.paths.pointerFile);
					replaced = true;
				},
			},
		});

		expect(replaced).toBe(true);
		expect(JSON.parse(await readFile(daemon.paths.pointerFile, "utf8"))).toMatchObject({ instance_id: "next" });
		expect((await readHostRegistration(daemon.paths))?.instanceId).toBe("next");
	});

	it("is not elected when two live generations could own the socket, and says so", async () => {
		const daemon = await daemonDirectory("two");
		await writeGeneration(daemon, "gone", await endedPid(), null);
		for (const instanceId of ["left", "right"]) {
			const live = await liveProcess();
			await writeGeneration(daemon, instanceId, live.pid, live.processStartTime);
		}
		await writePointer(daemon.paths, "gone");

		const status = await readHostStatus({ socket: daemon.socket, agentDir: daemon.agentDir });

		expect(status).toMatchObject({ pointer: { state: "missing", instanceId: null, candidates: ["left", "right"] } });
		expect(await readFile(daemon.paths.pointerFile, "utf8").catch(() => undefined)).toBeUndefined();
		expect(await readHostRegistration(daemon.paths)).toBeUndefined();
	});

	it("is not given to a live generation that is being stopped", async () => {
		const daemon = await daemonDirectory("stopping");
		const live = await liveProcess();
		await writeGeneration(daemon, "stopping", live.pid, live.processStartTime);
		await writeFile(
			join(daemon.paths.generationsDir, "stopping", "stop-intent.json"),
			`${JSON.stringify({ targetPid: live.pid, reason: "operator_stop", signal: "SIGTERM" })}\n`,
			{ mode: 0o600 },
		);

		const status = await readHostStatus({ socket: daemon.socket, agentDir: daemon.agentDir });

		expect(status).toMatchObject({ pointer: { state: "missing", instanceId: null, candidates: [] } });
		expect(await readHostRegistration(daemon.paths)).toBeUndefined();
	});
});

interface DaemonScratch {
	readonly agentDir: string;
	readonly socket: string;
	readonly paths: HostDaemonPaths;
}

async function daemonDirectory(label: string): Promise<DaemonScratch> {
	const root = realpathSync(await mkdtemp(join(tmpdir(), `sg1911-${label}-`)));
	roots.push(root);
	const agentDir = join(root, "a");
	const socket = join(root, "rpc.sock");
	await mkdir(agentDir, { recursive: true });
	const paths = createHostDaemonPaths({ socket, agentDir });
	await mkdir(paths.generationsDir, { recursive: true, mode: 0o700 });
	await mkdir(paths.reservationsDir, { recursive: true, mode: 0o700 });
	return { agentDir, socket, paths };
}

/** A live process whose identity the test can prove, standing in for a generation's supervisor. */
async function liveProcess(): Promise<{ pid: number; processStartTime: string }> {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
	const pid = child.pid;
	if (pid === undefined) throw new Error("could not spawn a live process");
	owned.push(pid);
	child.unref();
	const processStartTime = await readProcessStartTime(pid);
	if (processStartTime === undefined) throw new Error("the live process has no readable start time");
	return { pid, processStartTime };
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

async function writeGeneration(
	daemon: DaemonScratch,
	instanceId: string,
	pid: number,
	processStartTime: string | null,
): Promise<void> {
	const dir = join(daemon.paths.generationsDir, instanceId);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const record = { pid, processStartTime, instance_id: instanceId, generation: 0, socket: daemon.socket };
	await writeFile(join(dir, "host.pid"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

async function writePointer(paths: HostDaemonPaths, instanceId: string, file = paths.pointerFile): Promise<void> {
	const pointer = { layout: 2, instance_id: instanceId, generation_dir: `generations/${instanceId}` };
	await writeFile(file, `${JSON.stringify(pointer)}\n`, { mode: 0o600 });
}
