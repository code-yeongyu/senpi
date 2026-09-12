interface ByteSlice {
	readonly text: string;
	readonly bytes: number;
}

export function truncateHeadBytes(text: string, maxBytes: number): ByteSlice {
	if (maxBytes <= 0) return { text: "", bytes: 0 };
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) return { text, bytes: buffer.length };
	let end = maxBytes;
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	const slice = buffer.subarray(0, end);
	return { text: slice.toString("utf8"), bytes: slice.length };
}

export function truncateTailBytes(text: string, maxBytes: number): ByteSlice {
	if (maxBytes <= 0) return { text: "", bytes: 0 };
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) return { text, bytes: buffer.length };
	let start = buffer.length - maxBytes;
	while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
	const slice = buffer.subarray(start);
	return { text: slice.toString("utf8"), bytes: slice.length };
}

export class TailBuffer {
	readonly #maxBytes: number;
	#text = "";
	#bytes = 0;

	constructor(maxBytes: number) {
		this.#maxBytes = Math.max(0, Math.floor(maxBytes));
	}

	append(text: string): void {
		if (text.length === 0) return;
		if (this.#maxBytes === 0) {
			this.#text = "";
			this.#bytes = 0;
			return;
		}
		const incomingBytes = Buffer.byteLength(text, "utf8");
		const next =
			incomingBytes >= this.#maxBytes
				? truncateTailBytes(text, this.#maxBytes)
				: truncateTailBytes(this.#text + text, this.#maxBytes);
		this.#text = next.text;
		this.#bytes = next.bytes;
	}

	text(): string {
		return this.#text;
	}

	bytes(): number {
		return this.#bytes;
	}
}
