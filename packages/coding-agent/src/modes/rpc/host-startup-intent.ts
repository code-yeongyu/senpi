/**
 * The startup intent of one endpoint (senpi#4602, A-amended section 5): recovery evidence a launcher
 * writes under the endpoint's ensure lock BEFORE it spawns, so a later lock holder can tell a start
 * that may still be running from one that is provably over. It is not a progress channel and grants
 * no right to signal anything.
 *
 * A launcher that dies holding the lock leaves its intent behind. The next holder reconciles it: only
 * a candidate whose own recorded identity proves it gone may be cleared and replaced. A launcher that
 * died between spawn and binding the child's identity leaves the candidate UNKNOWN, never "gone".
 */
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DaemonPidFile } from "../../utils/process-identity.ts";
import { readJsonObject, writeJsonAtomic } from "./host-state-json.ts";

const STARTUP_INTENT_FILE = "startup-intent.json";
const STARTUP_INTENT_VERSION = 1;

export interface StartupIntent {
	readonly attempt: string;
	readonly instanceId: string;
	readonly generation: number;
	readonly launcher: DaemonPidFile;
	/** Absent until the launcher bound the spawned child's identity. */
	readonly child?: DaemonPidFile;
}

export function startupIntentPath(daemonDir: string): string {
	return join(daemonDir, STARTUP_INTENT_FILE);
}

/** Written (mode 0600, by rename) under the ensure lock, before the spawn. */
export function writeStartupIntent(daemonDir: string, intent: StartupIntent): Promise<void> {
	return writeJsonAtomic(startupIntentPath(daemonDir), { version: STARTUP_INTENT_VERSION, ...intent });
}

export async function readStartupIntent(daemonDir: string): Promise<StartupIntent | "unreadable" | undefined> {
	const record = await readJsonObject(startupIntentPath(daemonDir));
	if (record === undefined) return (await intentFileExists(daemonDir)) ? "unreadable" : undefined;
	const launcher = pidFileOf(record.launcher);
	const child = record.child === undefined ? undefined : pidFileOf(record.child);
	if (
		record.version !== STARTUP_INTENT_VERSION ||
		typeof record.attempt !== "string" ||
		typeof record.instanceId !== "string" ||
		typeof record.generation !== "number" ||
		!launcher ||
		child === null
	)
		return "unreadable";
	return {
		attempt: record.attempt,
		instanceId: record.instanceId,
		generation: record.generation,
		launcher,
		...(child ? { child } : {}),
	};
}

export function clearStartupIntent(daemonDir: string): Promise<void> {
	return rm(startupIntentPath(daemonDir), { force: true });
}

/**
 * - `none`: no intent; a start may proceed.
 * - `candidate_gone`: the recorded child's own identity proves it exited; clear and proceed.
 * - `candidate_live` / `launcher_live`: preserve every record and refuse; nothing is signalled.
 * - `unknown`: no child identity was bound, or an identity could not be read; preserve and refuse.
 */
export type StartupIntentVerdict = "none" | "candidate_gone" | "candidate_live" | "launcher_live" | "unknown";

/** `matches` answers whether a recorded identity is still that process; it throws when it cannot tell. */
export async function reconcileStartupIntent(
	intent: StartupIntent | "unreadable" | undefined,
	matches: (record: DaemonPidFile) => Promise<boolean>,
): Promise<StartupIntentVerdict> {
	if (intent === undefined) return "none";
	if (intent === "unreadable") return "unknown";
	const launcherLive = await matches(intent.launcher).catch(() => undefined);
	if (launcherLive !== false) return launcherLive ? "launcher_live" : "unknown";
	if (!intent.child) return "unknown";
	const childLive = await matches(intent.child).catch(() => undefined);
	if (childLive === undefined) return "unknown";
	return childLive ? "candidate_live" : "candidate_gone";
}

function pidFileOf(value: unknown): DaemonPidFile | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	const { pid, processStartTime } = record;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
	if (processStartTime !== null && typeof processStartTime !== "string") return null;
	return { pid, processStartTime };
}

async function intentFileExists(daemonDir: string): Promise<boolean> {
	return stat(startupIntentPath(daemonDir)).then(
		() => true,
		() => false,
	);
}
