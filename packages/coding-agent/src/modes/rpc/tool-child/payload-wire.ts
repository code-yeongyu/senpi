import { PayloadRefError, type PayloadRefReader, type PayloadRefWriter } from "./payload-ref.ts";
import { type PayloadRef, TOOL_CHILD_LIMITS } from "./protocol.ts";

export type PackedPayload = { inline: true; value: unknown } | { inline: false; ref: PayloadRef };

/** Inline at or below `REF_THRESHOLD` JSON bytes; above it, by acknowledged reference. Same rule in both directions. */
export async function packPayload(value: unknown, writer: PayloadRefWriter): Promise<PackedPayload> {
	// `undefined` stringifies to nothing (JSON.stringify returns undefined), which no decoder accepts; the explicit
	// null is the encoding the peer's guard takes (senpi#3569 review).
	const normalized = value === undefined ? null : value;
	const json = JSON.stringify(normalized);
	if (json === undefined || Buffer.byteLength(json, "utf8") <= TOOL_CHILD_LIMITS.REF_THRESHOLD) {
		return { inline: true, value: normalized };
	}
	return { inline: false, ref: await writer.create(Buffer.from(json, "utf8")) };
}

export async function unpackPayload(ref: PayloadRef, reader: PayloadRefReader, signal?: AbortSignal): Promise<unknown> {
	const acceptance = await reader.accept(ref, signal);
	if (!acceptance.ok) {
		throw new PayloadRefError(
			"ref_rejected",
			`ref ${ref.refId} was refused (${acceptance.reason})`,
			acceptance.reason,
		);
	}
	const bytes = await reader.consume(ref.refId);
	return JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8"));
}
