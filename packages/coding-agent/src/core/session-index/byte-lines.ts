export interface ByteLine {
	readonly offset: number;
	readonly bytes: Buffer;
}

/**
 * Splits a byte stream into lines with exact UTF-8 byte offsets (senpi#3968). A newline byte never occurs inside a
 * multi-byte UTF-8 sequence, so splitting bytes before decoding finds the same lines the string splitter does.
 *
 * A returned line may share memory with the pushed chunk: consume it before the chunk's buffer is reused.
 */
export class ByteLineSplitter {
	private carry: Buffer[] = [];
	private lineStart: number;
	private consumed: number;

	constructor(start: number) {
		this.lineStart = start;
		this.consumed = start;
	}

	/** Byte offset just past the last newline seen: everything before it is a complete line. */
	get committedEnd(): number {
		return this.lineStart;
	}

	push(chunk: Buffer): ByteLine[] {
		const lines: ByteLine[] = [];
		let from = 0;
		for (let newline = chunk.indexOf(10, from); newline !== -1; newline = chunk.indexOf(10, from)) {
			const piece = chunk.subarray(from, newline);
			const bytes = this.carry.length === 0 ? piece : Buffer.concat([...this.carry, piece]);
			this.carry = [];
			lines.push({ offset: this.lineStart, bytes });
			this.lineStart = this.consumed + newline + 1;
			from = newline + 1;
		}
		if (from < chunk.length) this.carry.push(Buffer.from(chunk.subarray(from)));
		this.consumed += chunk.length;
		return lines;
	}

	finish(): ByteLine | undefined {
		if (this.carry.length === 0) return undefined;
		const bytes = Buffer.concat(this.carry);
		this.carry = [];
		return { offset: this.lineStart, bytes };
	}
}
