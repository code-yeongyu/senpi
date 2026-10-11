/**
 * WHAT the daemon's boot settings say, and the primitives every state file goes through.
 *
 * `settings.json` is written twice on purpose: the daemon directory holds what the SUPERVISOR reads
 * at boot, and the generation's own directory keeps what THAT generation was started with, which
 * survives the next generation overwriting the boot copy.
 *
 * The three primitives below are shared with `host-daemon-registration.ts`: a write that carries the
 * 0600 mode and names the path it failed on, a read that treats a missing file as "no state" rather
 * than an error, and the JSON narrowing both sides parse records with. WHERE any of these files live
 * is `host-daemon-paths.ts`; nothing here builds a path of its own.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { processStartTimeMs, readProcessIdentity, sameProcessStartMs } from "../app-server/daemon/process.ts";
import {
	createGenerationDirectory,
	generationPaths,
	HOST_STATE_FILE_MODE,
	type HostDaemonPaths,
	HostDaemonStateError,
} from "./host-daemon-paths.ts";
import { readJsonObject, writeJsonAtomic } from "./host-state-json.ts";

/** The OS start identity, never a timestamp estimated from uptime or the caller's clock. */
export interface HostLifetimeOwner {
	readonly pid: number;
	readonly startTime: string;
}

/** Null explicitly means unowned; undefined is an unreadable/old generation, never permission to take over. */
export async function readHostOwner(generationDir: string): Promise<HostLifetimeOwner | null | undefined> {
	const record = await readJsonObject(join(generationDir, "owner.json"));
	if (record?.owner === null) return null;
	if (!isRecord(record?.owner)) return undefined;
	const { pid, startTime } = record.owner;
	return typeof pid === "number" &&
		Number.isSafeInteger(pid) &&
		pid > 0 &&
		typeof startTime === "string" &&
		startTime.length > 0
		? { pid, startTime }
		: undefined;
}

/**
 * The one mutable ownership record: ensure writes it under the endpoint lock while holding an
 * attachment. Supervisors only read it. Generation teardown removes it before the pointer (#2243).
 */
export function writeHostOwner(generationDir: string, owner: HostLifetimeOwner | null): Promise<void> {
	return writeJsonAtomic(join(generationDir, "owner.json"), { owner });
}

export function sameHostOwner(
	a: HostLifetimeOwner | null | undefined,
	b: HostLifetimeOwner | null | undefined,
): boolean {
	if (a == null || b == null || a.pid !== b.pid) return false;
	// A pipe binds one incarnation: liveness tolerance must not merge two replacement owners.
	const started = processStartTimeMs(a.startTime);
	return started !== undefined && started === processStartTimeMs(b.startTime);
}

export async function callerHostOwner(): Promise<HostLifetimeOwner> {
	const observed = await readProcessIdentity(process.pid, process.platform, undefined, undefined, "UTC");
	if (observed.kind !== "present" || processStartTimeMs(observed.identity) === undefined)
		throw new Error("cannot establish RPC host owner OS start identity");
	return { pid: process.pid, startTime: observed.identity };
}

export async function hostOwnerGone(owner: HostLifetimeOwner): Promise<boolean> {
	const observed = await readProcessIdentity(owner.pid, process.platform, 1_000, undefined, "UTC");
	return (
		observed.kind === "absent" ||
		(observed.kind === "present" &&
			processStartTimeMs(observed.identity) !== undefined &&
			processStartTimeMs(owner.startTime) !== undefined &&
			!sameProcessStartMs(processStartTimeMs(observed.identity), processStartTimeMs(owner.startTime)))
	);
}

/** A live or unknown different owner is never silently replaced. Called inside the ensure lock. */
export async function claimHostOwner(generationDir: string): Promise<void> {
	const previous = await readHostOwner(generationDir);
	if (previous === undefined) throw new Error("RPC host does not support owner lifetime registration");
	const next = await callerHostOwner();
	if (sameHostOwner(previous, next)) return;
	if (previous !== null && !(await hostOwnerGone(previous))) {
		throw new Error("RPC host lifetime owner is still alive or its identity is unknown");
	}
	await writeHostOwner(generationDir, next);
}
/** Settings a supervisor reads at boot. Written before the spawn, so it exists when the host starts. */
export interface HostDaemonSettings {
	readonly socket: string;
	readonly capabilities: readonly string[];
	readonly coldStart: string;
	readonly idleExitMs: number;
	/** Which generation of this daemon the spawn is; `0` for a host nobody has handed off yet. */
	readonly generation: number;
	/** Which generation directory the spawn will register itself in. */
	readonly instanceId: string;
}

/**
 * Publishes the settings a generation is started with, in both places they are read: the daemon
 * directory (what the supervisor loads at boot) and the generation's own directory (what that
 * generation was started with, which survives the next generation overwriting the boot copy).
 */
export async function writeHostSettings(paths: HostDaemonPaths, settings: HostDaemonSettings): Promise<void> {
	const generation = generationPaths(paths, settings.instanceId);
	await createGenerationDirectory(generation);
	await writeStateFile(paths.settingsFile, settings);
	await writeStateFile(generation.settingsFile, settings);
}

/** The policy the running generation was started with, for a successor that states none of its own. */
export async function readHostSettings(
	paths: HostDaemonPaths,
): Promise<{ coldStart?: HostDaemonSettings["coldStart"]; idleExitMs?: number } | undefined> {
	const parsed = parseJson(await readFileOrUndefined(paths.settingsFile));
	if (!parsed) return undefined;
	return {
		...(typeof parsed.coldStart === "string" && { coldStart: parsed.coldStart }),
		...(typeof parsed.idleExitMs === "number" && { idleExitMs: parsed.idleExitMs }),
	};
}

export async function writeStateFile(path: string, content: unknown): Promise<void> {
	try {
		await writeFile(path, `${JSON.stringify(content)}\n`, { mode: HOST_STATE_FILE_MODE });
	} catch (cause) {
		throw new HostDaemonStateError(path, cause);
	}
}

export async function readFileOrUndefined(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error: unknown) {
		if (isNodeErrorCode(error, "ENOENT") || isNodeErrorCode(error, "ENOTDIR")) return undefined;
		throw error;
	}
}

export function parseJson(text: string | undefined): Record<string, unknown> | undefined {
	if (text === undefined) return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
