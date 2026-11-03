/**
 * Whether a RUNNING host is a stale older-engine leftover that a newer client may stop (#3268).
 *
 * A host stays up only while its own idle decision says so, and a host of an older engine runs that
 * engine's decision: when it is wrong, no fix in a newer build reaches the process. A newer client
 * may therefore end such a host, and only when every one of these holds, each read errs toward
 * "keep":
 *
 *     stale_unproven_owner  the registration does not prove the process serving this socket (I1)
 *     stale_clients         the supervisor holds an accepted public connection, or that cannot be read
 *     stale_unreachable     the host does not answer an observing `get_protocol_info`
 *     stale_not_older       its engine ordinal is not STRICTLY older than the caller's (I2: unknown is equal)
 *     stale_persistent      its recorded policy is `persistent`: an operator asked it to stay
 *     stale_sessions        it lists any session, workers included, or does not answer the listing
 *     stale_claims          any session-path claim exists under its `reservations/`
 *     stale_young           it has been up less than its own recorded idle window plus the grace
 *
 * Every probe is an observing read, so judging a host never resets its idle window. The caller
 * judges inside the endpoint's ensure lock and stops through `stopHost`, which re-reads the session
 * count before it signals.
 */
import { compareEngineOrdinal, type EngineBuildIdentity } from "../../core/engine-build-identity.ts";
import { processStartTimeMs } from "../../utils/process-identity.ts";
import { createHostDaemonPaths } from "./host-daemon-paths.ts";
import { provenOwner, readHostRegistration } from "./host-daemon-registration.ts";
import { parseJson, readFileOrUndefined } from "./host-daemon-state.ts";
import { resolveHostPolicy } from "./host-lifecycle-policy.ts";
import { OBSERVE_REQUEST_FIELD } from "./host-observe-request.ts";
import { observeProtocolInfo, requestOnSocket } from "./host-probe.ts";
import { countPublicClients } from "./host-public-clients.ts";
import { readSessionPathClaims } from "./host-reservations.ts";

export type StaleEngineKeep =
	| "stale_unproven_owner"
	| "stale_unreachable"
	| "stale_not_older"
	| "stale_persistent"
	| "stale_sessions"
	| "stale_claims"
	| "stale_young"
	| "stale_clients";

export type StaleEngineVerdict =
	| { readonly stale: true; readonly pid: number }
	| { readonly stale: false; readonly reason: StaleEngineKeep };

export interface StaleEngineOptions {
	readonly client?: EngineBuildIdentity;
	readonly now?: () => number;
	readonly graceMs?: number;
}

export const STALE_ENGINE_GRACE_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 2_000;

export async function judgeStaleEngine(
	socket: string,
	agentDir: string,
	client: EngineBuildIdentity,
	options: StaleEngineOptions = {},
): Promise<StaleEngineVerdict> {
	const paths = createHostDaemonPaths({ socket, agentDir });
	const owner = await provenOwner(await readHostRegistration(paths), socket);
	if (owner === undefined) return keep("stale_unproven_owner");
	// Counted before this judge's own probes connect, so none of them can be read back as a client.
	const clients = await countPublicClients(owner.pid, socket);
	const info = await observeProtocolInfo(socket, PROBE_TIMEOUT_MS);
	if (info === undefined) return keep("stale_unreachable");
	const hostOrdinal = info.engineOrdinal;
	const hostIdentity: EngineBuildIdentity | undefined =
		hostOrdinal === undefined
			? undefined
			: { text: info.engineVersion ?? "", ordinal: hostOrdinal, scheme: hostOrdinal[4] > 0 ? "epoch" : "nodef" };
	if (hostIdentity === undefined || compareEngineOrdinal(hostIdentity, client) !== -1) return keep("stale_not_older");
	const policy = resolveHostPolicy(parseJson(await readFileOrUndefined(paths.settingsFile)), {});
	if (policy.coldStart === "persistent") return keep("stale_persistent");
	if ((await observedSessionCount(socket)) !== 0) return keep("stale_sessions");
	if ((await readSessionPathClaims(paths.reservationsDir)).length > 0) return keep("stale_claims");
	const startedAt = processStartTimeMs(owner.processStartTime);
	const now = (options.now ?? Date.now)();
	if (startedAt === undefined || now - startedAt < policy.idleExitMs + (options.graceMs ?? STALE_ENGINE_GRACE_MS)) {
		return keep("stale_young");
	}
	if (clients !== 0) return keep("stale_clients");
	return { stale: true, pid: owner.pid };
}

function keep(reason: StaleEngineKeep): StaleEngineVerdict {
	return { stale: false, reason };
}

async function observedSessionCount(socket: string): Promise<number | undefined> {
	const reply = await requestOnSocket(
		socket,
		{ type: "list_sessions", include_workers: true, [OBSERVE_REQUEST_FIELD]: true },
		PROBE_TIMEOUT_MS,
	);
	if (typeof reply !== "object" || reply === null) return undefined;
	const sessions: unknown = Reflect.get(reply, "sessions");
	return Array.isArray(sessions) ? sessions.length : undefined;
}
