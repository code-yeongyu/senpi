/**
 * Unix-socket counts of a host process, for the suites that prove a host releases what it accepted
 * (oh-my-openagent#14725). A count read across a process boundary publishes no event, so `settledAt`
 * re-reads it until it reaches the target or the deadline passes, and returns the last reading.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readlinkSync } from "node:fs";

export function unixSockets(pid: number): number {
	if (process.platform === "linux")
		return readdirSync(`/proc/${pid}/fd`).filter((fd) => {
			try {
				return readlinkSync(`/proc/${pid}/fd/${fd}`).startsWith("socket:");
			} catch {
				return false;
			}
		}).length;
	const listing = execFileSync("lsof", ["-n", "-P", "-a", "-U", "-p", String(pid)], { encoding: "utf8" });
	return Math.max(0, listing.trim().split("\n").length - 1);
}

export async function settledAt(pid: number, target: number, deadlineMs = 10_000): Promise<number> {
	const deadline = performance.now() + deadlineMs;
	let count = unixSockets(pid);
	while (count > target && performance.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		count = unixSockets(pid);
	}
	return count;
}

/** The host child a supervisor runs: its one child process. */
export function hostChildOf(supervisor: number): number {
	const pid = Number(execFileSync("pgrep", ["-P", String(supervisor)], { encoding: "utf8" }).split("\n")[0]);
	if (!Number.isInteger(pid) || pid <= 0) throw new Error(`supervisor ${supervisor} has no child`);
	return pid;
}
