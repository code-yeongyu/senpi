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
import { readdir, rm } from "node:fs/promises";
import { processIsLive } from "../app-server/daemon/process.ts";
import { generationPaths, type HostDaemonDirectory, type HostDaemonPaths } from "./host-daemon-paths.ts";
import { parseJson, readFileOrUndefined } from "./host-daemon-state.ts";
import { type HostProcessMetrics, readHostProcessMetrics } from "./host-process-metrics.ts";
import { claimOwnerIsLive, readSessionPathClaims } from "./host-reservations.ts";

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

/**
 * Drops every record of a generation that is no longer running: its directory, the pointer while it
 * still names it, and the session-path claims its pid published. A record that cannot be parsed is
 * LEFT - an ensure writing one right now must not be mistaken for a generation that ended.
 */
export async function pruneDeadGenerations(paths: HostDaemonPaths): Promise<PrunedDaemonState> {
	const pointer = parseJson(await readFileOrUndefined(paths.pointerFile).catch(() => undefined));
	const pointedAt = typeof pointer?.instance_id === "string" ? pointer.instance_id : undefined;
	const generations: string[] = [];
	for (const instanceId of await readdir(paths.generationsDir).catch(() => [] as string[])) {
		const record = parseJson(await readFileOrUndefined(generationPaths(paths, instanceId).pidFile));
		if (typeof record?.pid !== "number" || processIsLive(record.pid)) continue;
		await rm(generationPaths(paths, instanceId).dir, { recursive: true, force: true }).catch(() => undefined);
		generations.push(instanceId);
	}
	const pointerRemoved = pointedAt !== undefined && generations.includes(pointedAt);
	// The pointer outliving its generation is what makes a client probe a socket nobody serves.
	if (pointerRemoved) await rm(paths.pointerFile, { force: true }).catch(() => undefined);
	const claims: string[] = [];
	for (const claim of await readSessionPathClaims(paths.reservationsDir)) {
		if (await claimOwnerIsLive(claim.owner)) continue;
		await rm(claim.file, { force: true }).catch(() => undefined);
		claims.push(claim.owner.sessionPath);
	}
	return { generations, claims, pointer: pointerRemoved };
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
		const alive = processIsLive(record.pid);
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
