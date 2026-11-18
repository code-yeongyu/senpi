/**
 * Which session spawned a process, attested by the process that spawned it (senpi#6972).
 *
 * Every session of a shared rpc host runs its tool commands as children of ONE host process, so the kernel ancestry
 * of a caller proves the host, not the session, and the caller's `PI_SESSION_ID` is whatever its last `exec` said.
 * The spawner therefore records each child it starts for a session in `<agentDir>/session-spawns/<pid>.json`:
 * the child's pid and kernel start time, the session id, and the spawner's own pid and start time. The runtime reaps a
 * child on its own, so the identity read is issued as soon as the spawner learns the pid: in the core shell's spawn
 * callback, right after the PTY session is created, right after a codemode kernel process is spawned (the js process
 * worker, the python transport, the shared subprocess kernel), and, in the widest window, only once a worker kernel
 * reports a child through its cross-thread status event (`WorkerChildren`). A child that exits and is reaped before
 * that read is never recorded (it fails closed); recording a different process would take a full pid wrap inside
 * that window.
 *
 * `resolvePidSession` answers "which session owns pid P" from the kernel alone: it walks P's ppid chain to the nearest
 * ancestor with a record and believes that record only when the ancestor's start time, its parent and that parent's
 * start time all match. An environment is never read. Anything outside a recorded child's tree (a daemon re-parented
 * to init, a child an in-process runtime spawned directly) is `attested: false`.
 *
 * A record that still holds a live process is never replaced, and a release removes only the record it wrote, so one
 * session's record cannot be overwritten or deleted through another session's spawn or a recycled pid.
 *
 * The record lands a few event-loop turns after the spawn; it does not gate the command. Same-uid processes can write
 * the agent directory, as they can every other record under it, so this proves against a forged environment and a
 * recycled pid, not against deliberate tampering with the store.
 */
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
	/** The boot `startedAtMs` is relative to; null where it is a wall-clock stamp (darwin). */
	readonly bootId: string | null;
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
	const identity = readKernelProcessIdentity(pid);
	let path: string | undefined;
	const written = (async () => {
		const dir = options.dir ?? sessionSpawnsDir();
		path = join(dir, `${pid}.json`);
		return await writeRecord(dir, path, sessionId, pid, await identity);
	})().catch(() => undefined);
	return {
		recorded: written.then((record) => record !== undefined),
		async release() {
			const mine = await written;
			if (mine === undefined || path === undefined) return;
			const current = await readRecord(path);
			if (current !== undefined && sameRecord(current, mine)) await unlink(path).catch(() => undefined);
		},
	};
}

async function writeRecord(
	dir: string,
	path: string,
	sessionId: string,
	pid: number,
	child: KernelProcessIdentity | undefined,
): Promise<SessionSpawnRecord | undefined> {
	const host = await (ownIdentity ??= readKernelProcessIdentity(process.pid));
	if (child === undefined || host === undefined || child.ppid !== process.pid) return undefined;
	const record: SessionSpawnRecord = {
		version: RECORD_VERSION,
		pid,
		startedAtMs: child.startedAtMs,
		bootId: child.bootId ?? null,
		sessionId,
		hostPid: process.pid,
		hostStartedAtMs: host.startedAtMs,
	};
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.tmp`;
	await writeFile(temp, JSON.stringify(record), { mode: 0o600 });
	try {
		// link() publishes only where no record exists; an existing one is replaced only when it no longer holds.
		try {
			await link(temp, path);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
			const existing = await readRecord(path);
			if (existing !== undefined && (await recordHolds(existing, pid, child))) {
				return sameRecord(existing, record) ? record : undefined;
			}
			await rename(temp, path);
			return record;
		}
	} finally {
		await unlink(temp).catch(() => undefined);
	}
	return record;
}

function sameRecord(a: SessionSpawnRecord, b: SessionSpawnRecord): boolean {
	return (
		a.pid === b.pid &&
		a.startedAtMs === b.startedAtMs &&
		a.bootId === b.bootId &&
		a.sessionId === b.sessionId &&
		a.hostPid === b.hostPid &&
		a.hostStartedAtMs === b.hostStartedAtMs
	);
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
	if (
		record.pid !== pid ||
		record.startedAtMs !== identity.startedAtMs ||
		record.bootId !== (identity.bootId ?? null) ||
		record.hostPid !== identity.ppid
	) {
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
		(record.bootId === null || typeof record.bootId === "string") &&
		["pid", "startedAtMs", "hostPid", "hostStartedAtMs"].every((key) => Number.isFinite(record[key]))
	);
}
