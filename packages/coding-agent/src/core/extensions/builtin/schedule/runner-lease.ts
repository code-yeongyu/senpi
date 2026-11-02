/**
 * Runner leases: every `senpi schedule run` process publishes `runners/<pid>.json` in the terminal
 * lease format (pid + boot instant + process start instant) plus a heartbeat `beatAt`. The identity
 * lets a reused pid be told apart from the runner that wrote the lease; the heartbeat, refreshed on a
 * timer even while a delivery is running, tells the tool whether a runner will actually fire jobs.
 */

import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	breakStaleLock,
	errorCode,
	publishExclusive,
	publishReplace,
	readLeaseText,
	reclaimLockState,
	unlinkIfPresent,
} from "../terminal/lease-file.ts";
import { ownProcessStartedAtMs, processBootAtMs, sameBoot, sameProcessStart } from "../terminal/process-identity.ts";
import { readProcessStartMs } from "../terminal/process-start-probe.ts";
import { type RunnerIdentity, runnersDir } from "./store.ts";

/** A lease whose heartbeat is older than this does not count as an available runner. */
export const RUNNER_HEARTBEAT_STALE_MS = 120_000;
/** How often a runner refreshes its heartbeat. */
export const RUNNER_HEARTBEAT_INTERVAL_MS = 30_000;
/** Assumed delivery time limit when a lock does not state one (the CLI default). */
export const DEFAULT_MAX_DELIVERY_MS = 900_000;

/** Leases carry the `--exec` command and locks the session id: owner-only, like the job files. */
const PRIVATE = { mode: 0o600 } as const;

export function ownRunnerIdentity(): RunnerIdentity {
	return { pid: process.pid, processStartedAtMs: ownProcessStartedAtMs() };
}

function leasePath(dir: string, pid: number): string {
	return join(runnersDir(dir), `${pid}.json`);
}

export async function writeRunnerLease(
	dir: string,
	lease: { readonly startedAt: number; readonly watch: boolean; readonly exec: string | null },
	now: number,
): Promise<void> {
	await mkdir(runnersDir(dir), { recursive: true, mode: 0o700 });
	const identity = ownRunnerIdentity();
	await publishReplace(
		leasePath(dir, identity.pid),
		JSON.stringify({ ...identity, bootAtMs: processBootAtMs(), beatAt: now, ...lease }),
		PRIVATE,
	);
}

export async function removeRunnerLease(dir: string): Promise<void> {
	await unlinkIfPresent(leasePath(dir, process.pid));
}

export interface LiveRunner {
	readonly pid: number;
	readonly processStartedAtMs: number;
	readonly beatAt: number;
	readonly watch: boolean;
	readonly exec: string | null;
}

function parseLease(raw: string): Omit<LiveRunner, "pid" | "processStartedAtMs"> | undefined {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const beatAt = "beatAt" in parsed ? parsed.beatAt : undefined;
		if (typeof beatAt !== "number") return undefined;
		const watch = "watch" in parsed && parsed.watch === true;
		const exec = "exec" in parsed && typeof parsed.exec === "string" ? parsed.exec : null;
		return { beatAt, watch, exec };
	} catch {
		return undefined;
	}
}

/** Runners whose process is alive (same identity); dead or reused-pid leases are removed. */
export async function liveRunners(dir: string): Promise<LiveRunner[]> {
	let names: string[];
	try {
		names = await readdir(runnersDir(dir));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	const runners: LiveRunner[] = [];
	for (const name of names) {
		if (!/^\d+\.json$/.test(name)) continue;
		const path = join(runnersDir(dir), name);
		const state = await reclaimLockState(path);
		if (state.state === "stale") await breakStaleLock(path, state.raw);
		if (state.state !== "held" || state.holder === undefined) continue;
		const raw = await readLeaseText(path);
		const lease = raw === undefined ? undefined : parseLease(raw);
		if (lease === undefined) continue;
		runners.push({ pid: state.holder.pid, processStartedAtMs: state.holder.processStartedAtMs, ...lease });
	}
	return runners;
}

/** True when a live `--watch` runner has refreshed its heartbeat recently. */
export async function isWatchRunnerAvailable(dir: string, now: number): Promise<boolean> {
	return (await liveRunners(dir)).some((runner) => runner.watch && now - runner.beatAt <= RUNNER_HEARTBEAT_STALE_MS);
}

/** True when the runner that claimed an occurrence is still the same live process. */
export function isOwnerAmong(owner: RunnerIdentity, runners: readonly LiveRunner[]): boolean {
	return runners.some(
		(runner) => runner.pid === owner.pid && sameProcessStart(runner.processStartedAtMs, owner.processStartedAtMs),
	);
}

function sessionLockPath(dir: string, sessionId: string): string {
	return join(dir, "sessions", `${encodeURIComponent(sessionId)}.lock`);
}

export type SessionDeliveryLock =
	| {
			readonly acquired: true;
			/**
			 * Records the delivery process (group) so the lock outlives a crashed runner while it runs.
			 * Serialized with `release`; a failure rejects, and the caller must not start the delivery.
			 */
			attachDelivery(pid: number): Promise<void>;
			release(): Promise<void>;
	  }
	| { readonly acquired: false; readonly heldByPid: number | undefined };

/** Whether any member of the delivery process group (POSIX) or the delivery process (win32) is alive. */
export function isDeliveryGroupAlive(pid: number): boolean {
	try {
		process.kill(process.platform === "win32" ? pid : -pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

export interface LockProbes {
	readonly readProcessStartMs?: (pid: number) => Promise<number | undefined>;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

/**
 * A lock whose runner died is still held while the delivery it started may be running:
 * - with a recorded delivery (same boot): while its group has a live member, and - when the leader
 *   itself is alive - only if its start identity matches (a live leader that cannot be verified or
 *   started at another time is a reused pid);
 * - without one: only for an ungated delivery (Windows starts the command before it can be
 *   recorded), and then until the runner's delivery timeout has passed since the lock was written.
 */
async function orphanedDelivery(raw: string, lockAgeMs: number, probes: LockProbes): Promise<number | undefined> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const field = (key: string): unknown => (key in parsed ? Reflect.get(parsed, key) : undefined);
	const boot = field("bootAtMs");
	if (typeof boot !== "number" || !sameBoot(boot, processBootAtMs())) return undefined;
	const pid = field("deliveryPid");
	const startedAt = field("deliveryStartedAtMs");
	if (typeof pid !== "number" || typeof startedAt !== "number") {
		const maxDeliveryMs = field("maxDeliveryMs");
		const runner = field("pid");
		const ungated = field("gated") === false;
		return ungated && typeof maxDeliveryMs === "number" && lockAgeMs <= maxDeliveryMs && typeof runner === "number"
			? runner
			: undefined;
	}
	if (!isDeliveryGroupAlive(pid)) return undefined;
	if (!isPidAlive(pid)) return pid; // leader gone, descendants still delivering
	const leaderStart = await (probes.readProcessStartMs ?? readProcessStartMs)(pid).catch(() => undefined);
	return leaderStart !== undefined && sameProcessStart(startedAt, leaderStart) ? pid : undefined;
}

/**
 * Takes the cross-process delivery lock of one session: `sessions/<id>.lock`, published exclusively
 * in the lease format. Every runner takes it before it claims a job of that session and holds it
 * until the delivery has settled, so two runner processes never deliver into the same session at
 * once. The delivery process is attached to the lock before it may start its work, and a lock whose
 * runner died is reclaimed only once that delivery has exited too.
 */
export async function acquireSessionDeliveryLock(
	dir: string,
	sessionId: string,
	options: LockProbes & { readonly gated?: boolean; readonly maxDeliveryMs?: number } = {},
): Promise<SessionDeliveryLock> {
	const probes = options;
	const path = sessionLockPath(dir, sessionId);
	const identity = {
		pid: process.pid,
		bootAtMs: processBootAtMs(),
		processStartedAtMs: ownProcessStartedAtMs(),
		gated: options.gated ?? process.platform !== "win32",
		maxDeliveryMs: options.maxDeliveryMs ?? DEFAULT_MAX_DELIVERY_MS,
	};
	let mine = JSON.stringify(identity);
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			await publishExclusive(path, mine, PRIVATE);
			let tail: Promise<unknown> = Promise.resolve();
			const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
				const run = tail.then(operation);
				tail = run.catch(() => undefined);
				return run;
			};
			return {
				acquired: true,
				attachDelivery: (pid) =>
					serialized(async () => {
						// The runner spawned it a moment ago; `ps` may not list a just-forked process yet.
						const startedAt = Math.floor(Date.now() / 1000) * 1000;
						if ((await readLeaseText(path)) !== mine) throw new Error("session delivery lock was lost");
						const next = JSON.stringify({ ...identity, deliveryPid: pid, deliveryStartedAtMs: startedAt });
						await publishReplace(path, next, PRIVATE);
						mine = next;
					}),
				release: () =>
					serialized(async () => {
						if ((await readLeaseText(path)) === mine) await unlinkIfPresent(path);
					}),
			};
		} catch (error) {
			const code = errorCode(error);
			if (code === "ENOENT") {
				await mkdir(join(dir, "sessions"), { recursive: true, mode: 0o700 });
				continue;
			}
			if (code !== "EEXIST") throw error;
		}
		const state = await reclaimLockState(path);
		if (state.state === "held") return { acquired: false, heldByPid: state.holder?.pid };
		if (state.state === "stale") {
			const lockAgeMs = await stat(path).then(
				(info) => Date.now() - info.mtimeMs,
				() => 0,
			);
			const delivering = await orphanedDelivery(state.raw, lockAgeMs, probes);
			if (delivering !== undefined) return { acquired: false, heldByPid: delivering };
			await breakStaleLock(path, state.raw);
		}
	}
	return { acquired: false, heldByPid: undefined };
}
