/**
 * Durable evidence of how a supervised RPC host generation ENDED.
 *
 * The supervisor already knows the difference - `classifyChildExit` in `host-lifecycle.ts`
 * separates a clean idle exit from a crash - but it only ever reported the crash to stderr, and
 * the daemon's stderr log is truncated by the very restart that replaces the dead host. A host
 * dying every fifty minutes was therefore indistinguishable, from inside senpi, from one that had
 * never died at all.
 *
 * This file is append-only and lives beside the other per-endpoint daemon state, so a restart adds
 * to it instead of replacing it. Two record identities share it (senpi#2566): the TERMINAL record
 * (`kind: "rpc-host"`) says how a generation's host child ended and who asked for it - a death
 * (`supervisor`, `external`) or an engine-initiated stop (`engine_stop`) - and the WATCHDOG record
 * (`kind: "rpc-host-watchdog"`) is the host child's own line when its supervisor vanished. At most
 * one terminal record is kept per generation; a clean exit the host chose itself writes nothing.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireOwnershipSafeLock } from "./ownership-safe-lock.ts";

/** Crash records kept per endpoint. A crash loop rewrites the file down to this many. */
export const HOST_CRASH_RECORD_LIMIT = 50;

/** Written 0600 like every other daemon state file: it names local paths and process detail. */
const CRASH_RECORD_FILE_MODE = 0o600;

/**
 * How long a terminal writer waits for the record lock before appending anyway: a duplicate terminal
 * line is tolerable, a missing one is not. Never the ensure lock - an ensure holds that one while it
 * waits for the very supervisor whose record this is.
 */
const TERMINAL_RECORD_LOCK_WAIT_MS = 500;

/** `<daemonDir>/crashes.jsonl` - one JSON object per line, oldest first. */
export function hostCrashRecordFile(daemonDir: string): string {
	return join(daemonDir, "crashes.jsonl");
}

/** Who sent a stop: the process, the role it acted in, and the generation it acted for when it has one. */
export interface HostStopSender {
	readonly pid: number;
	readonly kind: "ensure" | "supervisor" | "stop" | "successor" | "handoff";
	readonly generation?: string;
}

export interface HostCrashRecord {
	/** ISO-8601 instant the death or stop was observed. */
	readonly at: string;
	/** The signal that killed the child, when it died from one. */
	readonly signal?: string;
	/** The exit code, when it exited rather than signalled. */
	readonly code?: number;
	/**
	 * How long the child had been alive, in milliseconds. Absent when the writer cannot know it: a caller
	 * recording a supervisor it had to SIGKILL never saw the child start.
	 */
	readonly uptimeMs?: number;
	/** `rpc-host` (terminal) or `rpc-host-watchdog`; absent on records written before the field existed. */
	readonly kind?: "rpc-host" | "rpc-host-watchdog";
	/** The generation (`instanceId`) the record is about. */
	readonly generation?: string;
	/**
	 * `supervisor`: the child died and nobody asked for it. `external`: it was signalled with no stop
	 * intent on record. `engine_stop`: an engine process stopped it on purpose (`sender`, `reason`).
	 */
	readonly detection?: "supervisor" | "external" | "engine_stop";
	readonly sender?: HostStopSender;
	/** Every sender that acted, outermost first, when the stop passed through more than one. */
	readonly chain?: readonly HostStopSender[];
	readonly reason?: string;
	/** Whether a fresh stop intent for this generation was on record when it ended. */
	readonly stopIntent?: boolean;
	/** The newest loop stall the host measured, when it was recent at the end. */
	readonly stall?: { readonly driftMs: number; readonly at: string; readonly attributedSessionId?: string };
	/** The runtime the supervisor and its child share, as of the death. */
	readonly bunVersion?: string;
	readonly senpiVersion?: string;
	readonly productVersion?: string;
}

/** A record that counts as a death: a terminal record no engine process asked for. */
export function isHostCrash(record: HostCrashRecord): boolean {
	return record.kind !== "rpc-host-watchdog" && record.detection !== "engine_stop";
}

/**
 * Append one record, then bound the file.
 *
 * NEVER throws: this runs on exit paths, where a filesystem failure must not be able to delay or
 * prevent the shutdown it is only annotating.
 */
export function recordHostCrash(daemonDir: string, record: HostCrashRecord): void {
	try {
		mkdirSync(daemonDir, { recursive: true, mode: 0o700 });
		appendFileSync(hostCrashRecordFile(daemonDir), `${JSON.stringify(record)}\n`, { mode: CRASH_RECORD_FILE_MODE });
		pruneHostCrashRecords(daemonDir);
	} catch {
		// Evidence is best-effort; the shutdown it annotates is not.
	}
}

/**
 * Append a TERMINAL record unless one for the same generation already exists: the supervisor's exit
 * handler and a caller that had to SIGKILL that supervisor can both reach this for one generation.
 * The check-then-append runs under `crashes.lock`; a lock that cannot be had in time appends anyway.
 */
export async function recordTerminalHostRecord(daemonDir: string, record: HostCrashRecord): Promise<void> {
	const release = await acquireRecordLock(daemonDir);
	try {
		const duplicate =
			record.generation !== undefined &&
			readHostCrashRecords(daemonDir).some(
				(existing) => existing.kind === "rpc-host" && existing.generation === record.generation,
			);
		if (!duplicate || release === undefined) recordHostCrash(daemonDir, { ...record, kind: "rpc-host" });
	} finally {
		await release?.().catch(() => undefined);
	}
}

async function acquireRecordLock(daemonDir: string): Promise<(() => Promise<void>) | undefined> {
	try {
		mkdirSync(daemonDir, { recursive: true, mode: 0o700 });
		return await acquireOwnershipSafeLock(join(daemonDir, "crashes.lock"), {
			retries: { retries: Math.ceil(TERMINAL_RECORD_LOCK_WAIT_MS / 50), minTimeout: 20, maxTimeout: 50 },
		});
	} catch {
		return undefined;
	}
}

/** Every record currently held, oldest first. Unparseable lines are skipped, never thrown on. */
export function readHostCrashRecords(daemonDir: string): readonly HostCrashRecord[] {
	let raw: string;
	try {
		raw = readFileSync(hostCrashRecordFile(daemonDir), "utf8");
	} catch {
		return [];
	}
	const records: HostCrashRecord[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const value: unknown = JSON.parse(line);
			if (typeof value === "object" && value !== null && typeof Reflect.get(value, "at") === "string") {
				records.push(value as HostCrashRecord);
			}
		} catch {
			// A torn final line from a host killed mid-append is not a reason to lose the rest.
		}
	}
	return records;
}

/** Keep the newest `HOST_CRASH_RECORD_LIMIT` records so a crash loop cannot grow the file forever. */
function pruneHostCrashRecords(daemonDir: string): void {
	const records = readHostCrashRecords(daemonDir);
	if (records.length <= HOST_CRASH_RECORD_LIMIT) return;
	const kept = records.slice(records.length - HOST_CRASH_RECORD_LIMIT);
	writeFileSync(hostCrashRecordFile(daemonDir), `${kept.map((r) => JSON.stringify(r)).join("\n")}\n`, {
		mode: CRASH_RECORD_FILE_MODE,
	});
}
