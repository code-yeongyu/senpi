/**
 * What the operating system says about a running daemon: its resident memory, its open descriptors
 * and the children it has not reaped.
 *
 * The numbers describe the whole PROCESS TREE rooted at the registered pid, because that is what a
 * daemon costs: the pid a client can prove ownership of is the lifecycle SUPERVISOR, and the host
 * that holds every session is its child. Reporting only the supervisor would answer "3 MB" for a
 * daemon holding two gigabytes.
 *
 * The table itself is read through the kernel (`host-process-table.ts`), never by spawning `ps`:
 * a daemon-control surface polled at client cadence must not run one probe child per read - on a
 * runtime whose `execFile` does not reap, that is the #1507/omo-desktop#594 zombie machine, one
 * permanent defunct child per status request. Where the kernel reader is unavailable (Node,
 * unsupported platforms) every field is `null`, which means "this platform does not publish it
 * here" rather than zero: a status that reported 0 open descriptors on a platform it cannot count
 * them on would be worse than saying nothing. A failing read never fails the status - an operator
 * asking what a daemon is doing must still get its identity and its sessions.
 */
import { readdir } from "node:fs/promises";
import { loadProcessTableReader, type ProcessTableReader, type ProcessTableRow } from "./host-process-table.ts";

export interface HostProcessMetrics {
	/** Resident memory of the daemon's process tree, in megabytes; shared pages count once per process. */
	readonly rss_mb: number | null;
	/**
	 * Resident memory of the daemon's OWN processes - the lifecycle supervisor and the session host
	 * it runs - without the tools, kernels and servers its sessions spawned. It is the number `ps`
	 * shows for those pids and the one the host's memory sampler reads (senpi#2207).
	 */
	readonly host_rss_mb: number | null;
	/** Open descriptors across the tree. `/proc`-only, so `null` off Linux. */
	readonly open_fds: number | null;
	/** Processes in the tree that have exited and whose status nobody collected. */
	readonly zombies: number | null;
}

const UNOBSERVED: HostProcessMetrics = { rss_mb: null, host_rss_mb: null, open_fds: null, zombies: null };

/** Resolved once per platform; `undefined` on runtimes that cannot read the table without spawning. */
const readers = new Map<string, Promise<ProcessTableReader | undefined>>();

function tableReader(platform: NodeJS.Platform): Promise<ProcessTableReader | undefined> {
	const cached = readers.get(platform);
	if (cached !== undefined) return cached;
	const loading = loadProcessTableReader(platform);
	readers.set(platform, loading);
	return loading;
}

export async function readHostProcessMetrics(
	pid: number,
	platform: NodeJS.Platform = process.platform,
): Promise<HostProcessMetrics> {
	if (platform === "win32") return UNOBSERVED;
	const read = await tableReader(platform);
	if (read === undefined) return UNOBSERVED;
	const rows = read();
	if (rows === undefined) return UNOBSERVED;
	const tree = descendants(rows, pid);
	if (tree.length === 0) return UNOBSERVED;
	return {
		rss_mb: residentMegabytes(tree),
		host_rss_mb: residentMegabytes(tree.filter((row) => row.pid === pid || row.ppid === pid)),
		open_fds: platform === "linux" ? await openDescriptors(tree) : null,
		zombies: tree.filter((row) => row.state.startsWith("Z")).length,
	};
}

function residentMegabytes(rows: readonly ProcessTableRow[]): number {
	return Math.round(rows.reduce((total, row) => total + row.rssKb, 0) / KILOBYTES_PER_MEGABYTE);
}

function descendants(rows: readonly ProcessTableRow[], root: number): readonly ProcessTableRow[] {
	const tree = rows.filter((row) => row.pid === root);
	if (tree.length === 0) return tree;
	for (let index = 0; index < tree.length; index++) {
		const parent = tree[index].pid;
		for (const row of rows) {
			if (row.ppid === parent && !tree.includes(row)) tree.push(row);
		}
	}
	return tree;
}

const KILOBYTES_PER_MEGABYTE = 1024;

async function openDescriptors(tree: readonly ProcessTableRow[]): Promise<number | null> {
	let total = 0;
	let counted = false;
	for (const row of tree) {
		const entries = await readdir(`/proc/${row.pid}/fd`).catch(() => undefined);
		if (entries === undefined) continue;
		counted = true;
		total += entries.length;
	}
	return counted ? total : null;
}
