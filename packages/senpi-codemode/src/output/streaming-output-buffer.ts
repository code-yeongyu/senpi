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

/** UTF-8 width of the code point starting at `index`; a lone surrogate counts 3 bytes, as the encoder writes U+FFFD. */
function utf8Width(codePoint: number): number {
	if (codePoint < 0x80) return 1;
	if (codePoint < 0x800) return 2;
	if (codePoint < 0x10000) return 3;
	return 4;
}

/**
 * The shortest suffix of `text` whose leading whole code points total at least `excess` UTF-8 bytes, i.e. exactly
 * what truncateTailBytes keeps, computed by walking the dropped prefix only. Lone surrogates in the kept text become
 * U+FFFD as they would after a UTF-8 round trip.
 */
function dropLeadingBytes(text: string, excess: number): ByteSlice {
	const totalBytes = Buffer.byteLength(text, "utf8");
	let index = 0;
	let dropped = 0;
	while (dropped < excess && index < text.length) {
		const codePoint = text.codePointAt(index) ?? 0;
		dropped += utf8Width(codePoint);
		index += codePoint > 0xffff ? 2 : 1;
	}
	const kept = text.slice(index);
	return { text: kept.isWellFormed() ? kept : kept.toWellFormed(), bytes: totalBytes - dropped };
}

/**
 * Trailing byte window over a chunk stream. Appends only queue the chunk and drop whole chunks that fall
 * out of the window, so a streaming append costs time and memory proportional to the chunk (#2262); the
 * exact code-point-aligned trim runs when the window is read, with the same result as truncating the whole
 * stream to `maxBytes` after every append.
 */
export class TailBuffer {
	readonly #maxBytes: number;
	#chunks: string[] = [];
	#chunkBytes: number[] = [];
	#head = 0;
	/** Sum of the queued chunks' UTF-8 sizes; exact after #normalize. */
	#bytes = 0;
	/** The stream exceeded the window since the last normalization, so the next read must trim. */
	#overflowed = false;

	constructor(maxBytes: number) {
		this.#maxBytes = Math.max(0, Math.floor(maxBytes));
	}

	append(text: string): void {
		if (text.length === 0) return;
		if (this.#maxBytes === 0) return;
		const incomingBytes = Buffer.byteLength(text, "utf8");
		if (incomingBytes >= this.#maxBytes) {
			this.#chunks = [text];
			this.#chunkBytes = [incomingBytes];
			this.#head = 0;
			this.#bytes = incomingBytes;
			this.#overflowed = true;
			return;
		}
		this.#chunks.push(text);
		this.#chunkBytes.push(incomingBytes);
		this.#bytes += incomingBytes;
		if (this.#bytes > this.#maxBytes) this.#overflowed = true;
		// Keep a small margin so a surrogate pair split across chunks cannot make the kept window short.
		while (
			this.#head < this.#chunks.length - 1 &&
			this.#bytes - (this.#chunkBytes[this.#head] ?? 0) >= this.#maxBytes + 4
		) {
			this.#bytes -= this.#chunkBytes[this.#head] ?? 0;
			this.#head++;
		}
		if (this.#head > 1024 && this.#head * 2 > this.#chunks.length) {
			this.#chunks = this.#chunks.slice(this.#head);
			this.#chunkBytes = this.#chunkBytes.slice(this.#head);
			this.#head = 0;
		}
	}

	text(): string {
		return this.#normalize();
	}

	bytes(): number {
		this.#normalize();
		return this.#bytes;
	}

	#normalize(): string {
		if (this.#maxBytes === 0) return "";
		const pending = this.#chunks.length - this.#head;
		if (pending === 0) return "";
		const joined = pending === 1 ? (this.#chunks[this.#head] ?? "") : this.#chunks.slice(this.#head).join("");
		const total = Buffer.byteLength(joined, "utf8");
		const kept = this.#overflowed
			? dropLeadingBytes(joined, Math.max(0, total - this.#maxBytes))
			: { text: joined, bytes: total };
		this.#chunks = [kept.text];
		this.#chunkBytes = [kept.bytes];
		this.#head = 0;
		this.#bytes = kept.bytes;
		this.#overflowed = false;
		return kept.text;
	}
}

export interface TailLineRingOptions {
	readonly maxBytes: number;
	readonly maxLines: number;
}

/**
 * Rolling live-output window over a chunk stream: `text()` returns the last
 * `maxLines` lines of the trailing `maxBytes` byte window, byte-identical to
 * truncating the whole stream to `maxBytes` bytes and keeping its final lines,
 * while `append` costs time proportional to the chunk (#2262).
 *
 * Invariant: the retained content (compacted line groups plus recent lines,
 * joined with "\n", plus the partial current line) is a suffix of the stream
 * that either covers the whole stream or keeps the last-`maxLines`-lines window
 * reachable — older content is only dropped as whole lines when the remaining
 * lines still cover the line window, and any line trimmed from its start (only
 * for lines larger than the byte budget) is halved so repeated trims stay
 * amortized and never drop below what the byte window still needs.
 */
export class TailLineRing {
	readonly #maxBytes: number;
	readonly #maxLines: number;
	readonly #blobs: string[] = [];
	readonly #blobBytes: number[] = [];
	readonly #lines: string[] = [];
	readonly #lineBytes: number[] = [];
	#current = "";
	#currentBytes = 0;
	#bytes = 0;

	constructor(options: TailLineRingOptions) {
		this.#maxBytes = Math.max(0, Math.floor(options.maxBytes));
		this.#maxLines = Math.max(1, Math.floor(options.maxLines));
	}

	append(chunk: string): void {
		if (chunk.length === 0) return;
		let start = 0;
		for (;;) {
			const newline = chunk.indexOf("\n", start);
			const end = newline === -1 ? chunk.length : newline;
			if (end > start) {
				const piece = chunk.slice(start, end);
				const pieceBytes = Buffer.byteLength(piece, "utf8");
				this.#current += piece;
				this.#currentBytes += pieceBytes;
				this.#bytes += pieceBytes;
			}
			if (newline === -1) break;
			this.#completeLine();
			start = newline + 1;
		}
		this.#enforce();
	}

	text(): string {
		const endsWithNewline = this.#current === "" && this.#bytes > 0;
		const keptLines = endsWithNewline ? this.#maxLines : this.#maxLines - 1;
		if (this.#lines.length >= keptLines) {
			const parts = this.#lines.slice(-keptLines);
			if (!endsWithNewline) parts.push(this.#current);
			const window = `${parts.join("\n")}${endsWithNewline ? "\n" : ""}`;
			if (Buffer.byteLength(window, "utf8") <= this.#maxBytes) return window;
		}
		return this.#bytePathText(endsWithNewline);
	}

	#completeLine(): void {
		this.#lines.push(this.#current);
		this.#lineBytes.push(this.#currentBytes);
		this.#current = "";
		this.#currentBytes = 0;
		this.#bytes += 1;
		const keep = Math.max(this.#maxLines * 4, 64);
		if (this.#lines.length > keep * 2) this.#compact(keep);
	}

	/**
	 * Folds the oldest individual lines into one compacted group so a long stream of
	 * tiny lines cannot grow the line array without bound. The recent lines kept
	 * always outnumber the window, so compaction never touches rendered content.
	 */
	#compact(keep: number): void {
		const movedCount = this.#lines.length - keep;
		const moved = this.#lines.splice(0, movedCount);
		const movedBytes = this.#lineBytes.splice(0, movedCount);
		let bytes = 0;
		for (const entry of movedBytes) bytes += entry;
		this.#blobs.push(moved.join("\n"));
		this.#blobBytes.push(bytes + Math.max(0, moved.length - 1));
	}

	#enforce(): void {
		while (this.#bytes > this.#maxBytes) {
			if (this.#blobs.length > 0) {
				if (!this.#shedFront(this.#blobs, this.#blobBytes, this.#lines.length)) return;
				continue;
			}
			if (this.#lines.length > 0) {
				if (!this.#shedFront(this.#lines, this.#lineBytes, this.#lines.length - 1)) return;
				continue;
			}
			if (this.#currentBytes <= this.#maxBytes) return;
			const kept = truncateTailBytes(this.#current, Math.max(this.#maxBytes, Math.floor(this.#currentBytes / 2)));
			this.#bytes -= this.#currentBytes - kept.bytes;
			this.#current = kept.text;
			this.#currentBytes = kept.bytes;
		}
	}

	/**
	 * Drops or trims the oldest retained unit. Dropping is safe when the remaining
	 * bytes still cover the byte window or the remaining individual lines still cover
	 * the line window; otherwise the unit is trimmed from its start (halved, never
	 * below what the byte window still needs), which keeps the retained content a
	 * suffix holding at least `maxBytes` bytes. Returns false when nothing more can
	 * be shed without breaking the invariant.
	 */
	#shedFront(texts: string[], byteCosts: number[], retainedLines: number): boolean {
		const unitBytes = byteCosts[0];
		const restBytes = this.#bytes - unitBytes - 1;
		if (restBytes >= this.#maxBytes || retainedLines >= this.#maxLines) {
			texts.shift();
			byteCosts.shift();
			this.#bytes = restBytes;
			return true;
		}
		const needBytes = this.#maxBytes - restBytes;
		const keepBytes = Math.max(needBytes, unitBytes >> 1);
		if (keepBytes >= unitBytes) return false;
		const kept = truncateTailBytes(texts[0], keepBytes);
		texts[0] = kept.text;
		byteCosts[0] = kept.bytes;
		this.#bytes -= unitBytes - kept.bytes;
		return true;
	}

	#bytePathText(endsWithNewline: boolean): string {
		const units = [...this.#blobs, ...this.#lines];
		const joined = units.length === 0 ? this.#current : `${units.join("\n")}\n${this.#current}`;
		const tail = truncateTailBytes(joined, this.#maxBytes).text;
		let tailLines = tail.split("\n");
		if (endsWithNewline) tailLines = tailLines.slice(0, -1);
		return `${tailLines.slice(-this.#maxLines).join("\n")}${endsWithNewline ? "\n" : ""}`;
	}
}
