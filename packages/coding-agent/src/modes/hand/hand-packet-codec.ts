/**
 * The one wire form of a hand's reference-transport packets (senpi#5840, R3 `hand_link`): JSON objects with the data
 * payload in base64. The socket carrier writes one per LF-terminated line; a `hand_link` batch carries them as array
 * items, and the relay forwards them untouched.
 *
 * A data frame over {@link HAND_PACKET_PART_BYTES} would not fit one relayed record, so it travels as `data_part`
 * packets (`index` 0..`count`-1, in order, possibly across records) that the receiver joins before its transport sees
 * the frame. A count conflict or any packet that does not decode is malformed.
 */
import type { ReferencePacket } from "@earendil-works/pi-agent-core";

export const HAND_PACKET_PART_BYTES = 512 * 1024;

export type HandWirePacket =
	| { readonly kind: "data"; readonly lane: string; readonly seq: number; readonly payload: string }
	| { readonly kind: "ack"; readonly lane: string; readonly seq: number }
	| {
			readonly kind: "data_part";
			readonly lane: string;
			readonly seq: number;
			readonly index: number;
			readonly count: number;
			readonly payload: string;
	  };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** A reference packet in its wire form; `undefined` for anything else, which a carrier drops instead of sending. */
export function encodeHandPackets(packet: unknown): readonly HandWirePacket[] | undefined {
	if (!isRecord(packet) || typeof packet.lane !== "string" || typeof packet.seq !== "number") return undefined;
	const { lane, seq, payload } = packet;
	if (packet.kind === "ack") return [{ kind: "ack", lane, seq }];
	if (packet.kind !== "data" || !(payload instanceof Uint8Array)) return undefined;
	if (payload.length <= HAND_PACKET_PART_BYTES) return [{ kind: "data", lane, seq, payload: base64(payload) }];
	const count = Math.ceil(payload.length / HAND_PACKET_PART_BYTES);
	return Array.from({ length: count }, (_, index) => ({
		kind: "data_part" as const,
		lane,
		seq,
		index,
		count,
		payload: base64(payload.subarray(index * HAND_PACKET_PART_BYTES, (index + 1) * HAND_PACKET_PART_BYTES)),
	}));
}

/** One wire packet read: the whole packet, `null` for a part held until its frame is complete, `undefined` if malformed. */
export type HandPacketReader = (wire: unknown) => ReferencePacket | null | undefined;

interface Joining {
	readonly count: number;
	readonly parts: (Uint8Array | undefined)[];
	have: number;
}

const isIndex = (value: unknown, below: number): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < below;

/**
 * Reads the wire packets of one link in order. A completed frame drops its lane's unfinished joins at or below its
 * seq (a resend's leftovers), so a join that can never complete does not outlive the next frame on its lane.
 */
export function createHandPacketReader(): HandPacketReader {
	const joins = new Map<string, Map<number, Joining>>();
	const join = (lane: string, seq: number, wire: Readonly<Record<string, unknown>>, bytes: Uint8Array) => {
		const { count, index } = wire;
		if (!isIndex(count, Number.MAX_SAFE_INTEGER) || count < 2 || !isIndex(index, count)) return undefined;
		const lanes = joins.get(lane) ?? new Map<number, Joining>();
		joins.set(lane, lanes);
		const joining = lanes.get(seq) ?? { count, parts: [], have: 0 };
		if (joining.count !== count) return undefined;
		lanes.set(seq, joining);
		if (joining.parts[index] === undefined) joining.have += 1;
		joining.parts[index] = bytes;
		if (joining.have < count) return null;
		for (const held of lanes.keys()) if (held <= seq) lanes.delete(held);
		const whole = Buffer.concat(joining.parts.map((part) => part ?? new Uint8Array()));
		return { kind: "data", lane, seq, payload: new Uint8Array(whole) } satisfies ReferencePacket;
	};
	return (wire) => {
		if (!isRecord(wire) || typeof wire.lane !== "string" || !isIndex(wire.seq, Number.MAX_SAFE_INTEGER))
			return undefined;
		const { kind, lane, seq } = wire;
		if (kind === "ack") return { kind: "ack", lane, seq };
		if (typeof wire.payload !== "string") return undefined;
		const bytes = new Uint8Array(Buffer.from(wire.payload, "base64"));
		if (kind === "data") return { kind: "data", lane, seq, payload: bytes };
		return kind === "data_part" ? join(lane, seq, wire, bytes) : undefined;
	};
}
