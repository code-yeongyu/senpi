/**
 * Connect streaming frame codec.
 *
 * Each frame is a 5-byte prefix - one flag byte plus a big-endian payload
 * length - followed by the payload. Requests are gzipped (flag 0x01); the final
 * response frame carries JSON trailers (flag 0x02) instead of a message.
 */

import { gunzipSync, gzipSync } from "node:zlib";
import { type DescMessage, fromBinary, type MessageShape, toBinary } from "@bufbuild/protobuf";
import { DEVIN_COMPRESSED_FLAG, DEVIN_MAX_FRAME_PAYLOAD, DEVIN_TRAILER_FLAG } from "./paths.ts";

export interface DevinFrame<TSchema extends DescMessage> {
	/** Decoded message, absent on the end-of-stream trailer frame. */
	message?: MessageShape<TSchema>;
	/** Raw trailer JSON, present only on the end-of-stream frame. */
	trailer?: string;
}

/** Encodes one request message as a single gzipped Connect frame. */
export function encodeDevinFrame<TSchema extends DescMessage>(
	schema: TSchema,
	message: MessageShape<TSchema>,
): Uint8Array<ArrayBuffer> {
	const payload = gzipSync(toBinary(schema, message));
	const frame = new Uint8Array(5 + payload.byteLength);
	frame[0] = DEVIN_COMPRESSED_FLAG;
	new DataView(frame.buffer).setUint32(1, payload.byteLength, false);
	frame.set(payload, 5);
	return frame;
}

/**
 * Decodes a Connect frame stream. Yields one entry per frame in arrival order
 * so callers can map deltas as they land; the trailer frame yields its raw JSON
 * instead of a message.
 */
export async function* decodeDevinFrames<TSchema extends DescMessage>(
	body: ReadableStream<Uint8Array>,
	schema: TSchema,
): AsyncGenerator<DevinFrame<TSchema>> {
	let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
	const reader = body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (value && value.byteLength > 0) pending = append(pending, value);
			while (pending.byteLength >= 5) {
				const view = new DataView(pending.buffer, pending.byteOffset, pending.byteLength);
				const length = view.getUint32(1, false);
				if (length > DEVIN_MAX_FRAME_PAYLOAD) {
					throw new Error(`Devin Connect frame length ${length} exceeds the ${DEVIN_MAX_FRAME_PAYLOAD}-byte cap`);
				}
				if (pending.byteLength < 5 + length) break;
				const flags = pending[0] ?? 0;
				const raw = pending.subarray(5, 5 + length);
				const payload: Uint8Array<ArrayBuffer> =
					(flags & DEVIN_COMPRESSED_FLAG) === 0 ? copyOf(raw) : copyOf(gunzipSync(raw));
				pending = pending.subarray(5 + length);
				yield (flags & DEVIN_TRAILER_FLAG) === 0
					? { message: fromBinary(schema, payload) }
					: { trailer: new TextDecoder().decode(payload) };
			}
			if (done) break;
		}
	} finally {
		reader.releaseLock();
	}
}

/** protobuf-es requires an ArrayBuffer-backed view; Node buffers may be shared. */
function copyOf(source: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(source.byteLength);
	out.set(source);
	return out;
}

function append(head: Uint8Array<ArrayBufferLike>, tail: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
	if (head.byteLength === 0) return tail;
	const out = new Uint8Array(head.byteLength + tail.byteLength);
	out.set(head, 0);
	out.set(tail, head.byteLength);
	return out;
}
