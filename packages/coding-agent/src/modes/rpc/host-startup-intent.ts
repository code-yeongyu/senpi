/**
 * The startup intent of one endpoint (senpi#4602, A-amended section 5): recovery evidence a launcher
 * writes under the endpoint's ensure lock BEFORE it spawns, so a later lock holder can tell a start
 * that may still be running from one that is provably over. It is not a progress channel and grants
 * no right to signal anything.
 *
 * The next holder reconciles a leftover intent through the candidate's OWN identity: the child the launcher
 * bound, or else the supervisor that recorded the same attempt nonce in its generation directory. Only a
 * candidate proven gone is cleared at once. A candidate nobody can identify is UNKNOWN, and stays refused
 * until the intent is older than the settled-result bound - the longest any start, cleanup included, runs.
 */
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { type DaemonPidFile, processMatchesPidFile, readProcessStartTime } from "../../utils/process-identity.ts";
import { generationPaths, type HostDaemonPaths } from "./host-daemon-paths.ts";
import { HostEnsureRefusedError } from "./host-decision.ts";
import { childStalledStopMaxMs } from "./host-stalled-evidence.ts";
import { startupEnvelope } from "./host-startup-policy.ts";
import { readJsonObject, writeJsonAtomic } from "./host-state-json.ts";
import { STARTUP_ATTEMPT_FILE } from "./host-startup-wire.ts";

const STARTUP_INTENT_FILE = "startup-intent.json";
const STARTUP_INTENT_VERSION = 1;

export interface StartupIntent {
	readonly attempt: string;
	readonly instanceId: string;
	readonly generation: number;
	readonly launcher: DaemonPidFile;
	/** Absent until the launcher bound the spawned child's identity. */
	readonly child?: DaemonPidFile;
	/** Wall-clock milliseconds: the intent outlives the process that wrote it, so no monotonic origin applies. */
	readonly writtenAt: number;
}

export function startupIntentPath(daemonDir: string): string {
	return join(daemonDir, STARTUP_INTENT_FILE);
}

/** Written (mode 0600, by rename) under the ensure lock, before the spawn. */
export function writeStartupIntent(daemonDir: string, intent: StartupIntent): Promise<void> {
	return writeJsonAtomic(startupIntentPath(daemonDir), { version: STARTUP_INTENT_VERSION, ...intent });
}

/** `unreadable` carries the file's age source, so even a torn intent expires. */
export async function readStartupIntent(
	daemonDir: string,
): Promise<StartupIntent | { readonly unreadable: true; readonly writtenAt: number } | undefined> {
	const modified = await stat(startupIntentPath(daemonDir)).then(
		(entry) => entry.mtimeMs,
		() => undefined,
	);
	if (modified === undefined) return undefined;
	const record = await readJsonObject(startupIntentPath(daemonDir));
	const launcher = pidFileOf(record?.launcher);
	const child = record?.child === undefined ? undefined : pidFileOf(record.child);
	if (
		!record ||
		record.version !== STARTUP_INTENT_VERSION ||
		typeof record.attempt !== "string" ||
		typeof record.instanceId !== "string" ||
		typeof record.generation !== "number" ||
		typeof record.writtenAt !== "number" ||
		!launcher ||
		child === null
	)
		return { unreadable: true, writtenAt: modified };
	return {
		attempt: record.attempt,
		instanceId: record.instanceId,
		generation: record.generation,
		launcher,
		writtenAt: record.writtenAt,
		...(child ? { child } : {}),
	};
}

export function clearStartupIntent(daemonDir: string): Promise<void> {
	return rm(startupIntentPath(daemonDir), { force: true });
}

/** The identity a supervisor recorded for `attempt` in its own generation directory, if it got that far. */
export async function readStartupAttemptRecord(
	generationDir: string,
	attempt: string,
): Promise<DaemonPidFile | undefined> {
	const record = await readJsonObject(join(generationDir, STARTUP_ATTEMPT_FILE));
	if (record?.attempt !== attempt) return undefined;
	return pidFileOf(record) ?? undefined;
}

/**
 * - `none`: no intent; a start may proceed.
 * - `candidate_gone`: the candidate's own identity proves it exited; clear and proceed.
 * - `expired`: nobody could identify the candidate, and the intent is past the settled-result bound; clear and proceed.
 * - `candidate_live`: preserve every record and refuse; nothing is signalled.
 * - `unknown`: no identity was bound or recorded, or one could not be read; preserve and refuse.
 */
export type StartupIntentVerdict = "none" | "candidate_gone" | "expired" | "candidate_live" | "unknown";

export async function reconcileStartupIntent(
	intent: Awaited<ReturnType<typeof readStartupIntent>>,
	options: {
		/** Whether a recorded identity is still that process; it throws when it cannot tell. */
		readonly matches: (record: DaemonPidFile) => Promise<boolean>;
		/** The supervisor's own attempt record for this intent's generation. */
		readonly attemptRecord: (instanceId: string, attempt: string) => Promise<DaemonPidFile | undefined>;
		/** E: the settled-result bound after which an unidentifiable candidate no longer wedges the endpoint. */
		readonly expiryMs: number;
		readonly now: number;
	},
): Promise<StartupIntentVerdict> {
	if (intent === undefined) return "none";
	const expiredOr = (verdict: "unknown"): StartupIntentVerdict =>
		options.now - intent.writtenAt >= options.expiryMs ? "expired" : verdict;
	if ("unreadable" in intent) return expiredOr("unknown");
	const candidate = intent.child ?? (await options.attemptRecord(intent.instanceId, intent.attempt));
	if (!candidate) return expiredOr("unknown");
	const live = await options.matches(candidate).catch(() => undefined);
	if (live === undefined) return expiredOr("unknown");
	return live ? "candidate_live" : "candidate_gone";
}

/**
 * Run under the ensure lock before a start: a leftover intent whose candidate is gone, or that expired, is
 * cleared; one whose candidate may still run refuses this start and stays as evidence. Nothing is signalled.
 */
export async function settleStartupIntent(
	paths: HostDaemonPaths,
	socket: string,
	readStartTime: (pid: number) => Promise<string | undefined> = readProcessStartTime,
): Promise<void> {
	const expiryMs = startupEnvelope(childStalledStopMaxMs()).settled;
	const verdict = await reconcileStartupIntent(await readStartupIntent(paths.dir), {
		matches: (record) => processMatchesPidFile(record, readStartTime),
		attemptRecord: (instanceId, attempt) => readStartupAttemptRecord(generationPaths(paths, instanceId).dir, attempt),
		expiryMs,
		now: Date.now(),
	});
	if (verdict === "none") return;
	if (verdict === "candidate_gone" || verdict === "expired") return clearStartupIntent(paths.dir);
	const detail =
		verdict === "candidate_live"
			? `a previous start of this endpoint is still running and never registered (${startupIntentPath(paths.dir)})`
			: `a previous start of this endpoint cannot be identified; ${startupIntentPath(paths.dir)} is kept until its candidate is proven gone or ${expiryMs}ms after it was written`;
	throw new HostEnsureRefusedError(
		socket,
		verdict === "candidate_live" ? "host_stalled" : "endpoint_occupied",
		undefined,
		detail,
	);
}

function pidFileOf(value: unknown): DaemonPidFile | null {
	if (typeof value !== "object" || value === null) return null;
	const { pid, processStartTime } = value as Record<string, unknown>;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
	if (processStartTime !== null && typeof processStartTime !== "string") return null;
	return { pid, processStartTime };
}
