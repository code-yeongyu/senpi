/**
 * Where a session's relocation requests go (docs/rpc.md "Continuing a session on another computer"): to ONE connection,
 * the one attached to the session that advertised `session_relocation`, and only that connection's answer counts.
 */
import { SESSION_RELOCATION_CAPABILITY } from "./custom-capability.ts";
import type { RpcHostResponse } from "./rpc-types.ts";

export interface RelocationChannel {
	/** The connection that offers relocation for this session right now, or `undefined`. */
	offerer(): string | undefined;
	/** The connection the frame being handled came from. */
	current(): string | undefined;
	/** Delivers a record to `connection` only. `event` keeps it ordered behind the session's buffered events. */
	send(connection: string, record: object, kind: "request" | "event"): void;
}

/** What a shared host lends a session binding; absent on a classic single-connection handler. */
export interface RelocationClientInfo {
	readonly connectionId: () => string | undefined;
	readonly relocationConnection?: () => string | undefined;
	readonly deliverTo?: (connectionId: string, deliver: () => void) => void;
}

const SOLE_CONNECTION = "sole";

/**
 * A classic handler has one client, so its own capabilities decide. A shared host names the offering connection from
 * its per-connection capabilities; a binding the host cannot ask (a worker isolate) offers nothing, which is also
 * right because `release_session` cannot release such a session.
 */
export function relocationChannel(options: {
	readonly capabilities: () => readonly string[] | undefined;
	readonly clientInfo: RelocationClientInfo | undefined;
	readonly output: (record: object) => void;
	readonly outputEvent: (record: object) => void;
}): RelocationChannel {
	const { clientInfo } = options;
	if (clientInfo === undefined)
		return {
			offerer: () => (options.capabilities()?.includes(SESSION_RELOCATION_CAPABILITY) ? SOLE_CONNECTION : undefined),
			current: () => SOLE_CONNECTION,
			send: (_connection, record, kind) => (kind === "event" ? options.outputEvent(record) : options.output(record)),
		};
	const { relocationConnection, deliverTo } = clientInfo;
	return {
		offerer: () => (deliverTo === undefined ? undefined : relocationConnection?.()),
		current: () => clientInfo.connectionId(),
		send: (connection, record) => deliverTo?.(connection, () => options.output(record)),
	};
}

export type HostResponseOutcome = "answered" | "unknown" | "not_offering_connection";

export function answerHostResponse(
	frame: RpcHostResponse,
	respond: ((frame: RpcHostResponse) => HostResponseOutcome) | undefined,
): object {
	const reply = { id: frame.id, type: "response", command: "host_response" } as const;
	if (typeof frame.id !== "string" || frame.id === "")
		return { ...reply, success: false, error: "invalid_host_response" };
	const outcome = respond?.(frame) ?? "unknown";
	if (outcome === "answered") return { ...reply, success: true };
	return { ...reply, success: false, error: outcome === "unknown" ? "unknown_host_request" : outcome };
}

export function isHostResponse(value: unknown): value is RpcHostResponse {
	return typeof value === "object" && value !== null && "type" in value && value.type === "host_response";
}
