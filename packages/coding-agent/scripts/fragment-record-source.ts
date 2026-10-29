import { createHash } from "node:crypto";

export const FRAGMENT_LIMITS = { D: 131_072, F: 262_144, H: 16_384 } as const;

export type FragmentSegment =
	| { kind: "bytes"; base64: string }
	| { kind: "repeat"; patternBase64: string; length: number }
	| { kind: "xorshift32"; seed: number; length: number };

export type FragmentSource =
	| { base64: string }
	| { generator: { kind: "segments"; params: { segments: FragmentSegment[] } } };

export interface FragmentRecord {
	offset: number;
	length: number;
	digest: string;
	next: number | null;
	complete: boolean;
	data?: string;
}

export function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function xorshift32Bytes(seed: number, length: number): Uint8Array {
	const out = new Uint8Array(length);
	let state = seed >>> 0;
	let word = 0;
	for (let index = 0; index < length; index++) {
		if (index % 4 === 0) {
			state ^= state << 13;
			state >>>= 0;
			state ^= state >>> 17;
			state ^= state << 5;
			state >>>= 0;
			word = state;
		}
		out[index] = (word >>> (8 * (index % 4))) & 0xff;
	}
	return out;
}

function segmentBytes(segment: FragmentSegment): Uint8Array {
	switch (segment.kind) {
		case "bytes":
			return Buffer.from(segment.base64, "base64");
		case "repeat": {
			const pattern = Buffer.from(segment.patternBase64, "base64");
			const out = new Uint8Array(segment.length);
			for (let index = 0; index < segment.length; index++) out[index] = pattern[index % pattern.length];
			return out;
		}
		case "xorshift32":
			return xorshift32Bytes(segment.seed, segment.length);
	}
}

export function materializeSource(source: FragmentSource): Uint8Array {
	if ("base64" in source) return Buffer.from(source.base64, "base64");
	return Buffer.concat(source.generator.params.segments.map(segmentBytes));
}

/** Splits a value into B3 records of at most D raw bytes; an empty value is one empty complete record. */
export function fragmentRecords(value: Uint8Array, withData: boolean): FragmentRecord[] {
	const records: FragmentRecord[] = [];
	let offset = 0;
	do {
		const length = Math.min(FRAGMENT_LIMITS.D, value.length - offset);
		const slice = value.subarray(offset, offset + length);
		const complete = offset + length === value.length;
		records.push({
			offset,
			length,
			digest: sha256Hex(slice),
			next: complete ? null : offset + length,
			complete,
			...(withData ? { data: Buffer.from(slice).toString("base64") } : {}),
		});
		offset += length;
	} while (offset < value.length);
	return records;
}
