import type { CompactSelection } from "./compact-negotiation.ts";
import type { ExtensionTransportOwner } from "./extension-owner.ts";
import type { SocketClosingCode } from "./socket-closing.ts";
import type { SocketEventSinkActor } from "./socket-event-fanout.ts";

export interface SessionEventWriterConnection {
	readonly writeRaw: (chunk: string) => void;
	readonly waitForBackpressure: () => Promise<void>;
	/**
	 * Tears the transport down. Called when this connection's event queue fails
	 * (overflow, write error): the actor has already stopped delivering records
	 * AND command responses, so a socket left open would strand the client on a
	 * connection that can never answer again. Closing it lets the client resync.
	 */
	readonly close?: () => void;
}

/** A registered connection's transport: writes only. Its close is reachable only through `RegisteredConnection.close`. */
export type SessionEventTransport = Pick<SessionEventWriterConnection, "writeRaw" | "waitForBackpressure">;

export type RegisteredConnection = {
	readonly connection: SessionEventTransport;
	readonly actor: SocketEventSinkActor;
	/** This registration's incarnation of the peer: the owner every checkpoint it freezes is bound to. */
	readonly socketEpoch: string;
	readonly selection: CompactSelection;
	readonly owner: ExtensionTransportOwner;
	/** RULING-124: the engine's only close of this peer, announced by `socket_closing` to a compact peer. */
	readonly close: (code: SocketClosingCode, detail?: string) => void;
};

export function transportOf(connection: SessionEventWriterConnection): SessionEventTransport {
	return {
		writeRaw: (chunk) => connection.writeRaw(chunk),
		waitForBackpressure: () => connection.waitForBackpressure(),
	};
}
