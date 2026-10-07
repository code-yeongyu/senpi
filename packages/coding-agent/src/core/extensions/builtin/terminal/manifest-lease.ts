import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	errorCode,
	publishExclusive,
	publishReplace,
	readLeaseText,
	reclaimInspected,
	unlinkIfPresent,
} from "./lease-file.ts";
import {
	ownProcessStartedAtMs,
	PROCESS_START_TOLERANCE_MS,
	processBootAtMs,
	sameProcessStart,
} from "./process-identity.ts";
import { readProcessStartMs as defaultReadProcessStartMs } from "./process-start-probe.ts";

export const LEASE_RECORD_VERSION = 2;

export interface LeaseSelfIdentity {
	readonly pid: number;
	readonly bootAtMs: number;
	readonly processStartedAtMs: number;
}

/**
 * `startedAtMs` duplicates `acquiredAtMs` on purpose: a senpi build that still runs the v1 lease
 * reader parses `{pid, startedAtMs}` and must not see this file as unparseable (which it reclaims).
 */
export interface LeaseRecord {
	readonly v?: number;
	readonly token?: string;
	readonly pid: number;
	readonly startedAtMs: number;
	readonly bootAtMs?: number;
	readonly processStartedAtMs?: number;
	readonly acquiredAtMs?: number;
}

export interface LeaseHolder {
	readonly pid: number;
	readonly startedAtMs: number;
	readonly bootAtMs?: number;
}

export type AcquireTerminalLeaseOptions = {
	dir: string;
	encodedSessionId: string;
	pid?: number;
	now?: () => number;
	self?: LeaseSelfIdentity;
	isProcessAlive?: (pid: number) => boolean;
	readProcessStartMs?: (pid: number) => Promise<number | undefined>;
};

export type AcquireTerminalLeaseResult =
	| { acquired: true; path: string; pid: number; token: string }
	| { acquired: false; holder: LeaseHolder };

export type LeaseClassification = "self" | "dead" | "reused" | "live-foreign";

const generationTokens = new Map<string, string>();
/**
 * Tokens held by generations of THIS process that are still running. A same-pid lease is a live
 * holder only when its token is here (a sibling session generation, or a racing waiter that won);
 * a token that is not here was minted by a generation that has shut down, even one whose
 * shutdown never reached the release (the 10 s shutdown cap), so it is ours to re-enter.
 */
const liveTokens = new Set<string>();

export function currentLeaseToken(encodedSessionId: string): string | undefined {
	return generationTokens.get(encodedSessionId);
}

/** Mark a generation's token dead the moment its shutdown starts, before any slow flush. */
export function retireLeaseToken(token: string): void {
	liveTokens.delete(token);
}

function probeAlive(pid: number, probe?: (pid: number) => boolean): boolean {
	try {
		if (probe) return probe(pid);
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = errorCode(error);
		if (code === "EPERM") return true;
		if (code === "ESRCH") return false;
		throw error;
	}
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function readLeaseRecord(raw: string): LeaseRecord | "unparseable" {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return "unparseable";
		const candidate = parsed as Record<string, unknown>;
		if (!isFiniteNumber(candidate.pid) || !isFiniteNumber(candidate.startedAtMs)) return "unparseable";
		return {
			pid: candidate.pid,
			startedAtMs: candidate.startedAtMs,
			...(isFiniteNumber(candidate.v) ? { v: candidate.v } : {}),
			...(typeof candidate.token === "string" ? { token: candidate.token } : {}),
			...(isFiniteNumber(candidate.bootAtMs) ? { bootAtMs: candidate.bootAtMs } : {}),
			...(isFiniteNumber(candidate.processStartedAtMs) ? { processStartedAtMs: candidate.processStartedAtMs } : {}),
			...(isFiniteNumber(candidate.acquiredAtMs) ? { acquiredAtMs: candidate.acquiredAtMs } : {}),
		};
	} catch {
		return "unparseable";
	}
}

async function readLeaseFile(path: string): Promise<LeaseRecord | "missing" | "unparseable"> {
	const raw = await readLeaseText(path);
	return raw === undefined ? "missing" : readLeaseRecord(raw);
}

/**
 * Decide what an existing lease is. A pid alone is never trusted: the holder is alive only when
 * its pid answers AND its recorded start instant matches the process now wearing that pid
 * (probed on this cold path only). A boot mismatch alone never reclaims an alive pid. Our own
 * pid is "self" only when the file carries the token this process minted for the session (or a
 * legacy record without one): a multi-session host holds many sessions under one pid, and a
 * lease another live generation in this process owns is a live holder, not a re-entry.
 */
export async function classifyLease(
	existing: LeaseRecord,
	self: LeaseSelfIdentity,
	probes: {
		readonly isProcessAlive?: (pid: number) => boolean;
		readonly readProcessStartMs: (pid: number) => Promise<number | undefined>;
		readonly liveTokens?: ReadonlySet<string>;
	},
): Promise<LeaseClassification> {
	if (existing.pid === self.pid) {
		if (existing.token !== undefined && (probes.liveTokens ?? liveTokens).has(existing.token)) return "live-foreign";
		return "self";
	}
	if (!probeAlive(existing.pid, probes.isProcessAlive)) return "dead";
	let observedStart: number | undefined;
	try {
		observedStart = await probes.readProcessStartMs(existing.pid);
	} catch {
		observedStart = undefined;
	}
	if (observedStart === undefined) return "live-foreign";
	if (existing.processStartedAtMs === undefined) {
		// A v1 record's startedAtMs is when the lease was taken, so its holder started no later
		// than that; a process that started afterwards on the same pid is a reuse.
		return observedStart <= existing.startedAtMs + PROCESS_START_TOLERANCE_MS ? "live-foreign" : "reused";
	}
	return sameProcessStart(existing.processStartedAtMs, observedStart) ? "live-foreign" : "reused";
}

function holderOf(record: LeaseRecord): LeaseHolder {
	return {
		pid: record.pid,
		startedAtMs: record.startedAtMs,
		...(record.bootAtMs !== undefined ? { bootAtMs: record.bootAtMs } : {}),
	};
}

export async function acquireTerminalLease(options: AcquireTerminalLeaseOptions): Promise<AcquireTerminalLeaseResult> {
	const now = (options.now ?? Date.now)();
	const self: LeaseSelfIdentity = options.self ?? {
		pid: options.pid ?? process.pid,
		bootAtMs: processBootAtMs(),
		processStartedAtMs: ownProcessStartedAtMs(),
	};
	const pid = options.pid ?? self.pid;
	const path = join(options.dir, `${options.encodedSessionId}.lease`);
	await mkdir(options.dir, { recursive: true });
	const token = randomUUID();
	const record: LeaseRecord = {
		v: LEASE_RECORD_VERSION,
		token,
		pid,
		startedAtMs: now,
		bootAtMs: self.bootAtMs,
		processStartedAtMs: self.processStartedAtMs,
		acquiredAtMs: now,
	};
	const acquired = (): AcquireTerminalLeaseResult => {
		generationTokens.set(options.encodedSessionId, token);
		liveTokens.add(token);
		return { acquired: true, path, pid, token };
	};
	const probes = {
		isProcessAlive: options.isProcessAlive,
		readProcessStartMs: options.readProcessStartMs ?? defaultReadProcessStartMs,
	};
	const content = JSON.stringify(record);
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			await publishExclusive(path, content);
			return acquired();
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}
		const raw = await readLeaseText(path);
		if (raw === undefined) continue;
		const existing = readLeaseRecord(raw);
		const verdict = existing === "unparseable" ? "dead" : await classifyLease(existing, { ...self, pid }, probes);
		if (verdict === "self") {
			await publishReplace(path, content);
			return acquired();
		}
		if (verdict === "live-foreign" && existing !== "unparseable")
			return { acquired: false, holder: holderOf(existing) };
		// Only the record judged stale is removed; a racer's fresh lease makes the next try lose cleanly.
		const reclaim = await reclaimInspected(path, raw, probes);
		// Someone is reclaiming right now: wait on that live process, never on the stale record.
		if (reclaim.outcome === "busy" && reclaim.holder !== undefined) {
			const { pid: holderPid, processStartedAtMs, bootAtMs } = reclaim.holder;
			return { acquired: false, holder: { pid: holderPid, startedAtMs: processStartedAtMs, bootAtMs } };
		}
	}
	const raw = await readLeaseText(path);
	const last = raw === undefined ? "unparseable" : readLeaseRecord(raw);
	if (last !== "unparseable" && (await classifyLease(last, { ...self, pid }, probes)) === "live-foreign") {
		return { acquired: false, holder: holderOf(last) };
	}
	throw new Error(`terminal lease ${path} kept changing while it was being acquired`);
}

/** Release only the generation that acquired: a stale release from an earlier generation is a no-op. */
export async function releaseTerminalLease(handle: { path: string; pid: number; token?: string }): Promise<void> {
	const existing = await readLeaseFile(handle.path);
	if (existing === "missing" || existing === "unparseable") return;
	if (existing.pid !== handle.pid) return;
	if (handle.token !== undefined && existing.token !== undefined && existing.token !== handle.token) return;
	await unlinkIfPresent(handle.path);
	if (existing.token !== undefined) {
		liveTokens.delete(existing.token);
		for (const [sessionId, token] of generationTokens)
			if (token === existing.token) generationTokens.delete(sessionId);
	}
}
