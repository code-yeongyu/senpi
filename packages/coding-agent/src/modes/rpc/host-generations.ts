/**
 * Which generations of one daemon are still RUNNING, and what a dead one leaves behind.
 *
 * The daemon directory accumulates a record per generation, and nothing used to remove one: after a
 * handoff, an idle exit or a kill, `generations/<instanceId>/host.pid` stayed, the pointer could go
 * on naming a process nobody runs, and `reservations/` kept claims of hosts that had been gone for
 * days (#1893: the directory described only dead pids while three supervisors were alive). Reading
 * it therefore has to mean pruning it - a record that names a pid nobody is running is not history,
 * it is a lie about what serves this endpoint.
 *
 * Both answers come from files rather than from the socket on purpose: a generation that no longer
 * answers is exactly what an operator is looking for, and a superseded host holding gigabytes
 * cannot be asked how many sessions it has.
 */
import { createHash, randomUUID } from "node:crypto";
import { link, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	processIsLive,
	processIsRunning,
	processStartTimeMs,
	readProcessStartTime,
	sameProcessStartMs,
} from "../../utils/process-identity.ts";
import { generationPaths, type HostDaemonDirectory, type HostDaemonPaths } from "./host-daemon-paths.ts";
import { parseJson, readFileOrUndefined } from "./host-daemon-state.ts";
import { type HostProcessMetrics, readHostProcessMetrics } from "./host-process-metrics.ts";
import { generationHeartbeatStopped, hostChildAlive } from "./host-stalled-evidence.ts";
import { logUnknownHostIdentity } from "./host-supervisor-log.ts";

/** One generation that is still running, as the daemon directory and the OS describe it. */
export interface HostGenerationRow {
	readonly instanceId: string;
	readonly generation: number;
	readonly pid: number;
	readonly engineVersion: string | null;
	/** Resident memory of that generation's process tree, `null` where the platform hides it. */
	readonly rss_mb: number | null;
	/** Resident memory of that generation's own supervisor and host processes, without their tools. */
	readonly host_rss_mb: number | null;
	/** Session files this generation still claims in `reservations/`. */
	readonly sessions: number;
	/** True for the generation the pointer names: the one serving the socket. */
	readonly current: boolean;
	readonly alive: boolean;
}

/** What one prune removed, so a caller can report it instead of guessing. */
export interface PrunedDaemonState {
	/** Instance ids whose generation directory named a dead pid. */
	readonly generations: readonly string[];
	/** Session paths whose claim named a dead owner. */
	readonly claims: readonly string[];
	/** Whether the pointer itself named one of those dead generations. */
	readonly pointer: boolean;
}

export interface PruneOptions {
	/** Deterministic race seam: runs after the pointer was read and before it is removed. */
	readonly _test?: { readonly beforePointerRemoval?: () => Promise<void> };
}

/**
 * Drops every record of a generation that is no longer running: its directory, the pointer while it
 * still names it, and the session-path claims its pid published. A record that cannot be parsed is
 * LEFT - an ensure writing one right now must not be mistaken for a generation that ended.
 */
export async function pruneDeadGenerations(
	paths: HostDaemonPaths,
	options: PruneOptions = {},
): Promise<PrunedDaemonState> {
	const pointerText = await readFileOrUndefined(paths.pointerFile).catch(() => undefined);
	const pointer = parseJson(pointerText);
	const pointedAt = typeof pointer?.instance_id === "string" ? pointer.instance_id : undefined;
	const generations: string[] = [];
	for (const instanceId of await readdir(paths.generationsDir).catch(() => [] as string[])) {
		const record = parseJson(await readFileOrUndefined(generationPaths(paths, instanceId).pidFile));
		if (typeof record?.pid !== "number" || processIsLive(record.pid)) continue;
		if (await hostChildAlive(generationPaths(paths, instanceId))) continue;
		generations.push(instanceId);
	}
	// Claims end before the directories go: a prune cut short in between must not leave a claim whose generation
	// (and heartbeat) no longer exists to explain it.
	const claims = await endClaimsOfEndedGenerations(paths, new Set(generations));
	for (const instanceId of generations)
		await rm(generationPaths(paths, instanceId).dir, { recursive: true, force: true }).catch(() => undefined);
	// The pointer outliving its generation is what makes a client probe a socket nobody serves.
	const pointerNamesDead = pointerText !== undefined && pointedAt !== undefined && generations.includes(pointedAt);
	if (pointerNamesDead) await options._test?.beforePointerRemoval?.();
	const pointerRemoved = pointerNamesDead && (await removePointerIfUnchanged(paths, pointerText));
	return { generations, claims, pointer: pointerRemoved };
}

/**
 * Removes the pointer only while it is still the one this prune read (senpi#1911). Prune runs outside the
 * ensure lock (`host status`), so a registration may have renamed a new pointer in since: the file is
 * moved aside atomically, compared, and a replacement is linked back unless an even newer one landed.
 */
async function removePointerIfUnchanged(paths: HostDaemonPaths, read: string): Promise<boolean> {
	const parked = `${paths.pointerFile}.prune-${process.pid}-${randomUUID()}.tmp`;
	const moved = await rename(paths.pointerFile, parked).then(
		() => true,
		() => false,
	);
	if (!moved) return false;
	const unchanged = (await readFileOrUndefined(parked).catch(() => undefined)) === read;
	if (!unchanged) await link(parked, paths.pointerFile).catch(() => undefined);
	await rm(parked, { force: true }).catch(() => undefined);
	return unchanged;
}

/**
 * Removes every claim whose owner is gone, and every claim of a generation in `ended` (being removed by the caller)
 * whose owner identity cannot be proven. Returns the session paths released. Every path that removes a generation
 * directory calls this first, so no generation leaves claims behind that its directory no longer explains.
 */
export async function endClaimsOfEndedGenerations(
	paths: HostDaemonDirectory,
	ended: ReadonlySet<string>,
): Promise<string[]> {
	const claims: string[] = [];
	for (const claim of await readSessionPathClaims(paths.reservationsDir)) {
		if (!(await claimEnded(claim.owner, ended))) continue;
		await rm(claim.file, { force: true }).catch(() => undefined);
		claims.push(claim.owner.sessionPath);
	}
	return claims;
}

/**
 * A claim ends with its owner's pid, or with the generation this prune just removed when the owner's identity
 * cannot be proven (desktop#3157: Windows hands the dead host child's pid to another process, and removing the
 * generation also removed the heartbeat that would have released the claim). Such an owner might only be frozen,
 * so its session file is fenced first; a fence that cannot be written keeps the claim.
 */
async function claimEnded(owner: SessionPathOwner, ended: ReadonlySet<string>): Promise<boolean> {
	const identity = await claimOwnerIdentity(owner);
	if (identity === "gone") return true;
	if (identity === "proven" || !ended.has(owner.instanceId)) return false;
	// Documented lazy boundary (AGENTS.md: inline dynamic imports only at documented lazy boundaries): the lifecycle
	// supervisor imports this module, and the fence module (whose writers read it synchronously) must stay out of its
	// startup graph (test/supervisor-import-graph.test.ts).
	return import("../../core/session-write-fence.ts")
		.then(({ advanceSessionFence }) => advanceSessionFence(owner.sessionPath))
		.then(
			() => true,
			() => false,
		);
}

function memoryOf(metrics: HostProcessMetrics): Pick<HostGenerationRow, "rss_mb" | "host_rss_mb"> {
	return { rss_mb: metrics.rss_mb, host_rss_mb: metrics.host_rss_mb };
}

/**
 * Every generation of this daemon that is still running, newest ordinal last. A record naming a
 * dead pid is omitted rather than reported as history: `host status` answers who is alive now.
 * `includeDead` is for the reader that must not prune (`host status --all`): a dead record is then
 * reported as a row with `alive: false` instead of being dropped, so the stale state stays visible.
 */
export async function readGenerationRows(
	paths: HostDaemonDirectory,
	options: { readonly includeDead?: boolean } = {},
): Promise<readonly HostGenerationRow[]> {
	const pointer = parseJson(await readFileOrUndefined(paths.pointerFile).catch(() => undefined));
	const currentId = typeof pointer?.instance_id === "string" ? pointer.instance_id : undefined;
	const claims = await readSessionPathClaims(paths.reservationsDir);
	const rows: HostGenerationRow[] = [];
	for (const instanceId of await readdir(paths.generationsDir).catch(() => [] as string[])) {
		const record = parseJson(await readFileOrUndefined(generationPaths(paths, instanceId).pidFile));
		if (typeof record?.pid !== "number") continue;
		const alive = processIsLive(record.pid) || (await hostChildAlive(generationPaths(paths, instanceId))) === true;
		if (!alive && options.includeDead !== true) continue;
		rows.push({
			instanceId,
			generation: typeof record.generation === "number" ? record.generation : 0,
			pid: record.pid,
			engineVersion: typeof record.engineVersion === "string" ? record.engineVersion : null,
			...(alive ? memoryOf(await readHostProcessMetrics(record.pid)) : { rss_mb: null, host_rss_mb: null }),
			sessions: claims.filter((claim) => claim.owner.instanceId === instanceId).length,
			current: instanceId === currentId,
			alive,
		});
	}
	return rows.sort((left, right) => left.generation - right.generation);
}

/*
 * The session-path claims a generation publishes in `reservations/` (written by `host-reservations.ts`): who holds
 * one, whether that owner still runs, and whether its claim stands against a new open.
 */

/** One published claim, as a reader of the directory finds it. */
export interface SessionPathClaim {
	readonly file: string;
	readonly owner: SessionPathOwner;
}

/** One claim per canonical session path, named by its hash so the file name is bounded. */
export function reservationFile(dir: string, sessionPath: string): string {
	return join(dir, `${createHash("sha256").update(sessionPath, "utf8").digest("hex").slice(0, 16)}.json`);
}

/** Every claim published in one reservations directory, for a reader pruning or reporting them. */
export async function readSessionPathClaims(dir: string): Promise<readonly SessionPathClaim[]> {
	const entries = await readdir(dir).catch(() => [] as string[]);
	const claims: SessionPathClaim[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const file = join(dir, entry);
		const owner = await readOwner(file);
		if (owner) claims.push({ file, owner });
	}
	return claims;
}

export interface SessionPathOwner {
	readonly instanceId: string;
	readonly host_socket?: string;
	readonly pid: number;
	readonly processStartTime: string | null;
	readonly sessionPath: string;
	/** Whether the owner had a client attached when it last published this claim. */
	readonly attached?: boolean;
	/**
	 * The owner hands the session over only by a strict transfer and removes this claim itself once the
	 * session is torn down (code-yeongyu/oh-my-openagent#10091): superseded and detached, it may still be
	 * running a turn in the file, so its claim stands for as long as its process does.
	 */
	readonly strict_transfer?: boolean;
	/** Whether the owner is the generation the pointer names. Answered on read, never stored. */
	readonly current?: boolean;
}

/**
 * `presumed_done`: the owner may still be alive (a frozen loop or a sleeping machine also stops the heartbeat), so the
 * takeover must fence it out of the session file first.
 */
export type ClaimVerdict =
	| { readonly kind: "stands"; readonly owner: SessionPathOwner }
	| { readonly kind: "released" }
	| { readonly kind: "presumed_done" };

/**
 * The claim that STANDS against a new open, or nothing when this path may be taken over.
 *
 * A claim is honored while its owner is the generation serving the socket, or while that owner
 * still has a client attached to the session - those are the two cases where somebody is really
 * writing the file. A superseded owner that published `attached: false` is draining (or should
 * be), so its claim is released rather than obeyed. A claim without the flag predates it and is
 * honored, so a running older generation is never reclaimed from. A strict-transfer owner's claim
 * stands while its process does: it releases the claim itself, once nothing can write the file.
 *
 * A superseded owner whose identity cannot be PROVEN - no start time was recorded, or none can be read
 * now - needs one more piece of evidence before it may block an open (#3652). On Windows a terminated
 * generation leaves its claim behind and the OS hands its pid to an unrelated process; without a
 * readable start time that stranger would hold the session file for as long as it runs. So such a
 * claim stands only while its generation still heartbeats: a heartbeat older than the stall-refusal
 * window is the same "died without cleaning up" verdict `hostLoopStalled` already reaches. A live
 * host whose probe is merely starved (#1609) keeps heartbeating and keeps its claim; a claim with no
 * heartbeat at all (an unsupervised or older host) keeps the previous benefit of the doubt.
 */
export async function standingOwner(owner: SessionPathOwner, paths: HostDaemonDirectory): Promise<ClaimVerdict> {
	const identity = await claimOwnerIdentity(owner);
	if (identity === "gone") return { kind: "released" };
	const current = (await currentInstanceId(paths.pointerFile)) === owner.instanceId;
	if (!current && identity === "unproven" && (await heartbeatStopped(paths, owner.instanceId)))
		return { kind: "presumed_done" };
	return current || owner.attached !== false || owner.strict_transfer === true
		? { kind: "stands", owner: { ...owner, current } }
		: { kind: "released" };
}

/** Whether the owner's generation left a heartbeat that is older than a stalled host could explain. */
async function heartbeatStopped(paths: HostDaemonDirectory, instanceId: string): Promise<boolean> {
	// A claim file is untrusted input: an instance id that is not a plain directory name names no generation.
	if (instanceId === "" || instanceId === "." || instanceId === ".." || /[\\/]/.test(instanceId)) return false;
	return generationHeartbeatStopped(generationPaths(paths, instanceId));
}

/** The generation the pointer names, or nothing when no pointer describes this endpoint. */
async function currentInstanceId(pointerFile: string): Promise<string | undefined> {
	const pointer = parseJson(await readFileOrUndefined(pointerFile).catch(() => undefined));
	return typeof pointer?.instance_id === "string" ? pointer.instance_id : undefined;
}

export async function readOwner(file: string): Promise<SessionPathOwner | undefined> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(file, "utf8"));
	} catch {
		// Absent, unreadable or half-written: no claim that anyone could act on.
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { instanceId, pid, processStartTime, sessionPath, attached, host_socket, strict_transfer } = parsed as Record<
		string,
		unknown
	>;
	if (typeof instanceId !== "string" || typeof pid !== "number" || typeof sessionPath !== "string") return undefined;
	return {
		instanceId,
		pid,
		processStartTime: typeof processStartTime === "string" ? processStartTime : null,
		sessionPath,
		...(typeof host_socket === "string" ? { host_socket } : {}),
		...(typeof attached === "boolean" ? { attached } : {}),
		...(strict_transfer === true ? { strict_transfer } : {}),
	};
}

/**
 * A claim counts only while the process that made it is still running. The recorded start time is
 * what separates "that host is still writing" from "the OS handed its pid to something else".
 */
export async function claimOwnerIsLive(owner: SessionPathOwner): Promise<boolean> {
	return (await claimOwnerIdentity(owner)) !== "gone";
}

/**
 * `proven`: the pid runs and its start time matches the claim. `gone`: the pid is dead, or runs with a
 * different start time. `unproven`: the pid runs but no start time was recorded or none can be read.
 */
export async function claimOwnerIdentity(owner: SessionPathOwner): Promise<"proven" | "gone" | "unproven"> {
	// An exited, unreaped owner (state Z) makes no more writes: the claim is gone (senpi#4119).
	if (!processIsRunning(owner.pid)) return "gone";
	const recorded = owner.processStartTime === null ? undefined : processStartTimeMs(owner.processStartTime);
	if (recorded === undefined) {
		logUnknownHostIdentity("session-path-claim", owner.pid);
		return "unproven";
	}
	const current = await readProcessStartTime(owner.pid).catch(() => undefined);
	const observed = current === undefined ? undefined : processStartTimeMs(current);
	if (observed === undefined) return "unproven";
	return sameProcessStartMs(recorded, observed) ? "proven" : "gone";
}
