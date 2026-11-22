/**
 * Whether a host generation is ALIVE BUT STALLED, from evidence the host itself wrote (senpi#2566).
 *
 * The host's loop-lag watchdog leaves two files in its own generation directory: `host-stalled.json`
 * for the newest stall past the error threshold (written after the stall ends, so it proves a
 * RECURRING stall), and `host-alive.json`, a heartbeat refreshed on every healthy tick (which stops
 * the moment the loop does, so it proves a stall IN PROGRESS). Readers - an ensure deciding whether it
 * may replace the generation, its supervisor deciding whether a stop may escalate - read the files of
 * the generation they act on, never the endpoint's, because a successor and its predecessor share the
 * endpoint directory during a handoff. A stalled host is still serving its sessions; nothing here
 * signals anything.
 */
import { rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { HolderGeneration } from "../../core/session-holders.ts";
import {
	processIsLive,
	processStartTimeMs,
	readProcessIdentity,
	sameProcessStartMs,
} from "../../utils/process-identity.ts";
import {
	generationPaths,
	HOST_DAEMON_DIR_ENV,
	type HostGenerationPaths,
	hostDaemonDirectoryPaths,
} from "./host-daemon-paths.ts";
import { HOST_INSTANCE_ID_ENV } from "./host-identity-env.ts";
import { parseIdleExitMs } from "./host-lifecycle-policy.ts";
import { ageOf, readJsonObject, writeJsonAtomic } from "./host-state-json.ts";
import { supervisorLog } from "./host-supervisor-log.ts";

/** How recent stall evidence keeps an unreachable generation from being replaced. */
export const STALL_REFUSAL_WINDOW_MS_ENV = "SENPI_RPC_STALL_REFUSAL_MS";
export const DEFAULT_STALL_REFUSAL_WINDOW_MS = 120_000;
/** How recent stall evidence keeps a graceful stop waiting instead of escalating. */
export const STOP_STALL_EVIDENCE_MAX_AGE_MS = 60_000;
/** The longest a graceful stop waits for a stalled child before it escalates to SIGKILL. */
export const CHILD_STALLED_STOP_MAX_MS_ENV = "SENPI_RPC_CHILD_STALLED_STOP_MAX_MS";
export const DEFAULT_CHILD_STALLED_STOP_MAX_MS = 60_000;

export function childStalledStopMaxMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
	return parseIdleExitMs(env[CHILD_STALLED_STOP_MAX_MS_ENV]) ?? DEFAULT_CHILD_STALLED_STOP_MAX_MS;
}

export interface HostStallEvidence {
	readonly at: string;
	readonly driftMs: number;
	readonly processCpuMs: number;
	readonly heapDeltaMb: number;
	readonly sessionId?: string;
	readonly tool?: string;
}

/**
 * `generations/<instanceId>/` of the host this process IS, when a supervisor launched it; a plain
 * `--mode rpc` run has neither variable and writes no evidence at all.
 */
export function ownGenerationDir(env: Readonly<Record<string, string | undefined>>): string | undefined {
	const daemonDir = env[HOST_DAEMON_DIR_ENV];
	const instanceId = env[HOST_INSTANCE_ID_ENV];
	if (!daemonDir || !instanceId) return undefined;
	return join(daemonDir, "generations", instanceId);
}

export function stallRefusalWindowMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
	return parseIdleExitMs(env[STALL_REFUSAL_WINDOW_MS_ENV]) ?? DEFAULT_STALL_REFUSAL_WINDOW_MS;
}

/** Best-effort: a generation directory that is gone (released) or read-only simply gets no evidence. */
export function writeStallEvidence(generationDir: string, evidence: HostStallEvidence): Promise<void> {
	return writeJsonAtomic(join(generationDir, "host-stalled.json"), evidence);
}

export function writeHeartbeat(generationDir: string, at: string): Promise<void> {
	return writeJsonAtomic(join(generationDir, "host-alive.json"), { at });
}

export async function readStallEvidence(generation: HostGenerationPaths): Promise<HostStallEvidence | undefined> {
	const raw = await readJsonObject(generation.stalledFile);
	if (raw === undefined || typeof raw.at !== "string" || typeof raw.driftMs !== "number") return undefined;
	return {
		at: raw.at,
		driftMs: raw.driftMs,
		processCpuMs: typeof raw.processCpuMs === "number" ? raw.processCpuMs : 0,
		heapDeltaMb: typeof raw.heapDeltaMb === "number" ? raw.heapDeltaMb : 0,
		...(typeof raw.sessionId === "string" ? { sessionId: raw.sessionId } : {}),
		...(typeof raw.tool === "string" ? { tool: raw.tool } : {}),
	};
}

export async function recentStall(
	generation: HostGenerationPaths,
	now: number,
	maxAgeMs: number,
): Promise<HostStallEvidence | undefined> {
	const evidence = await readStallEvidence(generation);
	const age = ageOf(evidence?.at, now);
	return evidence !== undefined && age !== undefined && age <= maxAgeMs ? evidence : undefined;
}

/**
 * Stalled = a recent measured stall, OR a heartbeat that stopped more than `errorMs` ago yet within
 * the window (older than the window it is a host that died without cleaning up, not one that is
 * stuck). The caller pairs this with its own proof that the process is still alive.
 */
export async function hostLoopStalled(
	generation: HostGenerationPaths,
	options: { readonly now: number; readonly errorMs: number; readonly windowMs: number },
): Promise<boolean> {
	if ((await recentStall(generation, options.now, options.windowMs)) !== undefined) return true;
	const heartbeatAge = ageOf((await readJsonObject(generation.aliveFile))?.at, options.now);
	return heartbeatAge !== undefined && heartbeatAge > options.errorMs && heartbeatAge < options.windowMs;
}

/**
 * Whether the generation left a heartbeat older than any stall could explain: the same "died without
 * cleaning up" verdict `hostLoopStalled` reaches past the window. No heartbeat file is no evidence.
 */
export async function generationHeartbeatStopped(generation: HostGenerationPaths, now = Date.now()): Promise<boolean> {
	const age = ageOf((await readJsonObject(generation.aliveFile))?.at, now);
	return age !== undefined && age >= stallRefusalWindowMs();
}

const SAFE_INSTANCE_ID = /^[A-Za-z0-9_-]+$/;

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

/**
 * Whether the host generation a session-holder lease names has ENDED, for a holder whose pid is alive but
 * whose start time cannot be compared (#3658). Two pieces of evidence count:
 * - its heartbeat stopped (`generationHeartbeatStopped`, the rule claims and generations share);
 * - the daemon directory the lease names is an endpoint's (`endpoint.json`, which every release leaves)
 *   and the generation's directory is gone: a daemon removes it only after its child was judged not
 *   alive, by the same heartbeat rule. A lease without a daemon directory is read against this host's
 *   own daemon, where only the heartbeat counts, since absence there cannot prove membership.
 * A fresh heartbeat, no heartbeat file, or this host's own generation never ends: a live host whose
 * probe is merely slow keeps its sessions (#1609).
 */
export async function holderGenerationEnded(
	holder: HolderGeneration,
	env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<boolean> {
	const instance = holder.host_instance;
	if (instance === undefined || !SAFE_INSTANCE_ID.test(instance) || instance === env[HOST_INSTANCE_ID_ENV])
		return false;
	const daemonDir = holder.host_daemon_dir ?? env[HOST_DAEMON_DIR_ENV];
	if (daemonDir === undefined || !isAbsolute(daemonDir)) return false;
	const directory = hostDaemonDirectoryPaths(daemonDir);
	const generation = generationPaths(directory, instance);
	if (await generationHeartbeatStopped(generation)) return true;
	return (
		holder.host_daemon_dir !== undefined && (await exists(directory.endpointFile)) && !(await exists(generation.dir))
	);
}

/**
 * Whether the generation's host CHILD is running, from its own pid record; `undefined` when unrecorded.
 *
 * A live pid whose start time cannot be compared (none recorded, or none readable now) is preserved -
 * a starved probe on a live host must not read as dead (#1609) - unless the generation's heartbeat has
 * stopped (#3658). On Windows a killed generation's pid is handed to an unrelated process, and without
 * that second piece of evidence the stranger would keep the generation, and every ensure refusing
 * `host_stalled`, alive for as long as it runs.
 */
export async function hostChildAlive(generation: HostGenerationPaths): Promise<boolean | undefined> {
	const record = await readJsonObject(generation.childPidFile);
	const pid = record?.pid;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
	if (!processIsLive(pid)) return false;
	const observed = await readProcessIdentity(pid, process.platform, 1_000, processIsLive, "UTC");
	// `absent` includes an exited, unreaped child (state Z), read in the same async snapshot (senpi#4119).
	if (observed.kind === "absent" || !processIsLive(pid)) return false;
	const recordedMs =
		typeof record?.processStartTime === "string" ? processStartTimeMs(record.processStartTime) : undefined;
	const observedMs = observed.kind === "present" ? processStartTimeMs(observed.identity) : undefined;
	if (recordedMs !== undefined && observedMs !== undefined) return sameProcessStartMs(recordedMs, observedMs);
	if (await generationHeartbeatStopped(generation)) {
		supervisorLog(`host child pid ${pid} start time unreadable and its heartbeat stopped; releasing generation`);
		return false;
	}
	supervisorLog(`host child pid ${pid} start time unreadable; preserving generation`);
	return true;
}

/**
 * The supervisor's report that it is waiting out a stalled child before escalating; a caller with a
 * deadline on that supervisor extends it while the report is fresh.
 */
export interface StopProgress {
	readonly at: string;
	readonly phase: "waiting_stalled_child";
	readonly untilAt: string;
}

export function writeStopProgress(generation: HostGenerationPaths, progress: StopProgress): Promise<void> {
	return writeJsonAtomic(generation.stopProgressFile, progress);
}

export async function clearStopProgress(generation: HostGenerationPaths): Promise<void> {
	await rm(generation.stopProgressFile, { force: true }).catch(() => undefined);
}

export async function activeStopProgress(
	generation: HostGenerationPaths,
	now: number,
	freshMs: number,
): Promise<number | undefined> {
	const raw = await readJsonObject(generation.stopProgressFile);
	const age = ageOf(raw?.at, now);
	const untilAt = typeof raw?.untilAt === "string" ? Date.parse(raw.untilAt) : Number.NaN;
	if (age === undefined || age > freshMs || Number.isNaN(untilAt) || untilAt <= now) return undefined;
	return untilAt;
}
