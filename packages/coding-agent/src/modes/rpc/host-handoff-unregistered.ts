/**
 * A handoff away from a host that no layout-2 registration proves (#2701).
 *
 * After an upgrade the old host is often still serving the very socket the updated client uses, and the
 * only evidence of who it is may be a flat pre-layout-2 record - or nothing provable at all. Refusing
 * such a host with `unknown_owner` left the client unable to replace it until somebody drained it by
 * hand. An IDLE one is replaced instead; one that holds work never is.
 *
 * - The sessions are counted over a connection that stays open, and counted again over that same
 *   connection once the successor owns the socket: the recount reaches the old process, and a session
 *   it accepted in between is seen there.
 * - A flat record that proves the process is the only licence to signal it, and the signal is a DRAIN
 *   (SIGUSR1), sent only when the recount still finds no session. A drain ends no work either way.
 * - Without a provable owner nothing is signalled: the old host notices that it lost the public entry
 *   and drains itself (`host-supersession.ts`). That predecessor is named in one warning line, so an
 *   old host that outlives the handoff can still be identified.
 */
import type { HostDaemonPaths } from "./host-daemon-paths.ts";
import type { HostProtocolInfo } from "./host-decision.ts";
import type { HandoffHostOptions, HandoffResult } from "./host-handoff.ts";
import { busyLegacyHostDetail, describeSessions, provenLegacyOwner } from "./host-legacy.ts";
import { holdSessionCount } from "./host-probe.ts";
import { startSuccessor } from "./host-successor.ts";

/** One session count; an unregistered host is counted twice (before the swap and over the held connection after). */
export const SESSION_COUNT_TIMEOUT_MS = 10_000;

export async function handoffUnregisteredHost(
	options: HandoffHostOptions,
	paths: HostDaemonPaths,
	host: HostProtocolInfo,
): Promise<HandoffResult> {
	const counted = await holdSessionCount(options.socket, SESSION_COUNT_TIMEOUT_MS);
	try {
		const legacy = await provenLegacyOwner(paths, options.socket);
		const sessions = counted?.sessions;
		if (sessions !== 0) {
			if (legacy !== undefined) {
				return {
					action: "refuse",
					reason: "legacy_host",
					upgradeable: true,
					detail: busyLegacyHostDetail(legacy.pid, options.socket, sessions),
				};
			}
			return {
				action: "refuse",
				reason: "unknown_owner",
				upgradeable: true,
				detail: `${options.socket} has no provable owner and holds ${describeSessions(sessions)}; it is never signalled - let that work finish, then retry`,
			};
		}
		const result = await startSuccessor({
			options,
			paths,
			host,
			owner: legacy,
			drainGate: async () => (await counted?.recount(SESSION_COUNT_TIMEOUT_MS)) === 0,
		});
		if (result.action === "handoff" && legacy === undefined) warnUnsignalledPredecessor(options.socket, host);
		return result;
	} finally {
		counted?.close();
	}
}

/**
 * The one record of a predecessor nobody could prove, on the caller's stderr: the endpoint's log belongs
 * to the generations writing it. Its pid is not known: no record proves it, and a Unix socket's peer
 * credentials are not readable from this runtime.
 */
function warnUnsignalledPredecessor(socket: string, host: HostProtocolInfo): void {
	process.stderr.write(
		`generation handoff: no provable owner for ${socket}; the host it replaced (instance ${host.instanceId ?? "unknown"}, engine ${host.engineVersion ?? "unknown"}) listed 0 sessions and was not signalled; it drains itself on losing the public socket\n`,
	);
}
