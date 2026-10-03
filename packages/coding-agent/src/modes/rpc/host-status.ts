/**
 * What a client can observe about the daemon on one socket, in one record.
 *
 * Everything that describes the RUNNING host comes from the host's own answers - `get_protocol_info`
 * for identity, `list_sessions` for occupancy - because files describe the past and the socket
 * describes the present. Everything that describes the DAEMON DIRECTORY (which generations exist,
 * which environment scope the last ensure granted) comes from disk, because a generation that no
 * longer answers is exactly what an operator is looking for when they ask.
 *
 * A socket nobody serves is not an error here: `reachable: false` with the same field set is the
 * answer, so a caller parses one shape either way and branches on one boolean.
 */
import { isHostCrash, readHostCrashRecords } from "./host-crash-record.ts";
import { readDaemonEnvKeys } from "./host-daemon-env.ts";
import { createHostDaemonPaths, parseShardSocket, type ShardKind } from "./host-daemon-paths.ts";
import type { HostProtocolInfo } from "./host-decision.ts";
import { type HostGenerationRow, pruneDeadGenerations, readGenerationRows } from "./host-generations.ts";
import { OBSERVE_REQUEST_FIELD } from "./host-observe-request.ts";
import { observeProtocolInfo, requestOnSocket } from "./host-probe.ts";
import { type HostProcessMetrics, readHostProcessMetrics } from "./host-process-metrics.ts";
import { type HostPathClaimRow, type HostSessionRow, parseSessionRows, readClaimRows } from "./host-status-rows.ts";
import type { RpcLaunchProfile } from "./rpc-types.ts";

const STATUS_PROBE_TIMEOUT_MS = 10_000;

/**
 * Sessions the host reports. `foreign_*` is the same count from the point of view of a client that
 * holds none of them itself: for the CLI every session belongs to somebody else, which is exactly
 * why a hard stop is gated on it.
 */
export interface HostSessionCounts {
	readonly total: number;
	readonly interactive: number;
	readonly worker: number;
	/** Open at zero attachments: retained across a disconnect, still holding its transcript. */
	readonly retained: number;
	readonly foreign_attached: number;
	readonly foreign_retained: number;
}

export type { HostGenerationRow } from "./host-generations.ts";
export type { HostPathClaimRow, HostSessionRow } from "./host-status-rows.ts";

export interface HostStatusReport {
	readonly reachable: boolean;
	readonly socket: string;
	readonly pid: number | null;
	readonly instanceId: string | null;
	readonly generation: number | null;
	readonly engineVersion: string | null;
	readonly capabilities: readonly string[];
	readonly launchProfile: RpcLaunchProfile | null;
	/** Content digest of the runtime the ANSWERING host loaded at startup; `null` when nothing answers or it predates the field. */
	readonly runtimeBuildId: string | null;
	/** The conditional idle handover the answering host holds (`handover_pending`, ...); `null` when it holds none. */
	readonly handover: Readonly<Record<string, unknown>> | null;
	readonly sessions: HostSessionCounts;
	readonly zombies: number | null;
	readonly rss_mb: number | null;
	readonly host_rss_mb: number | null;
	readonly open_fds: number | null;
	/**
	 * Whether the ANSWERING generation's memory sampler reads pressure right now (RSS above
	 * `SENPI_RPC_HOST_RSS_WARN_MB`); `null` when nothing answers or the host predates the field.
	 */
	readonly memory_pressure: boolean | null;
	/** Environment NAMES the daemon was granted, never values. */
	readonly env_keys: readonly string[];
	readonly generations: readonly HostGenerationRow[];
	/** Records in this endpoint's `crashes.jsonl`: supervised host children that DIED, not stopped. */
	readonly crashes: number;
	/** The owner-keyed shard the socket names (`<kind>-<16hex>.sock`), `null` for any other endpoint. */
	readonly shard: { readonly kind: ShardKind; readonly key: string } | null;
	/** Every listed session, only when workers were asked for; `[]` otherwise. */
	readonly session_rows: readonly HostSessionRow[];
	/** Session-path claims in `reservations/` whose owner process is still running. */
	readonly claims_live: number;
	/** Every claim in `reservations/`, whichever generation wrote it, only when workers were asked for. */
	readonly claims: readonly HostPathClaimRow[];
}

export interface HostStatusOptions {
	readonly socket: string;
	readonly agentDir?: string;
	/** Ask the host to include `kind: "worker"` rows, exactly as `list_sessions` defines the flag. */
	readonly includeWorkers?: boolean;
}

/**
 * How a status read treats the daemon directory. `prune` (the default, and the single-socket
 * `status`) removes what ended before reporting; `prune: false` (`status --all`) reports dead
 * generations as `alive: false` rows and removes nothing.
 */
export interface HostStatusReadOptions {
	readonly prune?: boolean;
	/** Budget for each read of the socket, default 10 s. */
	readonly timeoutMs?: number;
}

export async function readHostStatus(
	options: HostStatusOptions,
	read: HostStatusReadOptions = {},
): Promise<HostStatusReport> {
	return (await probeHostStatus(options, read)).report;
}

/**
 * The report plus what the socket itself said, which the report blends with the directory: `answered`
 * is the raw `get_protocol_info` answer (`undefined` when nothing answered) - the report's `instanceId`
 * falls back to the RECORDED generation, so only this says whether the socket named an instance - and
 * `listing` is every row `list_sessions` returned, whether or not the report publishes them.
 */
export async function probeHostStatus(
	options: HostStatusOptions,
	read: HostStatusReadOptions = {},
): Promise<{
	readonly report: HostStatusReport;
	readonly answered: HostProtocolInfo | undefined;
	readonly listing: readonly HostSessionRow[];
}> {
	const paths = createHostDaemonPaths({
		socket: options.socket,
		...(options.agentDir ? { agentDir: options.agentDir } : {}),
	});
	const prune = read.prune !== false;
	const includeWorkers = options.includeWorkers === true;
	// Both reads observe: looking at a host must never be what keeps it from idling out.
	const timeoutMs = read.timeoutMs ?? STATUS_PROBE_TIMEOUT_MS;
	const host = await observeProtocolInfo(options.socket, timeoutMs);
	// Reading the directory is also when it is cleaned: an operator asking what runs here must not
	// be shown generations that ended, and the next reader must get the same answer.
	if (prune) await pruneDeadGenerations(paths);
	const generations = await readGenerationRows(paths, { includeDead: !prune });
	const current = generations.find((row) => row.current && row.alive);
	const metrics = current ? await readHostProcessMetrics(current.pid) : UNOBSERVED_METRICS;
	// A socket that did not answer who it is will not answer what it holds: asking again would only
	// spend a second budget on a hung endpoint.
	const listing: readonly HostSessionRow[] =
		host === undefined ? [] : await readSessionListing(options.socket, includeWorkers, timeoutMs);
	const claims = await readClaimRows(paths, generations);
	const report: HostStatusReport = {
		reachable: host !== undefined,
		socket: options.socket,
		pid: current?.pid ?? null,
		instanceId: host?.instanceId ?? current?.instanceId ?? null,
		generation: host?.generation ?? current?.generation ?? null,
		engineVersion: host?.engineVersion ?? current?.engineVersion ?? null,
		capabilities: host?.capabilities ?? [],
		launchProfile: host?.launch_profile ?? null,
		runtimeBuildId: host?.runtimeBuildId ?? null,
		handover: host?.handover ?? null,
		sessions: countSessions(listing),
		zombies: metrics.zombies,
		rss_mb: metrics.rss_mb,
		host_rss_mb: metrics.host_rss_mb,
		open_fds: metrics.open_fds,
		memory_pressure: host?.memory_pressure ?? null,
		env_keys: await readDaemonEnvKeys(paths),
		generations,
		crashes: readHostCrashRecords(paths.dir).filter(isHostCrash).length,
		shard: parseShardSocket(options.socket),
		session_rows: includeWorkers ? listing : [],
		claims_live: claims.filter((claim) => claim.live).length,
		claims: includeWorkers ? claims : [],
	};
	return { report, answered: host, listing };
}

/**
 * The occupancy a stop decision is made on. A host that does not answer holds nothing a client can
 * see, and an empty count is what lets a stop proceed against a socket nobody serves.
 */
export async function readSessionCounts(socket: string, includeWorkers: boolean): Promise<HostSessionCounts> {
	return countSessions(await readSessionListing(socket, includeWorkers));
}

async function readSessionListing(
	socket: string,
	includeWorkers: boolean,
	timeoutMs = STATUS_PROBE_TIMEOUT_MS,
): Promise<readonly HostSessionRow[]> {
	const reply = await requestOnSocket(
		socket,
		{ type: "list_sessions", [OBSERVE_REQUEST_FIELD]: true, ...(includeWorkers ? { include_workers: true } : {}) },
		timeoutMs,
	);
	return parseSessionRows(reply);
}

function countSessions(rows: readonly HostSessionRow[]): HostSessionCounts {
	const attached = rows.filter((row) => row.attachments > 0).length;
	const retained = rows.length - attached;
	return {
		total: rows.length,
		interactive: rows.filter((row) => row.kind !== "worker").length,
		worker: rows.filter((row) => row.kind === "worker").length,
		retained,
		foreign_attached: attached,
		foreign_retained: retained,
	};
}

/** Identity fields of a probed host, for the `host` field of a refusal. */
export function hostSummary(host: HostProtocolInfo | undefined): Record<string, unknown> | null {
	if (host === undefined) return null;
	return {
		protocolVersion: host.protocolVersion,
		serverVersion: host.serverVersion,
		capabilities: host.capabilities,
		instanceId: host.instanceId ?? null,
		generation: host.generation ?? null,
		engineVersion: host.engineVersion ?? null,
		launchProfileId: host.launch_profile?.profile_id ?? null,
	};
}

const UNOBSERVED_METRICS: HostProcessMetrics = { rss_mb: null, host_rss_mb: null, open_fds: null, zombies: null };
