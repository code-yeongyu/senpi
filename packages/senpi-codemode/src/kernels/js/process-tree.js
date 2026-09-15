import { execFile } from "node:child_process";

// Plain JS (with process-tree.d.ts) because the worker runtime imports it and
// worker files cannot import TypeScript; the host imports the same module so a
// process tree is retired by one procedure wherever its owner is lost.

const PS_MAX_BUFFER = 16 * 1024 * 1024;
const EXIT_POLL_MS = 25;
const ZOMBIE_CHECK_INTERVAL_MS = 250;

export function isProcessAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isRecord(error) && error.code === "EPERM";
	}
}

export function signalProcess(pid, signal) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, signal);
		return true;
	} catch {
		return false;
	}
}

/**
 * Parent-to-children map of every process visible to `ps`. Windows has no
 * `ps`; callers there kill through `taskkill /T`, which walks the tree itself.
 */
export async function readProcessTable() {
	if (process.platform === "win32") return new Map();
	const stdout = await ps(["-axo", "pid=,ppid="]);
	const children = new Map();
	for (const line of stdout.split("\n")) {
		const [pidText, ppidText] = line.trim().split(/\s+/u);
		const pid = Number(pidText);
		const ppid = Number(ppidText);
		if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
		const siblings = children.get(ppid);
		if (siblings) siblings.push(pid);
		else children.set(ppid, [pid]);
	}
	return children;
}

export function collectDescendants(table, roots) {
	const seen = new Set(roots);
	const queue = [...roots];
	const descendants = [];
	while (queue.length > 0) {
		const parent = queue.shift();
		for (const child of table.get(parent) ?? []) {
			if (seen.has(child)) continue;
			seen.add(child);
			descendants.push(child);
			queue.push(child);
		}
	}
	return descendants;
}

/** Roots that `ps` still reports as direct children of `parentPid`; a reused pid belongs to someone else. */
export function ownedRoots(table, parentPid, roots) {
	const owned = new Set(table.get(parentPid) ?? []);
	return roots.filter((pid) => owned.has(pid));
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retire whole process trees: snapshot the descendants first (a parent that
 * dies before the snapshot would reparent them to init), SIGTERM everything,
 * wait `graceMs` for `settled` (or for the pids to disappear), then SIGKILL
 * whatever is left. On Windows `taskkill /T /F` does the walk and the kill.
 */
export async function terminateProcessTrees(roots, options) {
	const liveRoots = roots.filter(isProcessAlive);
	if (liveRoots.length === 0) return;
	if (process.platform === "win32") {
		for (const pid of liveRoots) await taskkillTree(pid);
		return;
	}
	const table = await readProcessTable();
	const owned = options.ownerPid === undefined ? liveRoots : ownedRoots(table, options.ownerPid, liveRoots);
	if (owned.length === 0) return;
	const targets = [...owned, ...collectDescendants(table, owned)];
	for (const pid of targets) signalProcess(pid, "SIGTERM");
	const survivors = await waitForExit(targets, options.graceMs, options.settled);
	if (survivors.length === 0) return;
	for (const pid of survivors) signalProcess(pid, "SIGKILL");
	await waitForExit(survivors, options.killWaitMs ?? options.graceMs, options.settled);
}

// `kill(pid, 0)` still succeeds for a zombie, and a child whose owning worker is
// blocked or gone is never reaped, so liveness also consults `ps` state.
async function waitForExit(pids, graceMs, settled) {
	const deadline = Date.now() + graceMs;
	let remaining = await withoutZombies(pids.filter(isProcessAlive));
	let nextZombieCheck = Date.now() + ZOMBIE_CHECK_INTERVAL_MS;
	while (remaining.length > 0 && Date.now() < deadline) {
		if (settled) {
			const outcome = await Promise.race([settled.then(() => "settled"), sleep(EXIT_POLL_MS).then(() => "tick")]);
			if (outcome === "settled") settled = undefined;
		} else {
			await sleep(EXIT_POLL_MS);
		}
		remaining = remaining.filter(isProcessAlive);
		if (remaining.length > 0 && Date.now() >= nextZombieCheck) {
			remaining = await withoutZombies(remaining);
			nextZombieCheck = Date.now() + ZOMBIE_CHECK_INTERVAL_MS;
		}
	}
	return remaining;
}

async function withoutZombies(pids) {
	if (pids.length === 0 || process.platform === "win32") return pids;
	const stdout = await ps(["-o", "pid=,stat=", "-p", pids.join(",")]);
	const zombies = new Set();
	for (const line of stdout.split("\n")) {
		const [pidText, stat] = line.trim().split(/\s+/u);
		if (typeof stat === "string" && stat.startsWith("Z")) zombies.add(Number(pidText));
	}
	return pids.filter((pid) => !zombies.has(pid));
}

// `ps -p` exits non-zero when any listed pid is gone but still prints the rest.
function ps(args) {
	return new Promise((resolve) => {
		execFile("ps", args, { maxBuffer: PS_MAX_BUFFER, windowsHide: true }, (_error, output) =>
			resolve(typeof output === "string" ? output : String(output ?? "")),
		);
	});
}

function taskkillTree(pid) {
	return new Promise((resolve) => {
		execFile("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true }, () => resolve());
	});
}

function isRecord(value) {
	return typeof value === "object" && value !== null;
}
