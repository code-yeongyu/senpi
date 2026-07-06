import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { safeDelay } from "./wrap.ts";

const execFileAsync = promisify(execFile);

export async function collectProcessTree(rootPid: number): Promise<number[]> {
	const seen = new Set<number>();
	const queue = [rootPid];
	for (let index = 0; index < queue.length; index++) {
		const pid = queue[index];
		if (seen.has(pid)) continue;
		seen.add(pid);
		for (const childPid of await childPids(pid)) {
			if (!seen.has(childPid)) queue.push(childPid);
		}
	}
	return [...seen];
}

export async function reapProcessTree(
	rootPid: number,
	options: { readonly termWaitMs: number; readonly killWaitMs: number },
): Promise<void> {
	const knownPids = new Set(await collectProcessTree(rootPid));
	if (!someProcessAlive(knownPids)) return;

	killPids(knownPids, "SIGTERM");
	await waitForDead(knownPids, options.termWaitMs);

	for (const pid of await collectProcessTree(rootPid)) knownPids.add(pid);
	if (!someProcessAlive(knownPids)) return;

	killPids(knownPids, "SIGKILL");
	await waitForDead(knownPids, options.killWaitMs);
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		ignoreExpectedProcessRace(error);
		return false;
	}
}

export function delay(ms: number): Promise<void> {
	return safeDelay(ms);
}

async function childPids(parentPid: number): Promise<number[]> {
	if (!["darwin", "linux"].includes(process.platform)) return [];
	try {
		const { stdout } = await execFileAsync("pgrep", ["-P", String(parentPid)], { timeout: 1000 });
		return stdout
			.split(/\s+/)
			.map(Number)
			.filter((pid) => Number.isInteger(pid) && pid > 0);
	} catch (error) {
		ignoreExpectedProcessRace(error);
		return [];
	}
}

function killPids(pids: Iterable<number>, signal: "SIGTERM" | "SIGKILL"): void {
	for (const pid of [...pids].reverse()) {
		try {
			process.kill(pid, signal);
		} catch (error) {
			ignoreExpectedProcessRace(error);
		}
	}
}

async function waitForDead(pids: Iterable<number>, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!someProcessAlive(pids)) return;
		await delay(25);
	}
}

function someProcessAlive(pids: Iterable<number>): boolean {
	for (const pid of pids) {
		if (isProcessAlive(pid)) return true;
	}
	return false;
}

function ignoreExpectedProcessRace(error: unknown): void {
	void error;
}
