/**
 * Collecting an endpoint directory nothing names - a husk (senpi#7564). `listHostEndpoints` reports one with
 * `socket: null`: the ensure lock is keyed by a longer hash of the socket than the directory name, so no gc can take it
 * and `gcEndpoint`'s locked evidence never applies. Unknown identity alone never condemns a directory; a husk is
 * collected only when ALL of these hold, read cheapest first:
 *
 * 1. nothing in it names a socket (`endpoint.json` / `settings.json` anywhere: then it is no husk, whatever it holds);
 * 2. its whole tree - every entry and the directory itself - is older than `HUSK_HORIZON_MS`;
 * 3. every process record in it (each `*.pid`, `owner.json`, and every claim under `reservations/`) names a process
 *    that is not running; a record that cannot be read counts as live.
 *
 * Without a lock the removal is made atomic instead: the directory is renamed to `.reap-<name>-<pid>` (not 16-hex, so
 * no reader lists it), the evidence is read again inside the moved tree, and only then is it deleted. A tree that no
 * longer qualifies - an ensure registered the endpoint between the first read and the rename - is renamed back.
 */
import { lstat, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
	type DaemonPidFile,
	ProcessIdentityUnreadableError,
	parseDaemonPidFile,
	processMatchesPidFile,
} from "../../utils/process-identity.ts";
import { parseJson } from "./host-daemon-state.ts";

/** 14 days: the crash-report window, so a husk's `crashes.jsonl` is past the point where any record in it is sent. */
export const HUSK_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;

export type HuskPidRecord = DaemonPidFile;

export interface HuskProbe {
	readonly now: () => number;
	/** Whether the process a record names is running; the default proves it by pid and start time. */
	readonly pidLive: (record: HuskPidRecord) => Promise<boolean>;
	readonly _test?: {
		/** Runs between the rename and the second read of the evidence. */
		readonly afterMove?: (moved: string) => Promise<void>;
	};
}

const REAP_PREFIX = ".reap-";

/** Live and still the recorded process; a live pid whose identity cannot be read counts as live. */
export async function processRecordLive(record: HuskPidRecord): Promise<boolean> {
	try {
		return await processMatchesPidFile(record);
	} catch (error: unknown) {
		if (error instanceof ProcessIdentityUnreadableError) return true;
		throw error;
	}
}

function probeOf(options: Partial<HuskProbe>): HuskProbe {
	return { ...options, now: options.now ?? Date.now, pidLive: options.pidLive ?? processRecordLive };
}

/** `true` when the husk at `dir` was removed, `false` when it is kept; throws only on a filesystem failure. */
export async function reapHusk(dir: string, options: Partial<HuskProbe> = {}): Promise<boolean> {
	const probe = probeOf(options);
	if (!(await collectable(dir, probe))) return false;
	const moved = join(dirname(dir), `${REAP_PREFIX}${basename(dir)}-${process.pid}`);
	await rename(dir, moved);
	await probe._test?.afterMove?.(moved);
	if (!(await collectable(moved, probe))) {
		await rename(moved, dir);
		return false;
	}
	await rm(moved, { recursive: true, force: true });
	return true;
}

/**
 * A `.reap-<name>-<pid>` tree its reaper left by dying between the rename and the delete: deleted when it still
 * qualifies, otherwise renamed back to `<name>` when that is free. A live reaper's is never touched.
 */
export async function sweepReapLeftovers(flatDir: string, options: Partial<HuskProbe> = {}): Promise<void> {
	const probe = probeOf(options);
	for (const name of await readdir(flatDir).catch(() => [] as string[])) {
		const match = /^\.reap-([0-9a-f]{16})-(\d+)$/.exec(name);
		if (match?.[1] === undefined || match[2] === undefined) continue;
		if (await probe.pidLive({ pid: Number(match[2]), processStartTime: null })) continue;
		const leftover = join(flatDir, name);
		if (await collectable(leftover, probe)) await rm(leftover, { recursive: true, force: true });
		else await rename(leftover, join(flatDir, match[1])).catch(() => undefined);
	}
}

async function collectable(dir: string, probe: HuskProbe): Promise<boolean> {
	const evidence = await readEvidence(dir);
	if (evidence.named || probe.now() - evidence.newestMtimeMs <= HUSK_HORIZON_MS) return false;
	for (const record of evidence.records) {
		if (record === "unreadable" || (await probe.pidLive(record))) return false;
	}
	return true;
}

interface HuskEvidence {
	readonly named: boolean;
	readonly newestMtimeMs: number;
	readonly records: readonly (HuskPidRecord | "unreadable")[];
}

async function readEvidence(dir: string): Promise<HuskEvidence> {
	let named = false;
	let newestMtimeMs = (await lstat(dir)).mtimeMs;
	const records: (HuskPidRecord | "unreadable")[] = [];
	const visit = async (path: string, claims: boolean): Promise<void> => {
		for (const entry of await readdir(path, { withFileTypes: true })) {
			const child = join(path, entry.name);
			newestMtimeMs = Math.max(newestMtimeMs, (await lstat(child)).mtimeMs);
			if (entry.isDirectory()) {
				await visit(child, path === dir && entry.name === "reservations");
				continue;
			}
			if (entry.name === "endpoint.json" || entry.name === "settings.json") named = true;
			if (entry.name.endsWith(".pid") || entry.name === "owner.json" || (claims && entry.name.endsWith(".json"))) {
				records.push(processRecordOf(await readFile(child, "utf8")));
			}
		}
	};
	await visit(dir, false);
	return { named, newestMtimeMs, records };
}

/** A record whose identity guard does not parse still names a pid, read unguarded; one naming no pid is unreadable. */
function processRecordOf(text: string): HuskPidRecord | "unreadable" {
	const record = parseDaemonPidFile(text);
	if (record !== undefined) return record;
	const pid = parseJson(text)?.pid;
	return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? { pid, processStartTime: null } : "unreadable";
}
