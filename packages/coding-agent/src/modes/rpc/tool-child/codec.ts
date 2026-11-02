import { TOOL_CHILD_LIMITS, type ToolChildMessage } from "./protocol.ts";
import { isToolChildMessage } from "./protocol-guard.ts";

export type ToolChildCodecErrorCode =
	| "tool_child_frame_too_large"
	| "tool_child_truncated"
	| "tool_child_malformed"
	| "tool_child_encode_invalid";

export class ToolChildCodecError extends Error {
	readonly code: ToolChildCodecErrorCode;
	constructor(code: ToolChildCodecErrorCode, message: string) {
		super(`${code}: ${message}`);
		this.name = "ToolChildCodecError";
		this.code = code;
	}
}

/** A frame is a 4-byte big-endian body length followed by that many bytes of UTF-8 JSON. No delimiter, no NDJSON. */
export const FRAME_HEADER_BYTES = 4;

const tooLarge = (bytes: number): ToolChildCodecError =>
	new ToolChildCodecError("tool_child_frame_too_large", `${bytes} bytes exceeds ${TOOL_CHILD_LIMITS.frameBytes}`);

export function encodeFrame(message: ToolChildMessage): Uint8Array {
	// JSON.stringify drops undefined-valued properties (what optional fields rely on) and natively serializes
	// NaN/Infinity as null on BOTH the inline and the ref path, so payload contents encode identically either way.
	// The one case JSON cannot represent is a REQUIRED json field that is undefined (today only result.value - a
	// tool returning undefined); it becomes an explicit null the guard takes. The round-trip with the decoder's own
	// predicate refuses anything else unsendable HERE - a typed per-message error, never a channel-killing frame
	// (senpi#3569 delta review: optional undefined must keep stringify's default drop).
	const normalized: ToolChildMessage =
		message.type === "result" && message.value === undefined ? { ...message, value: null } : message;
	const json = JSON.stringify(normalized);
	const bodyBytes = Buffer.byteLength(json, "utf8");
	if (bodyBytes > TOOL_CHILD_LIMITS.frameBytes) throw tooLarge(bodyBytes);
	if (!isToolChildMessage(JSON.parse(json))) {
		throw new ToolChildCodecError(
			"tool_child_encode_invalid",
			"the message serializes to a frame the peer's guard rejects",
		);
	}
	return frameFromBody(json, bodyBytes);
}

function frameFromBody(json: string, bodyBytes: number): Uint8Array {
	const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + bodyBytes);
	frame.writeUInt32BE(bodyBytes, 0);
	frame.write(json, FRAME_HEADER_BYTES, "utf8");
	return frame;
}

function parseBody(body: Buffer): ToolChildMessage {
	let value: unknown;
	try {
		value = JSON.parse(body.toString("utf8"));
	} catch {
		throw new ToolChildCodecError("tool_child_malformed", "frame body is not JSON");
	}
	if (!isToolChildMessage(value))
		throw new ToolChildCodecError("tool_child_malformed", "frame is not a protocol message");
	return value;
}

/**
 * Incremental decoder for one channel direction. A length header above the cap is refused as soon as its four bytes
 * arrive, before any body buffer exists. Any codec error is terminal: the stream is never resynchronized, so nothing
 * after a bad frame can be silently skipped.
 */
export class FrameDecoder {
	#chunks: Buffer[] = [];
	#buffered = 0;
	#bodyBytes: number | undefined;
	#failure: ToolChildCodecError | undefined;

	get bufferedBytes(): number {
		return this.#buffered;
	}

	push(chunk: Uint8Array): ToolChildMessage[] {
		if (this.#failure) throw this.#failure;
		if (chunk.length > 0) {
			this.#chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
			this.#buffered += chunk.length;
		}
		const messages: ToolChildMessage[] = [];
		try {
			for (;;) {
				if (this.#bodyBytes === undefined) {
					if (this.#buffered < FRAME_HEADER_BYTES) break;
					const length = this.#take(FRAME_HEADER_BYTES).readUInt32BE(0);
					if (length > TOOL_CHILD_LIMITS.frameBytes) throw tooLarge(length);
					this.#bodyBytes = length;
				}
				if (this.#buffered < this.#bodyBytes) break;
				const body = this.#take(this.#bodyBytes);
				this.#bodyBytes = undefined;
				messages.push(parseBody(body));
			}
		} catch (error) {
			if (error instanceof ToolChildCodecError) this.#fail(error);
			throw error;
		}
		return messages;
	}

	end(): void {
		if (this.#failure) throw this.#failure;
		if (this.#buffered === 0 && this.#bodyBytes === undefined) return;
		const truncated = new ToolChildCodecError(
			"tool_child_truncated",
			`stream ended inside a frame (${this.#buffered} of ${this.#bodyBytes ?? FRAME_HEADER_BYTES} bytes)`,
		);
		this.#fail(truncated);
		throw truncated;
	}

	#fail(error: ToolChildCodecError): void {
		this.#failure = error;
		this.#chunks = [];
		this.#buffered = 0;
		this.#bodyBytes = undefined;
	}

	#take(bytes: number): Buffer {
		const first = this.#chunks[0];
		if (first !== undefined && first.length >= bytes) {
			const taken = first.subarray(0, bytes);
			if (first.length === bytes) this.#chunks.shift();
			else this.#chunks[0] = first.subarray(bytes);
			this.#buffered -= bytes;
			return taken;
		}
		const out = Buffer.allocUnsafe(bytes);
		let filled = 0;
		while (filled < bytes) {
			const chunk = this.#chunks[0];
			if (chunk === undefined) break;
			const count = Math.min(chunk.length, bytes - filled);
			chunk.copy(out, filled, 0, count);
			filled += count;
			if (count === chunk.length) this.#chunks.shift();
			else this.#chunks[0] = chunk.subarray(count);
		}
		this.#buffered -= bytes;
		return out;
	}
}
