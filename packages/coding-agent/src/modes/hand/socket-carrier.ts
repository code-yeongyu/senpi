/**
 * The local carrier a hand serves on (senpi#5840): one stream socket (an owner-only Unix socket, a named pipe on
 * Windows) carrying the reference transport's packets, one JSON object per LF-terminated line with the data payload in
 * base64. The carrier only moves packets; per-lane order, exactly-once delivery and resume after a re-attach are the
 * reference transport's (`createReliableTransport`). A local client (a device service, a test harness) speaks the same
 * lines with {@link attachSocketCarrier} on its end.
 */
import type { Server, Socket } from "node:net";
import type { TransportSide } from "@earendil-works/pi-agent-core";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS } from "../rpc/jsonl.ts";

/** What a carrier drives on the transport endpoint it serves. */
export type CarrierSide = Pick<TransportSide, "attached" | "message" | "writable" | "detached">;

type WirePacket =
	| { readonly kind: "data"; readonly lane: string; readonly seq: number; readonly payload: string }
	| { readonly kind: "ack"; readonly lane: string; readonly seq: number };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** A reference packet as one carrier line; anything else is not carried. */
function encodeCarrierLine(message: unknown): string | undefined {
	if (!isRecord(message) || typeof message.lane !== "string" || typeof message.seq !== "number") return undefined;
	if (message.kind === "ack") return `${JSON.stringify({ kind: "ack", lane: message.lane, seq: message.seq })}\n`;
	if (message.kind !== "data" || !(message.payload instanceof Uint8Array)) return undefined;
	const payload = Buffer.from(message.payload).toString("base64");
	return `${JSON.stringify({ kind: "data", lane: message.lane, seq: message.seq, payload } satisfies WirePacket)}\n`;
}

/** One carrier line back as the packet the reference transport reads; a malformed line is dropped as a lost message. */
function decodeCarrierLine(line: string): unknown {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || typeof parsed.lane !== "string" || typeof parsed.seq !== "number") return undefined;
	if (parsed.kind === "ack") return { kind: "ack", lane: parsed.lane, seq: parsed.seq };
	if (parsed.kind !== "data" || typeof parsed.payload !== "string") return undefined;
	return {
		kind: "data",
		lane: parsed.lane,
		seq: parsed.seq,
		payload: new Uint8Array(Buffer.from(parsed.payload, "base64")),
	};
}

/**
 * Makes `socket` the current connection of `side` until it closes. Returns `detach`, which ends this connection's
 * hold on the side (the socket's own close does the same) without signalling it twice.
 */
export function attachSocketCarrier(socket: Socket, side: CarrierSide): () => void {
	let live = true;
	const stopReading = attachJsonlLineReader(
		socket,
		(line) => {
			if (live) side.message(decodeCarrierLine(line));
		},
		{ maxLineLength: MAX_RPC_LINE_CHARACTERS },
	);
	const onDrain = (): void => {
		if (live) side.writable();
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
	socket.on("error", () => socket.destroy());
	side.attached({
		send: (message) => {
			const line = encodeCarrierLine(message);
			if (!live || socket.destroyed) return false;
			return line === undefined ? true : socket.write(line);
		},
		close: () => socket.destroy(),
	});
	return detach;
}

/** Serves `side` on `server`: the newest connection is the carrier, and an older one is dropped when a new one arrives. */
export function serveSocketCarrier(server: Server, side: CarrierSide): void {
	let current: { readonly socket: Socket; readonly detach: () => void } | undefined;
	server.on("connection", (socket) => {
		const previous = current;
		previous?.detach();
		previous?.socket.destroy();
		const detach = attachSocketCarrier(socket, side);
		current = { socket, detach };
		socket.once("close", () => {
			if (current?.socket === socket) current = undefined;
		});
	});
}
