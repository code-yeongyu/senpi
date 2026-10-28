/**
 * Teardown for test hosts that outlive the handle that started them.
 *
 * A suite can always kill the child it spawned, but these tests also make PRODUCTION code spawn
 * hosts: `ensureHost` detaches its child and hands back only a pid, and some cases deliberately
 * leave a registration the teardown cannot act on (an unguarded pidfile, a failed ensure that
 * cleaned its own state). Nothing in the suite holds those processes, so "kill the children I
 * remember" leaves them running - measured: fixture hosts alive for hours, long after the temp
 * directories they were started in were gone.
 *
 * Every host a case can start is named after its own sandbox directory (the socket path is inside
 * it), so the sandbox is the reliable handle: reap by argv, then wait until the pid is really gone
 * before the directory is removed.
 */
import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { once } from "node:events";

/** Terminates one spawned child and WAITS for its exit, so teardown cannot outrun it. */
export async function killAndWait(child: ChildProcess, timeoutMs = 20_000): Promise<void> {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit", { signal: AbortSignal.timeout(timeoutMs) }).catch(() => undefined);
	try {
		child.kill("SIGKILL");
	} catch {
		// ESRCH: it exited between the liveness check and the signal.
	}
	await exited;
}

/**
 * Kills every process whose command line names `root` - AND every descendant of those processes -
 * then waits for each to disappear. A per-test `mkdtemp` directory appears in no other process's
 * argv, so the argv half is exact rather than pattern-lucky; the descendant half catches the
 * children those processes spawned under names of their own (a supervisor's host child binds its
 * own private socket, so the sandbox never appears in its argv).
 *
 * POSIX only: `pgrep` does not exist on win32, where these hosts serve named pipes and are reaped
 * through the fixture's own parent watch instead.
 */
export async function reapProcessesUnder(root: string, timeoutMs = 20_000): Promise<number[]> {
	return reapSpawnedHosts({ roots: [root] }, timeoutMs);
}

/** What one teardown owns: the handles it spawned itself and the sandbox directories they were started in. */
export interface SpawnedHostScope {
	readonly children?: readonly ChildProcess[];
	readonly roots?: readonly string[];
}

/**
 * Every pid this teardown must outlive, taken BEFORE anything is signalled.
 *
 * Order matters, not just membership: a supervisor's host child is named by its own private socket
 * rather than by the sandbox, so argv cannot find it, and the moment its supervisor is killed it is
 * re-parented away and stops being a descendant of anything the suite remembers. Killing first and
 * looking afterwards therefore loses it - while it keeps writing INTO the sandbox (its agent
 * directory) until it notices its supervisor is gone, which can land after the removal and recreate
 * the directory that was just deleted (ENOTEMPTY).
 */
export function collectSpawnedHosts(scope: SpawnedHostScope): number[] {
	if (process.platform === "win32") return [];
	// An already-exited handle is skipped, never collected: its pid can have been reused by an
	// unrelated process on a shared host, and the kill below would take that tree down instead.
	const handles = (scope.children ?? [])
		.filter((child) => child.exitCode === null && child.signalCode === null)
		.map((child) => child.pid)
		.filter((pid): pid is number => pid !== undefined && pid !== process.pid);
	const named = (scope.roots ?? []).flatMap((root) => processesUnder(root));
	return withDescendants([...handles, ...named]);
}

/**
 * Kills a snapshot from `collectSpawnedHosts` - plus anything that appeared under the roots since -
 * and waits for every pid to disappear, so the caller's removal cannot outrun a late writer.
 */
export async function reapCollectedHosts(
	collected: readonly number[],
	scope: SpawnedHostScope,
	timeoutMs = 20_000,
): Promise<number[]> {
	if (process.platform === "win32") {
		for (const child of scope.children ?? []) await killAndWait(child, timeoutMs);
		return [];
	}
	const pids = [...new Set([...collected, ...collectSpawnedHosts(scope)])];
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	// The handles the suite spawned publish an exit event; awaiting it also reaps them as children.
	for (const child of scope.children ?? []) await killAndWait(child, timeoutMs);
	for (const pid of pids) await waitForPidGone(pid, timeoutMs);
	return pids;
}

/** Collect-then-kill in one step, for teardowns with nothing to do between the two halves. */
export async function reapSpawnedHosts(scope: SpawnedHostScope, timeoutMs = 20_000): Promise<number[]> {
	return reapCollectedHosts(collectSpawnedHosts(scope), scope, timeoutMs);
}

/** `pids` plus every process descending from them, children before parents. */
function withDescendants(pids: readonly number[]): number[] {
	const ordered: number[] = [];
	const visit = (pid: number): void => {
		if (ordered.includes(pid)) return;
		for (const child of childrenOf(pid)) visit(child);
		ordered.push(pid);
	};
	for (const pid of pids) visit(pid);
	return ordered;
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

export function processesUnder(root: string): number[] {
	try {
		return execFileSync("pgrep", ["-f", root], { encoding: "utf8" })
			.split("\n")
			.map((line) => Number(line.trim()))
			.filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
	} catch {
		// pgrep exits non-zero when nothing matches, which is the ordinary outcome.
		return [];
	}
}

/** A pid we did not spawn publishes no exit event, so liveness is the one bounded poll here. */
export async function waitForPidGone(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (!processAlive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return !processAlive(pid);
}

export function processAlive(pid: number): boolean {
	if (process.platform === "win32") {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}
	// Use one snapshot: a zombie can be reaped between kill(pid, 0) and ps (#3044).
	// Both a zombie and a now-absent PID mean the observed process has exited.
	try {
		const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
		return state.length > 0 && !state.startsWith("Z");
	} catch (cause) {
		if (cause instanceof Error && "status" in cause && cause.status === 1) return false;
		throw cause;
	}
}
