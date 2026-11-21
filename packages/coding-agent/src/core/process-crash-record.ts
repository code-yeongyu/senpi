/**
 * Durable evidence that a senpi process nobody supervises DIED rather than exited.
 *
 * The shared RPC host has a supervisor that sees its child's exit signal and writes
 * `rpc-host-daemon/<endpoint>/crashes.jsonl` (`modes/rpc/host-crash-record.ts`). An interactive or
 * print process has no such parent: the omo launcher `execve`s into it on POSIX, so a native crash
 * (a JSC heap corruption, a Bun panic) leaves nothing behind but an OS crash report.
 *
 * Such a process can still leave evidence of its own death by what it FAILS to do. At boot it writes
 * a lifetime marker, `process-crashes/live/<pid>.json`, keeps the marker's mtime fresh as a
 * heartbeat, and removes it on every exit JavaScript can observe - `process.exit`, a natural end, a
 * handled or default-fatal signal (a plain `exit` listener plus `signal-exit`, which every senpi
 * process already loads for `proper-lockfile`, so no new signal behaviour is installed). A native crash or SIGKILL runs none of
 * that. The next senpi start finds the marker of a dead pid and turns it into one crash record in
 * `process-crashes/crashes.jsonl`. The signal is unknowable from outside, so the record says
 * `detection: "unclean_exit"` instead of guessing one.
 *
 * Every step is best-effort and never throws: crash evidence must not be able to delay or break the
 * launch it only annotates.
 */
import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import onExit from "signal-exit";
import { DISPLAY_VERSION, VERSION } from "../config.ts";

/** Crash records kept per agent dir. A crash loop rewrites the file down to this many. */
export const PROCESS_CRASH_RECORD_LIMIT = 50;

/** How often a live process refreshes its marker, which bounds the error of a recorded uptime. */
export const PROCESS_MARKER_HEARTBEAT_MS = 60_000;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const MARKER_SUFFIX = ".json";

export interface ProcessCrashPaths {
	readonly dir: string;
	readonly liveDir: string;
	readonly recordsFile: string;
}

export function processCrashPaths(agentDir: string): ProcessCrashPaths {
	const dir = join(agentDir, "process-crashes");
	return { dir, liveDir: join(dir, "live"), recordsFile: join(dir, "crashes.jsonl") };
}

/** What a live process says about itself; the crash record is derived from it. */
export interface ProcessLifetimeMarker {
	readonly kind: string;
	readonly pid: number;
	readonly startedAt: number;
	readonly bunVersion?: string;
	readonly senpiVersion: string;
	/** The branded product's version (omo's), present only when a brand names one. */
	readonly productVersion?: string;
}

export interface ProcessCrashRecord {
	/** ISO-8601 instant of the last heartbeat before the death: the latest moment it was known alive. */
	readonly at: string;
	/** Which kind of process died: the app mode (`interactive`, `print`, `json`). */
	readonly kind: string;
	/** A marker left behind proves the death but not its signal. */
	readonly detection: "unclean_exit";
	/** Start to last heartbeat, in milliseconds; short by at most one heartbeat interval. */
	readonly uptimeMs: number;
	readonly bunVersion?: string;
	readonly senpiVersion: string;
	readonly productVersion?: string;
}

/** Runtime identity every record carries; the product version only when a brand sets one. */
export function crashingRuntimeVersions(): { bunVersion?: string; senpiVersion: string; productVersion?: string } {
	return {
		...(process.versions.bun === undefined ? {} : { bunVersion: process.versions.bun }),
		senpiVersion: VERSION,
		...(DISPLAY_VERSION === VERSION ? {} : { productVersion: DISPLAY_VERSION }),
	};
}

export interface RecordProcessLifetimeOptions {
	readonly pid?: number;
	readonly now?: () => number;
	readonly isAlive?: (pid: number) => boolean;
	readonly heartbeatMs?: number;
}

/**
 * The launch seam: turn every dead peer's marker into a crash record, then, for a process no parent
 * supervises, start this process's own marker. Returns the disposer of this process's marker.
 */
export function recordProcessLifetime(
	agentDir: string,
	kind: string,
	options: RecordProcessLifetimeOptions & { readonly supervised: boolean },
): () => void {
	sweepDeadProcessMarkers(agentDir, options);
	return options.supervised ? () => {} : installProcessLifetimeMarker(agentDir, kind, options);
}

/** Write this process's marker, keep it fresh, and remove it on every observable exit. */
export function installProcessLifetimeMarker(
	agentDir: string,
	kind: string,
	options: RecordProcessLifetimeOptions = {},
): () => void {
	const pid = options.pid ?? process.pid;
	const now = options.now ?? Date.now;
	const file = join(processCrashPaths(agentDir).liveDir, `${pid}${MARKER_SUFFIX}`);
	const marker: ProcessLifetimeMarker = {
		kind,
		pid,
		startedAt: now(),
		...crashingRuntimeVersions(),
	};
	try {
		mkdirSync(processCrashPaths(agentDir).liveDir, { recursive: true, mode: DIR_MODE });
		writeFileSync(file, `${JSON.stringify(marker)}\n`, { mode: FILE_MODE });
	} catch {
		return () => {};
	}
	const heartbeat = setInterval(() => {
		try {
			const at = new Date(now());
			utimesSync(file, at, at);
		} catch {
			// A missing or unwritable marker only costs the uptime precision of a later crash.
		}
	}, options.heartbeatMs ?? PROCESS_MARKER_HEARTBEAT_MS);
	heartbeat.unref();
	let disposed = false;
	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		clearInterval(heartbeat);
		process.off("exit", onProcessExit);
		removeSignalHook();
		rmSync(file, { force: true });
	};
	const onProcessExit = (): void => {
		try {
			dispose();
		} catch {}
	};
	// Bun emits a natural exit's `exit` event without the `process.emit` that signal-exit patches, so
	// the plain listener covers every exit and signal-exit only covers the default-fatal signals.
	process.on("exit", onProcessExit);
	const removeSignalHook = onExit(onProcessExit);
	return dispose;
}

/**
 * Record one crash per marker whose process is gone. A marker is CLAIMED by renaming it before it is
 * recorded, so two processes starting at once cannot both record the same death.
 */
export function sweepDeadProcessMarkers(agentDir: string, options: RecordProcessLifetimeOptions = {}): number {
	const paths = processCrashPaths(agentDir);
	const selfPid = options.pid ?? process.pid;
	const isAlive = options.isAlive ?? isProcessAlive;
	let names: string[];
	try {
		names = readdirSync(paths.liveDir);
	} catch {
		return 0;
	}
	let recorded = 0;
	for (const name of names) {
		if (!name.endsWith(MARKER_SUFFIX)) continue;
		const pid = Number(name.slice(0, -MARKER_SUFFIX.length));
		if (!Number.isSafeInteger(pid) || pid <= 0 || pid === selfPid || isAlive(pid)) continue;
		const claimed = join(paths.liveDir, `${name}.${selfPid}.sweep`);
		try {
			renameSync(join(paths.liveDir, name), claimed);
		} catch {
			continue; // Another process claimed it first, or it was removed by its own exit.
		}
		try {
			const record = crashRecordFromMarker(readFileSync(claimed, "utf8"), statSync(claimed).mtimeMs);
			if (record !== undefined) {
				appendProcessCrashRecord(paths, record);
				recorded += 1;
			}
		} catch {
			// An unreadable marker is not evidence of anything; it is discarded below.
		} finally {
			rmSync(claimed, { force: true });
		}
	}
	return recorded;
}

/** Every record currently held, oldest first. Unparseable lines are skipped, never thrown on. */
export function readProcessCrashRecords(agentDir: string): readonly ProcessCrashRecord[] {
	let raw: string;
	try {
		raw = readFileSync(processCrashPaths(agentDir).recordsFile, "utf8");
	} catch {
		return [];
	}
	const records: ProcessCrashRecord[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const value: unknown = JSON.parse(line);
			if (typeof value === "object" && value !== null && typeof Reflect.get(value, "at") === "string") {
				records.push(value as ProcessCrashRecord);
			}
		} catch {}
	}
	return records;
}

/** Signal 0 probes existence; EPERM means the pid exists under another user, so it is alive. */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function crashRecordFromMarker(raw: string, lastHeartbeatMs: number): ProcessCrashRecord | undefined {
	const value: unknown = JSON.parse(raw);
	if (typeof value !== "object" || value === null) return undefined;
	const kind: unknown = Reflect.get(value, "kind");
	const startedAt: unknown = Reflect.get(value, "startedAt");
	const senpiVersion: unknown = Reflect.get(value, "senpiVersion");
	const bunVersion: unknown = Reflect.get(value, "bunVersion");
	const productVersion: unknown = Reflect.get(value, "productVersion");
	if (typeof kind !== "string" || typeof startedAt !== "number" || typeof senpiVersion !== "string") return undefined;
	return {
		at: new Date(lastHeartbeatMs).toISOString(),
		kind,
		detection: "unclean_exit",
		uptimeMs: Math.max(0, Math.round(lastHeartbeatMs - startedAt)),
		...(typeof bunVersion === "string" ? { bunVersion } : {}),
		senpiVersion,
		...(typeof productVersion === "string" ? { productVersion } : {}),
	};
}

function appendProcessCrashRecord(paths: ProcessCrashPaths, record: ProcessCrashRecord): void {
	mkdirSync(paths.dir, { recursive: true, mode: DIR_MODE });
	appendFileSync(paths.recordsFile, `${JSON.stringify(record)}\n`, { mode: FILE_MODE });
	const records = readProcessCrashRecordsFrom(paths.recordsFile);
	if (records.length <= PROCESS_CRASH_RECORD_LIMIT) return;
	const kept = records.slice(records.length - PROCESS_CRASH_RECORD_LIMIT);
	writeFileSync(paths.recordsFile, `${kept.join("\n")}\n`, { mode: FILE_MODE });
}

/** Raw non-empty lines, so pruning keeps each surviving record byte-identical. */
function readProcessCrashRecordsFrom(file: string): string[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "");
}
