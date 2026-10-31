import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readSessionFence, sessionFenceFile } from "../../../src/core/session-write-fence.ts";
import { createHostDaemonPaths, type HostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { clearHostRegistration } from "../../../src/modes/rpc/host-daemon-registration.ts";
import { pruneDeadGenerations } from "../../../src/modes/rpc/host-generations.ts";
import { reservationFile } from "../../../src/modes/rpc/host-reservations.ts";
import { waitForPidGone } from "../../helpers/spawned-host-reaper.ts";

// desktop#3157 cycle-2 probe (run 39201740304): the host child's pid was reused by PING.EXE and its start
// time was never recorded. Pruning released the dead generation (its heartbeat had stopped) and removed its
// directory, heartbeat included, yet kept its session claim: with no heartbeat left, that claim then stood
// for as long as PING.EXE ran, and the new host refused the session as session_path_in_use.
const STALE_MS = 10 * 60_000;
const roots: string[] = [];
const strangers: number[] = [];

afterEach(async () => {
	for (const pid of strangers.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone; the wait still confirms it.
		}
		await waitForPidGone(pid, 20_000);
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function daemon(): Promise<{ readonly root: string; readonly paths: HostDaemonPaths }> {
	const root = await mkdtemp(join(tmpdir(), "prune-unproven-"));
	roots.push(root);
	await mkdir(join(root, "a"), { recursive: true });
	const paths = createHostDaemonPaths({ socket: join(root, "rpc.sock"), agentDir: join(root, "a") });
	await mkdir(paths.generationsDir, { recursive: true, mode: 0o700 });
	await mkdir(paths.reservationsDir, { recursive: true, mode: 0o700 });
	return { root, paths };
}

function stranger(): number {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
	if (child.pid === undefined) throw new Error("could not spawn a stranger process");
	strangers.push(child.pid);
	child.unref();
	return child.pid;
}

async function endedPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
	if (child.pid === undefined) throw new Error("could not spawn a process to end");
	child.kill("SIGKILL");
	await waitForPidGone(child.pid, 20_000);
	return child.pid;
}

async function json(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function generationWithDeadSupervisorAndRecycledChild(
	paths: HostDaemonPaths,
	instanceId: string,
	childPid: number,
): Promise<void> {
	const dir = join(paths.generationsDir, instanceId);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await json(join(dir, "host.pid"), {
		pid: await endedPid(),
		processStartTime: null,
		instance_id: instanceId,
		generation: 0,
	});
	await json(join(dir, "host-child.pid"), { pid: childPid, processStartTime: null });
	await json(join(dir, "host-alive.json"), { at: new Date(Date.now() - STALE_MS).toISOString() });
}

async function claim(paths: HostDaemonPaths, instanceId: string, pid: number, sessionPath: string): Promise<void> {
	await json(reservationFile(paths.reservationsDir, sessionPath), {
		instanceId,
		pid,
		processStartTime: null,
		sessionPath,
		attached: true,
	});
}

it("ends an unproven claim together with the generation it prunes, fencing the session file first", async () => {
	const { root, paths } = await daemon();
	const recycled = stranger();
	const sessionPath = join(root, "held.jsonl");
	await writeFile(sessionPath, "");
	await generationWithDeadSupervisorAndRecycledChild(paths, "dead", recycled);
	await claim(paths, "dead", recycled, sessionPath);

	const pruned = await pruneDeadGenerations(paths);

	expect(pruned.generations).toEqual(["dead"]);
	expect(pruned.claims).toEqual([sessionPath]);
	expect(existsSync(reservationFile(paths.reservationsDir, sessionPath))).toBe(false);
	expect(readSessionFence(sessionPath)).not.toBe("");
});

it("ends the unproven claims of the generation an ensure clears before starting a new host (cycle 3, run 39204446814)", async () => {
	const { root, paths } = await daemon();
	const recycled = stranger();
	const sessionPath = join(root, "held.jsonl");
	await writeFile(sessionPath, "");
	await generationWithDeadSupervisorAndRecycledChild(paths, "dead", recycled);
	await claim(paths, "dead", recycled, sessionPath);
	await json(paths.pointerFile, { layout: 2, instance_id: "dead", generation_dir: "generations/dead" });

	await clearHostRegistration(paths);

	expect(existsSync(join(paths.generationsDir, "dead"))).toBe(false);
	expect(existsSync(reservationFile(paths.reservationsDir, sessionPath))).toBe(false);
	expect(readSessionFence(sessionPath)).not.toBe("");
});

it("keeps an unproven claim whose generation this prune did not end", async () => {
	const { root, paths } = await daemon();
	const owner = stranger();
	const sessionPath = join(root, "held.jsonl");
	await claim(paths, "elsewhere", owner, sessionPath);

	const pruned = await pruneDeadGenerations(paths);

	expect(pruned.claims).toEqual([]);
	expect(JSON.parse(await readFile(reservationFile(paths.reservationsDir, sessionPath), "utf8"))).toMatchObject({
		instanceId: "elsewhere",
	});
	expect(existsSync(sessionFenceFile(sessionPath))).toBe(false);
});
