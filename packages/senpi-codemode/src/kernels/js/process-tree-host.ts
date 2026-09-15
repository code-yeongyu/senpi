import { execFile } from "node:child_process";

// Host-side twin of worker-runtime's `process-tree.js`. The worker file must stay plain
// JavaScript (a Node worker thread spawned from a `.js` entry has no TypeScript loader), and
// `check-ts-relative-imports` forbids a `.ts` file from importing a `.js` one, so the host
// keeps its own copy the way `worker-core.js` mirrors `reserved.ts` constants. Keep the two in
// sync when either changes.

export interface TerminateProcessTreesOptions {
	readonly graceMs: number;
	readonly killWaitMs?: number;
	// When set, only roots `ps` still lists as direct children of this pid are signalled, so a
	// reused pid belonging to another process is never killed.
	readonly ownerPid?: number;
}

const PS_MAX_BUFFER = 16 * 1024 * 1024;
const EXIT_POLL_MS = 25;
const ZOMBIE_CHECK_INTERVAL_MS = 250;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null;
}

export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isRecord(error) && error.code === "EPERM";
	}
}

export function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, signal);
		return true;
	} catch {
		return false;
	}
}

// `ps -p` exits non-zero when any listed pid is gone but still prints the rest.
function ps(args: readonly string[]): Promise<string> {
	return new Promise((resolve) => {
		execFile("ps", [...args], { maxBuffer: PS_MAX_BUFFER, windowsHide: true }, (_error, output) =>
			resolve(typeof output === "string" ? output : String(output ?? "")),
		);
	});
}

export async function readProcessTable(): Promise<Map<number, number[]>> {
	const children = new Map<number, number[]>();
	if (process.platform === "win32") return children;
	const stdout = await ps(["-axo", "pid=,ppid="]);
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

export function collectDescendants(table: ReadonlyMap<number, readonly number[]>, roots: readonly number[]): number[] {
	const seen = new Set<number>(roots);
	const queue = [...roots];
	const descendants: number[] = [];
	while (queue.length > 0) {
		const parent = queue.shift();
		if (parent === undefined) break;
		for (const child of table.get(parent) ?? []) {
			if (seen.has(child)) continue;
			seen.add(child);
			descendants.push(child);
			queue.push(child);
		}
	}
	return descendants;
}

export function ownedRoots(
	table: ReadonlyMap<number, readonly number[]>,
	parentPid: number,
	roots: readonly number[],
): number[] {
	const owned = new Set(table.get(parentPid) ?? []);
	return roots.filter((pid) => owned.has(pid));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retire whole process trees: snapshot the descendants first (a parent that dies before the
 * snapshot would reparent them to init), SIGTERM everything, wait `graceMs` for the pids to
 * disappear, then SIGKILL whatever is left. On Windows `taskkill /T /F` does the walk and the kill.
 */
export async function terminateProcessTrees(
	roots: readonly number[],
	options: TerminateProcessTreesOptions,
): Promise<void> {
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
	const survivors = await waitForExit(targets, options.graceMs);
	if (survivors.length === 0) return;
	for (const pid of survivors) signalProcess(pid, "SIGKILL");
	await waitForExit(survivors, options.killWaitMs ?? options.graceMs);
}

// `kill(pid, 0)` still succeeds for a zombie, and a child whose owning worker is blocked or
// gone is never reaped, so liveness also consults `ps` state.
async function waitForExit(pids: readonly number[], graceMs: number): Promise<number[]> {
	const deadline = Date.now() + graceMs;
	let remaining = await withoutZombies(pids.filter(isProcessAlive));
	let nextZombieCheck = Date.now() + ZOMBIE_CHECK_INTERVAL_MS;
	while (remaining.length > 0 && Date.now() < deadline) {
		await sleep(EXIT_POLL_MS);
		remaining = remaining.filter(isProcessAlive);
		if (remaining.length > 0 && Date.now() >= nextZombieCheck) {
			remaining = await withoutZombies(remaining);
			nextZombieCheck = Date.now() + ZOMBIE_CHECK_INTERVAL_MS;
		}
	}
	return remaining;
}

async function withoutZombies(pids: number[]): Promise<number[]> {
	if (pids.length === 0 || process.platform === "win32") return pids;
	const stdout = await ps(["-o", "pid=,stat=", "-p", pids.join(",")]);
	const zombies = new Set<number>();
	for (const line of stdout.split("\n")) {
		const [pidText, stat] = line.trim().split(/\s+/u);
		if (typeof stat === "string" && stat.startsWith("Z")) zombies.add(Number(pidText));
	}
	return pids.filter((pid) => !zombies.has(pid));
}

function taskkillTree(pid: number): Promise<void> {
	return new Promise((resolve) => {
		execFile("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true }, () => resolve());
	});
}
