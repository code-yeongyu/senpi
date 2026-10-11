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
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
	processIsLive,
	processStartTimeMs,
	readProcessIdentity,
	sameProcessStartMs,
} from "../app-server/daemon/process.ts";
import { HOST_DAEMON_DIR_ENV, type HostGenerationPaths } from "./host-daemon-paths.ts";
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

/** Whether the generation's host CHILD is running, from its own pid record; `undefined` when unrecorded. */
export async function hostChildAlive(generation: HostGenerationPaths): Promise<boolean | undefined> {
	const record = await readJsonObject(generation.childPidFile);
	const pid = record?.pid;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
	if (!processIsLive(pid)) return false;
	const observed = await readProcessIdentity(pid, process.platform, 1_000, processIsLive, "UTC");
	if (!processIsLive(pid)) return false;
	const recordedMs =
		typeof record?.processStartTime === "string" ? processStartTimeMs(record.processStartTime) : undefined;
	const observedMs = observed.kind === "present" ? processStartTimeMs(observed.identity) : undefined;
	if (recordedMs !== undefined && observedMs !== undefined) return sameProcessStartMs(recordedMs, observedMs);
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
