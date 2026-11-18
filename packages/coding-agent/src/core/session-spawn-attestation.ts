/**
 * Which session spawned a process, attested by the process that spawned it (senpi#6972).
 *
 * Every session of a shared rpc host runs its tool commands as children of ONE host process, so the kernel ancestry
 * of a caller proves the host, not the session, and the caller's `PI_SESSION_ID` is whatever its last `exec` said.
 * The spawner therefore records each child it starts for a session in `<agentDir>/session-spawns/<pid>.json`:
 * the child's pid and kernel start time, the session id, and the spawner's own pid and start time. A child pid cannot
 * be reused before its parent reaps it, so the start time read after the spawn is the child's.
 *
 * `resolvePidSession` answers "which session owns pid P" from the kernel alone: it walks P's ppid chain to the nearest
 * ancestor with a record and believes that record only when the ancestor's start time, its parent and that parent's
 * start time all match. An environment is never read. Anything outside a recorded child's tree (a daemon re-parented
 * to init, a child an in-process runtime spawned directly) is `attested: false`.
 *
 * The record lands a few event-loop turns after the spawn; it does not gate the command. Same-uid processes can write
 * the agent directory, as they can every other record under it, so this proves against a forged environment and a
 * recycled pid, not against deliberate tampering with the store.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { type KernelProcessIdentity, readKernelProcessIdentity } from "./kernel-process-identity.ts";

export const SESSION_SPAWNS_DIR = "session-spawns";
const RECORD_VERSION = 1;
/** Deeper than any tool's process tree; bounds a walk over a corrupted table. */
const MAX_ANCESTRY_DEPTH = 64;

export interface SessionSpawnRecord {
	readonly version: typeof RECORD_VERSION;
	readonly pid: number;
	readonly startedAtMs: number;
	readonly sessionId: string;
	readonly hostPid: number;
	readonly hostStartedAtMs: number;
}

export type PidSession =
	| {
			readonly attested: true;
			readonly pid: number;
			readonly sessionId: string;
			/** The recorded child on `pid`'s ancestry (`pid` itself when it is that child). */
			readonly attestedPid: number;
			/** The process that spawned `attestedPid` and wrote its record. */
			readonly hostPid: number;
			/** `pid` up to `attestedPid`, child first. */
			readonly chain: readonly number[];
	  }
	| {
			readonly attested: false;
			readonly pid: number;
			readonly reason: "process_not_found" | "no_attested_ancestor";
	  };

export interface SessionSpawnAttestation {
	/** Settles once the record is written; false when the child could not be identified (already gone). */
	readonly recorded: Promise<boolean>;
	/** Removes the record; call it once the child exited. */
	release(): Promise<void>;
}

export interface SessionSpawnStoreOptions {
	/** The record directory. Default: `<agentDir>/session-spawns`. */
	readonly dir?: string;
}

export function sessionSpawnsDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, SESSION_SPAWNS_DIR);
}

let ownIdentity: Promise<KernelProcessIdentity | undefined> | undefined;

/** Records that `pid`, a child this process just spawned, runs for `sessionId`. Never throws. */
export function attestSessionSpawn(
	sessionId: string,
	pid: number,
	options: SessionSpawnStoreOptions = {},
): SessionSpawnAttestation {
	const dir = options.dir ?? sessionSpawnsDir();
	const path = join(dir, `${pid}.json`);
	const recorded = writeRecord(dir, path, sessionId, pid).catch(() => false);
	return {
		recorded,
		async release() {
			if (await recorded) await unlink(path).catch(() => undefined);
		},
	};
}

async function writeRecord(dir: string, path: string, sessionId: string, pid: number): Promise<boolean> {
	const [child, host] = await Promise.all([
		readKernelProcessIdentity(pid),
		(ownIdentity ??= readKernelProcessIdentity(process.pid)),
	]);
	if (child === undefined || host === undefined || child.ppid !== process.pid) return false;
	const record: SessionSpawnRecord = {
		version: RECORD_VERSION,
		pid,
		startedAtMs: child.startedAtMs,
		sessionId,
		hostPid: process.pid,
		hostStartedAtMs: host.startedAtMs,
	};
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.tmp`;
	await writeFile(temp, JSON.stringify(record), { mode: 0o600 });
	await rename(temp, path);
	return true;
}

/** Which session owns `pid`, from the kernel's ancestry and the spawners' records. Never throws. */
export async function resolvePidSession(pid: number, options: SessionSpawnStoreOptions = {}): Promise<PidSession> {
	const dir = options.dir ?? sessionSpawnsDir();
	const chain: number[] = [];
	let current = pid;
	let identity = await readKernelProcessIdentity(current);
	if (identity === undefined || identity.zombie) return { attested: false, pid, reason: "process_not_found" };
	while (identity !== undefined && chain.length < MAX_ANCESTRY_DEPTH) {
		chain.push(current);
		const record = await readRecord(join(dir, `${current}.json`));
		if (record !== undefined && (await recordHolds(record, current, identity))) {
			return {
				attested: true,
				pid,
				sessionId: record.sessionId,
				attestedPid: current,
				hostPid: record.hostPid,
				chain,
			};
		}
		if (identity.ppid <= 1) break;
		current = identity.ppid;
		identity = await readKernelProcessIdentity(current);
	}
	return { attested: false, pid, reason: "no_attested_ancestor" };
}

async function recordHolds(record: SessionSpawnRecord, pid: number, identity: KernelProcessIdentity): Promise<boolean> {
	if (record.pid !== pid || record.startedAtMs !== identity.startedAtMs || record.hostPid !== identity.ppid) {
		return false;
	}
	const host = await readKernelProcessIdentity(record.hostPid);
	return host !== undefined && !host.zombie && host.startedAtMs === record.hostStartedAtMs;
}

async function readRecord(path: string): Promise<SessionSpawnRecord | undefined> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
	return isSessionSpawnRecord(parsed) ? parsed : undefined;
}

function isSessionSpawnRecord(value: unknown): value is SessionSpawnRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		record.version === RECORD_VERSION &&
		typeof record.sessionId === "string" &&
		record.sessionId.length > 0 &&
		["pid", "startedAtMs", "hostPid", "hostStartedAtMs"].every((key) => Number.isFinite(record[key]))
	);
}
