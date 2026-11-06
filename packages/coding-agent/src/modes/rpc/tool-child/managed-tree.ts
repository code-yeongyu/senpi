/**
 * Every POSIX process a managed launch owns (senpi#4236 review M1). The launch's process group misses a descendant that
 * starts its own session (`setsid`, Node `detached: true`; Playwright starts Chromium that way), so a stop takes ONE
 * process-table snapshot before it signals anything and selects: the launch leader and its group while the leader's
 * start identity still matches, every process carrying the launch's marker variable, and the ppid descendants of all of
 * those. Each is signalled by exact pid, and escalation re-selects from a fresh snapshot by start identity.
 *
 * Limit: macOS hides the environment of Apple platform and hardened-runtime binaries, so such a descendant is found
 * only through a living selected ancestor; one that has also been reparented to launchd is not found.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { processStartTimeMs, sameProcessStartMs } from "../../../utils/process-identity.ts";

export const MANAGED_LAUNCH_MARKER_ENV = "SENPI_MANAGED_LAUNCH";

export interface TreeRow {
	readonly pid: number;
	readonly ppid: number;
	readonly pgid: number;
	readonly zombie: boolean;
	/** `ps -o lstart=` in the C locale, the form `readProcessStartTime` records. */
	readonly start: string;
	/** Every marker value in the process's environment; never read from its argv. */
	readonly markers: readonly string[];
}

export interface TreeProbes {
	/** One snapshot of the visible process table; `undefined` where this platform has no reader. */
	readonly scan: () => Promise<readonly TreeRow[] | undefined>;
	readonly signal: (pid: number, signal: NodeJS.Signals) => void;
	readonly wait: (ms: number) => Promise<void>;
}

export interface TreeRoot {
	readonly marker: string | undefined;
	/** The launch's group leader. Without `start` it is trusted only when it is this process. */
	readonly leader?: { readonly pid: number; readonly start?: string | undefined };
}

export interface TreeSweepOptions {
	readonly graceMs: number;
	readonly killWaitMs: number;
	readonly pollMs?: number;
	readonly firstSignal?: NodeJS.Signals;
}

/** The selected pids with the start identity each was selected under; `known` carries a previous selection forward. */
export function selectTree(
	rows: readonly TreeRow[],
	root: TreeRoot,
	known: ReadonlyMap<number, string> = new Map(),
): Map<number, string> {
	const live = rows.filter((row) => !row.zombie);
	const leaderRow = live.find((row) => row.pid === root.leader?.pid);
	const recorded = root.leader?.start;
	const leader =
		leaderRow !== undefined &&
		(recorded === undefined
			? leaderRow.pid === process.pid
			: sameProcessStartMs(processStartTimeMs(recorded), processStartTimeMs(leaderRow.start)))
			? leaderRow.pid
			: undefined;
	const owned = new Set(
		live
			.filter(
				(row) =>
					(leader !== undefined && (row.pid === leader || row.pgid === leader)) ||
					(root.marker !== undefined && row.markers.includes(root.marker)) ||
					known.get(row.pid) === row.start,
			)
			.map((row) => row.pid),
	);
	for (let grew = true; grew;) {
		grew = false;
		for (const row of live)
			if (!owned.has(row.pid) && owned.has(row.ppid)) {
				owned.add(row.pid);
				grew = true;
			}
	}
	return new Map(
		live
			.filter((row) => owned.has(row.pid) && row.pid > 1 && row.pid !== process.pid)
			.map((row) => [row.pid, row.start]),
	);
}

/** Signals the selected tree and returns the pids still running at the end, or `undefined` without a process table. */
export async function sweepTree(
	root: TreeRoot,
	options: TreeSweepOptions,
	probes: TreeProbes = defaultTreeProbes,
): Promise<number[] | undefined> {
	const rows = await probes.scan();
	if (rows === undefined) return undefined;
	let targets = selectTree(rows, root);
	for (const pid of targets.keys()) probes.signal(pid, options.firstSignal ?? "SIGTERM");
	targets = await drain(targets, root, options.graceMs, options.pollMs ?? 50, probes);
	for (const pid of targets.keys()) probes.signal(pid, "SIGKILL");
	targets = await drain(targets, root, options.killWaitMs, options.pollMs ?? 50, probes);
	return [...targets.keys()];
}

async function drain(
	targets: ReadonlyMap<number, string>,
	root: TreeRoot,
	budgetMs: number,
	pollMs: number,
	probes: TreeProbes,
): Promise<Map<number, string>> {
	const reselect = async () => selectTree((await probes.scan()) ?? [], root, targets);
	let remaining = await reselect();
	for (let waited = 0; remaining.size > 0 && waited < budgetMs; waited += pollMs) {
		await probes.wait(pollMs);
		remaining = await reselect();
	}
	return remaining;
}

const LSTART = String.raw`\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+`;
const PS_ROW = new RegExp(String.raw`^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(${LSTART})(?:\s(.*))?$`);
const PS_ARGV_ROW = new RegExp(String.raw`^\s*(\d+)\s+(${LSTART})(?:\s(.*))?$`);
const MARKER_PREFIX = `${MANAGED_LAUNCH_MARKER_ENV}=`;

interface TableRow {
	readonly pid: number;
	readonly ppid: number;
	readonly pgid: number;
	readonly zombie: boolean;
	readonly start: string;
	readonly command: string;
}

function parseTableRows(stdout: string): TableRow[] {
	const rows: TableRow[] = [];
	for (const line of stdout.split("\n")) {
		const match = PS_ROW.exec(line);
		if (match === null) continue;
		const [, pid = "", ppid = "", pgid = "", stat = "", start = "", command = ""] = match;
		rows.push({
			pid: Number(pid),
			ppid: Number(ppid),
			pgid: Number(pgid),
			zombie: stat.startsWith("Z"),
			start: start.replace(/\s+/g, " "),
			command,
		});
	}
	return rows;
}

/** Linux `/proc/<pid>/environ`: NUL-separated entries, so only a whole entry naming the marker counts. */
export function markersInEnviron(environ: string): string[] {
	return environ
		.split("\0")
		.filter((entry) => entry.startsWith(MARKER_PREFIX))
		.map((entry) => entry.slice(MARKER_PREFIX.length));
}

/**
 * macOS `ps -E` prints argv and then the environment in one column, so argv alone cannot be told apart from it. The
 * argv-only snapshot (same pid and start instant) is cut off first; a row whose `-E` text does not begin with its argv
 * (rewritten in between, or absent from one snapshot) yields no marker rather than a guess.
 */
export function parseDarwinTreeRows(withEnvironment: string, argvOnly: string): TreeRow[] {
	const argvs = new Map<number, { readonly start: string; readonly command: string }>();
	for (const line of argvOnly.split("\n")) {
		const match = PS_ARGV_ROW.exec(line);
		if (match === null) continue;
		const [, pid = "", start = "", command = ""] = match;
		argvs.set(Number(pid), { start: start.replace(/\s+/g, " "), command });
	}
	return parseTableRows(withEnvironment).map(({ command, ...row }) => {
		const argv = argvs.get(row.pid);
		const environment =
			argv !== undefined && argv.start === row.start && command.startsWith(argv.command)
				? command.slice(argv.command.length)
				: "";
		const markers = environment
			.split(/\s+/)
			.filter((entry) => entry.startsWith(MARKER_PREFIX))
			.map((entry) => entry.slice(MARKER_PREFIX.length));
		return { ...row, markers };
	});
}

function linuxMarkers(pid: number): string[] {
	try {
		return markersInEnviron(readFileSync(`/proc/${pid}/environ`, "latin1"));
	} catch {
		// Another user's process, or one that exited after the snapshot: it carries no marker of ours.
		return [];
	}
}

function runPs(args: readonly string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(
			"ps",
			[...args],
			{ env: { ...process.env, LC_ALL: "C", LANG: "C" }, maxBuffer: 64 * 1024 * 1024, timeout: 5_000 },
			(error, stdout) => resolve(error === null ? String(stdout) : undefined),
		);
	});
}

async function scanProcessTable(): Promise<readonly TreeRow[] | undefined> {
	if (process.platform === "linux") {
		const stdout = await runPs(["-A", "-ww", "-o", "pid=,ppid=,pgid=,stat=,lstart="]);
		return stdout === undefined
			? undefined
			: parseTableRows(stdout).map(({ command: _none, ...row }) => ({ ...row, markers: linuxMarkers(row.pid) }));
	}
	if (process.platform !== "darwin") return undefined;
	const [withEnvironment, argvOnly] = await Promise.all([
		runPs(["-A", "-E", "-ww", "-o", "pid=,ppid=,pgid=,stat=,lstart=,command="]),
		runPs(["-A", "-ww", "-o", "pid=,lstart=,command="]),
	]);
	return withEnvironment === undefined || argvOnly === undefined
		? undefined
		: parseDarwinTreeRows(withEnvironment, argvOnly);
}

export const defaultTreeProbes: TreeProbes = {
	scan: scanProcessTable,
	signal: (pid, signal) => {
		try {
			process.kill(pid, signal);
		} catch {
			// It exited between the snapshot and the signal.
		}
	},
	wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
