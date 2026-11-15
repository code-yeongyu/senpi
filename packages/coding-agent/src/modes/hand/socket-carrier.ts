/**
 * The local carrier a hand serves on (senpi#5840): one stream socket (an owner-only Unix socket, a named pipe on
 * Windows) carrying the reference transport's packets, one wire packet (`hand-packet-codec.ts`) per LF-terminated
 * line. The carrier only moves packets; per-lane order, exactly-once delivery and resume after a re-attach are the
 * reference transport's (`createReliableTransport`). A local client (a device service, a test harness) speaks the same
 * lines with {@link attachSocketCarrier} on its end.
 */
import type { Server, Socket } from "node:net";
import type { TransportSide } from "@earendil-works/pi-agent-core";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS } from "../rpc/jsonl.ts";
import { authenticateSocket } from "../rpc/socket-transport.ts";
import { createHandPacketReader, encodeHandPackets, type HandPacketReader } from "./hand-packet-codec.ts";

/** What a carrier drives on the transport endpoint it serves. */
export type CarrierSide = Pick<TransportSide, "attached" | "message" | "writable" | "detached">;

/**
 * One carrier line back as the packet the reference transport reads, or nothing yet (a `data_part` of an unfinished
 * frame). A malformed line is dropped as a lost message: the reference transport resends from its last ACK.
 */
function decodeCarrierLine(read: HandPacketReader, line: string): ReturnType<HandPacketReader> {
	try {
		return read(JSON.parse(line));
	} catch {
		return undefined;
	}
}

/**
 * Makes `socket` the current connection of `side` until it closes. Returns `detach`, which ends this connection's
 * hold on the side (the socket's own close does the same) without signalling it twice.
 */
export function attachSocketCarrier(socket: Socket, side: CarrierSide, report: (message: string) => void): () => void {
	let live = true;
	let reportedError = false;
	const read = createHandPacketReader();
	const stopReading = attachJsonlLineReader(
		socket,
		(line) => {
			const packet = live ? decodeCarrierLine(read, line) : undefined;
			if (packet) side.message(packet);
		},
		{ maxLineLength: MAX_RPC_LINE_CHARACTERS },
	);
	const onDrain = (): void => {
		if (live) side.writable();
	};
	/**
	 * A failing carrier leaves one line per connection - the code and the message, never a packet payload - and then
	 * the socket is destroyed as before, so the transport resumes on a fresh connection and the failure is visible
	 * in the hand's stderr instead of only as a stalled lane (senpi#5993).
	 */
	const onError = (error: Error): void => {
		if (live && !reportedError) {
			reportedError = true;
			const code = (error as NodeJS.ErrnoException).code;
			report(`carrier socket error${code === undefined ? "" : ` ${code}`}: ${error.message}`);
		}
		socket.destroy();
	};
	const detach = (): void => {
		if (!live) return;
		live = false;
		stopReading();
		socket.off("drain", onDrain);
		side.detached();
	};
	socket.on("drain", onDrain);
	socket.once("close", detach);
	socket.on("error", onError);
	side.attached({
		// `false` means "not taken": the side resends after `writable()`. So refuse while the socket is over its
		// high-water mark instead of queueing a line the side will send again.
		send: (message) => {
			if (!live || socket.destroyed || socket.writableNeedDrain) return false;
			for (const packet of encodeHandPackets(message) ?? []) socket.write(`${JSON.stringify(packet)}\n`);
			return true;
		},
		close: () => socket.destroy(),
	});
	return detach;
}

/**
 * Serves `side` on `server`: the newest connection is the carrier, and an older one is dropped when a new one arrives.
 * With a `secret` (the Windows named pipe; the same handshake the shared RPC host uses), a connection becomes the
 * carrier only after it sent the secret's bytes first (`authenticateSocket`), so a connection without it never
 * displaces the current carrier.
 */
export function serveSocketCarrier(
	server: Server,
	side: CarrierSide,
	secret: Uint8Array | undefined,
	report: (message: string) => void,
): void {
	let current: { readonly socket: Socket; readonly detach: () => void } | undefined;
	const take = (socket: Socket): void => {
		const previous = current;
		previous?.detach();
		previous?.socket.destroy();
		const detach = attachSocketCarrier(socket, side, report);
		current = { socket, detach };
		socket.once("close", () => {
			if (current?.socket === socket) current = undefined;
		});
	};
	server.on("connection", (socket) => {
		if (secret === undefined) take(socket);
		else authenticateSocket(socket, secret, () => take(socket));
	});
}
