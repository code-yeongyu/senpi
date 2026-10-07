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
 * Kills every process whose command line names `root` and waits for each to disappear. A per-test
 * `mkdtemp` directory appears in no other process's argv, so this is exact rather than pattern-lucky.
 *
 * POSIX only: `pgrep` does not exist on win32, where these hosts serve named pipes and are reaped
 * through the fixture's own parent watch instead.
 */
export async function reapProcessesUnder(root: string, timeoutMs = 20_000): Promise<number[]> {
	if (process.platform === "win32") return [];
	// Descendants first, and they must be included at all: a supervisor's host child is named by its
	// own private socket rather than by this sandbox, yet it keeps writing INTO the sandbox (its agent
	// directory) until it notices its supervisor is gone - which can land after the removal below and
	// recreate the directory that was just deleted.
	const pids = withDescendants(processesUnder(root));
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	for (const pid of pids) await waitForPidGone(pid, timeoutMs);
	return pids;
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
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	// A process whose parent died before reaping it stays addressable as a ZOMBIE: it is gone,
	// only its exit status has not been collected, so a teardown must not wait for it.
	return !isZombie(pid);
}

function isZombie(pid: number): boolean {
	if (process.platform === "win32") return false;
	try {
		return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
			.trim()
			.startsWith("Z");
	} catch {
		// `ps` exits non-zero once the pid is gone entirely.
		return false;
	}
}
