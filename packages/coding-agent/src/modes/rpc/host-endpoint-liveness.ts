/**
 * WHETHER an endpoint can be talked to right now, and when it provably never will be again.
 *
 *     routable           an authenticated connection answered `get_protocol_info` with an instance
 *                        this directory recorded (`generations/<instanceId>/host.pid`)
 *     dead               nothing answered and no recorded generation still runs: its pid is gone, or
 *                        the pid now belongs to a process started at another time (`processStartTime`,
 *                        the existing `ps -o lstart=` / CIM CreationDate encoding)
 *     live_unresponsive  everything else - a suspended TUI, a host past its probe budget, a live pid
 *                        whose identity cannot be read, an answer from an instance nothing recorded
 *
 * "dead" is judged exactly as `host gc` judges its first condition (`anyGenerationLive`), so this
 * verdict never calls an endpoint dead that gc would keep for a live generation. It is not gc: it
 * removes nothing and signals nothing (I3); a caller that wants a directory gone still goes through
 * `gcHostEndpoints` and its three-part evidence under the ensure lock.
 */
import { readdir } from "node:fs/promises";
import {
	type EndpointKind,
	generationPaths,
	type HostDaemonDirectory,
	hostDaemonDirectoryPaths,
} from "./host-daemon-paths.ts";
import { readFileOrUndefined } from "./host-daemon-state.ts";
import type { HostEndpointEntry } from "./host-endpoints.ts";
import { anyGenerationLive } from "./host-gc-evidence.ts";
import { DEFAULT_PROBE_TIMEOUT_MS, observeProtocolInfo } from "./host-probe.ts";

export type EndpointLiveness = "routable" | "live_unresponsive" | "dead";

/**
 * A TUI answers from the user's terminal process: a suspended (`^Z`) or busy one must cost a caller
 * at most this long, so one stopped terminal never stalls a listing of every endpoint.
 */
export const TUI_PROBE_TIMEOUT_MS = 1_500;

/** The probe budget for one endpoint of `kind`; a `tui` endpoint never gets more than TUI_PROBE_TIMEOUT_MS. */
export function endpointProbeTimeoutMs(kind: EndpointKind, requestedMs?: number): number {
	if (kind === "tui") return Math.min(requestedMs ?? TUI_PROBE_TIMEOUT_MS, TUI_PROBE_TIMEOUT_MS);
	return requestedMs ?? DEFAULT_PROBE_TIMEOUT_MS;
}

/** Probes the endpoint once, under its kind's budget, and judges it. Reads only. */
export async function classifyEndpointLiveness(
	entry: Pick<HostEndpointEntry, "socket" | "dir" | "endpoint_kind">,
	options: { readonly timeoutMs?: number } = {},
): Promise<EndpointLiveness> {
	const host =
		entry.socket === null
			? undefined
			: await observeProtocolInfo(entry.socket, endpointProbeTimeoutMs(entry.endpoint_kind, options.timeoutMs));
	return judgeEndpointLiveness(
		hostDaemonDirectoryPaths(entry.dir),
		host === undefined ? undefined : (host.instanceId ?? null),
	);
}

/**
 * The verdict from an answer already in hand, for a reader that probed the socket itself
 * (`status --all`): `undefined` when nothing answered, `null` when a host answered without naming its
 * instance, else the instance id it named. Anything that answered is never `dead`.
 */
export async function judgeEndpointLiveness(
	paths: HostDaemonDirectory,
	answered: string | null | undefined,
): Promise<EndpointLiveness> {
	if (typeof answered === "string" && (await recordsInstance(paths, answered))) return "routable";
	if (answered !== undefined) return "live_unresponsive";
	return (await anyGenerationLive(paths)) ? "live_unresponsive" : "dead";
}

/** Whether `instanceId` is a generation this directory recorded; the answer is matched, never joined into a path. */
async function recordsInstance(paths: HostDaemonDirectory, instanceId: string): Promise<boolean> {
	const recorded = await readdir(paths.generationsDir).catch(() => [] as string[]);
	if (!recorded.includes(instanceId)) return false;
	return (await readFileOrUndefined(generationPaths(paths, instanceId).pidFile).catch(() => undefined)) !== undefined;
}
