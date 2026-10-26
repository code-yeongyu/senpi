/**
 * What a handover asks of the router (code-yeongyu/oh-my-openagent#10091): which application connections an
 * overlapping publication would leave behind, which sessions this generation still holds, and the membership seal.
 *
 * A connection becomes an APPLICATION connection with its first routed command that is neither an observing read
 * (the supervisor's own rule, `host-observe-request.ts`: an `observe: true` read or a warm) nor a protocol read: a
 * fresh open it sends next would land on this generation, whatever it holds now. A connection that has only read
 * `get_protocol_info` (a probe, an ensure's attach hold) holds no handle and admitted no input; a handle it asks for
 * later meets the seal below. A connection is CAPABLE when its connection-level `set_client_info` declared both
 * overlap capabilities (`host-handover-eligibility.ts`).
 *
 * The seal spans a publication in flight. A client that is not capable and asks for a session handle meanwhile
 * (`open_session`, `attach_session`, `reclaim_session`) is held until the publication's outcome: refused with a
 * reconnect once the successor serves, admitted as usual when the publication was abandoned. Existing sessions'
 * commands and control traffic are never held.
 */
import { declaresOverlapCapabilities, type HandoverClientView } from "./host-handover-eligibility.ts";
import type { RetainedSession } from "./host-idle-handover.ts";
import { isObservingRecord } from "./host-observe-request.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import type { RouterContext } from "./session-router-context.ts";
import { error } from "./session-router-errors.ts";

const HANDLE_REQUESTS: ReadonlySet<string> = new Set(["open_session", "attach_session", "reclaim_session"]);

export function noteApplicationConnection(host: RouterContext, command: RpcCommand): void {
	const connection = host.writer.currentConnection();
	if (connection === undefined || isObservingRecord(command) || command.type === "get_protocol_info") return;
	host.applicationConnections.add(connection);
}

export function handoverClientView(host: RouterContext): HandoverClientView {
	let capableClients = 0;
	let legacyClients = 0;
	for (const connection of host.applicationConnections) {
		if (declaresOverlapCapabilities(host.pendingCapabilities.get(connection))) capableClients++;
		else legacyClients++;
	}
	return { sessions: host.registry.size, capableClients, legacyClients };
}

export function retainedSessions(host: RouterContext): RetainedSession[] {
	return host.registry
		.list()
		.map(({ sessionId }) => ({ sessionId, blockers: host.heldTransfers.get(sessionId) ?? "transfer_pending" }));
}

export function beginHandoverSeal(host: RouterContext): void {
	if (host.handoverSeal !== undefined) return;
	let resolve: (published: boolean) => void = () => {};
	const settled = new Promise<boolean>((settle) => {
		resolve = settle;
	});
	host.handoverSeal = { settled, resolve };
}

export function endHandoverSeal(host: RouterContext, published: boolean): void {
	const seal = host.handoverSeal;
	host.handoverSeal = undefined;
	if (published) host.handoverPublished = true;
	seal?.resolve(published);
}

/**
 * The seal's answer to `command`: a promise to wait on while a publication is in flight, a refusal once the
 * successor serves, or `undefined` when the command proceeds.
 */
export function handoverSealVerdict(
	host: RouterContext,
	command: RpcCommand,
): Promise<boolean> | RpcResponse | undefined {
	if (!HANDLE_REQUESTS.has(command.type)) return undefined;
	const connection = host.writer.currentConnection();
	if (connection === undefined || declaresOverlapCapabilities(host.pendingCapabilities.get(connection)))
		return undefined;
	if (host.handoverSeal !== undefined) return host.handoverSeal.settled;
	if (!host.handoverPublished) return undefined;
	return error(command.id, command.type, "host_draining", {
		reason: "handover_published",
		action: "reconnect to the public socket: the next generation serves new sessions",
	});
}
