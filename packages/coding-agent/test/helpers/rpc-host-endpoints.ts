/**
 * Fixtures for the multi-endpoint suites (`host status --all`, and the evidence-gated gc that builds
 * on it): the one deterministic way to leave an endpoint's registration STALE, and a byte-exact
 * snapshot of a daemon directory to prove a reader changed nothing.
 *
 * Stale state is harder to produce than it looks. A supervised host's own watchdog removes the
 * pointer, the generation pidfile and `settings.json` the moment its supervisor's lifetime pipe
 * closes, and the supervisor releases them itself on every signal it can handle - so "SIGKILL the
 * supervisor" leaves a CLEAN directory. `killEndpointUnclean` instead freezes the supervisor
 * (SIGSTOP: it can no longer observe or react), kills its host child, waits for that exit, and only
 * then SIGKILLs the frozen supervisor, which cannot run `releaseGeneration`. It then asserts the
 * stale files exist and throws when they do not, so a caller can never proceed on a clean directory
 * it mistook for a stale one.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHostDaemonPaths } from "../../src/modes/rpc/host-daemon-paths.ts";
import { processAlive, waitForPidGone } from "./spawned-host-reaper.ts";

export interface UncleanEndpointDeath {
	readonly supervisorPid: number;
	readonly hostPids: readonly number[];
	readonly instanceId: string;
	/** The frozen supervisor's private hop directories under the temp dir; the caller removes them. */
	readonly internalDirs: readonly string[];
}

export async function killEndpointUnclean(socket: string, agentDir: string): Promise<UncleanEndpointDeath> {
	if (process.platform === "win32") throw new Error("killEndpointUnclean needs POSIX job control");
	const paths = createHostDaemonPaths({ socket, agentDir });
	const pointer = JSON.parse(await readFile(paths.pointerFile, "utf8")) as Record<string, unknown>;
	const instanceId = String(pointer.instance_id);
	const pidFile = join(paths.generationsDir, instanceId, "host.pid");
	const supervisorPid = Number((JSON.parse(await readFile(pidFile, "utf8")) as Record<string, unknown>).pid);
	const hostPids = childrenOf(supervisorPid);
	if (hostPids.length === 0) throw new Error(`supervisor ${supervisorPid} has no host child to kill`);
	const internalDirs = await internalDirsOwnedBy(supervisorPid);
	process.kill(supervisorPid, "SIGSTOP");
	for (const pid of hostPids) process.kill(pid, "SIGKILL");
	for (const pid of hostPids) {
		if (!(await waitForPidGone(pid, 20_000))) throw new Error(`host child ${pid} survived SIGKILL`);
	}
	process.kill(supervisorPid, "SIGKILL");
	if (!(await waitForPidGone(supervisorPid, 20_000))) throw new Error(`supervisor ${supervisorPid} survived SIGKILL`);
	await assertStale(paths.pointerFile, pidFile, paths.settingsFile, supervisorPid);
	return { supervisorPid, hostPids, instanceId, internalDirs };
}

/** Every entry under `root`, relative path -> sha256 of its bytes (or its type), sorted. */
export async function daemonTreeDigest(root: string): Promise<Record<string, string>> {
	const digest: Record<string, string> = {};
	const visit = async (dir: string): Promise<void> => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			const key = relative(root, path);
			if (entry.isDirectory()) {
				digest[`${key}/`] = "dir";
				await visit(path);
			} else if (entry.isFile()) {
				digest[key] = createHash("sha256")
					.update(await readFile(path))
					.digest("hex");
			} else {
				digest[key] = "other";
			}
		}
	};
	await visit(root);
	return Object.fromEntries(Object.entries(digest).sort(([left], [right]) => left.localeCompare(right)));
}

async function assertStale(pointer: string, pidFile: string, settings: string, deadPid: number): Promise<void> {
	for (const path of [pointer, pidFile, settings]) {
		await stat(path).catch(() => {
			throw new Error(`stale-state fixture failed: ${path} is missing after the unclean death`);
		});
	}
	if (processAlive(deadPid)) throw new Error(`stale-state fixture failed: pid ${deadPid} is still running`);
}

async function internalDirsOwnedBy(pid: number): Promise<string[]> {
	const owned: string[] = [];
	for (const name of await readdir(tmpdir()).catch(() => [] as string[])) {
		if (!name.startsWith("senpi-rpc-host-internal-")) continue;
		const owner = await readFile(join(tmpdir(), name, ".owner"), "utf8").catch(() => "");
		if (owner.includes(`"pid":${pid},`)) owned.push(join(tmpdir(), name));
	}
	return owned;
}

export async function removeInternalDirs(dirs: readonly string[]): Promise<void> {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
}

function childrenOf(pid: number): number[] {
	try {
		return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
			.split("\n")
			.map((line) => Number(line.trim()))
			.filter((child) => Number.isInteger(child) && child > 0);
	} catch {
		return [];
	}
}
