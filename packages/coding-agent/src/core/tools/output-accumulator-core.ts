import { concatBytes, encodeUtf8, utf8ByteLength } from "./encoding.ts";
import { TailWindow } from "./tail-window.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.ts";

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
}

export interface FullOutput {
	content: string;
	/** Whether `content` omits part of the output. */
	truncated: boolean;
}

/** Where an accumulator keeps the full output once it outgrows the display limits. */
export interface OutputSpill {
	/** The path truncation notices show the model. */
	readonly path: string;
	/** Appends a chunk; a failure is latched and reported by `close`. */
	write(chunk: Uint8Array | string): void;
	/** Settles every write; rejects with the first write or close failure. */
	close(): Promise<void>;
	/** Discards the spill; a rejection leaves it in place for a retry. */
	remove(): Promise<void>;
	/** The whole output after `close`, cut by {@link joinHeadAndTail} past `maxBytes`. */
	readFull(maxBytes: number): Promise<FullOutput>;
}

export type OutputSpillFactory = (prefix: string) => OutputSpill;

export interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	tempFilePrefix?: string;
}

/**
 * The first and last bytes of an output too long to return whole, around an omission marker. Cuts at character
 * boundaries: streaming decode holds back an incomplete trailing sequence, and the tail skips continuation bytes.
 */
export function joinHeadAndTail(head: Uint8Array, tail: Uint8Array, omittedBytes: number): string {
	const headText = new TextDecoder().decode(head, { stream: true });
	let tailStart = 0;
	while (tailStart < tail.length && (tail[tailStart] & 0xc0) === 0x80) tailStart++;
	const tailText = new TextDecoder().decode(tail.subarray(tailStart));
	return `${headText}\n\n[... ${omittedBytes} bytes omitted ...]\n\n${tailText}`;
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded tail for display snapshots, and opens a
 * spill when the full output needs to be preserved.
 */
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly tempFilePrefix: string;
	private readonly createSpill: OutputSpillFactory;
	private readonly decoder = new TextDecoder();
	private readonly tail: TailWindow;

	private rawChunks: Array<Uint8Array | string> = [];
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private totalLines = 0;
	private currentLineBytes = 0;
	private hasOpenLine = false;
	private finished = false;

	/** The spill that owns `fullOutputPath`, until removed. */
	private spill: OutputSpill | undefined;
	/** The same spill while it still takes writes, until closed. */
	private openSpill: OutputSpill | undefined;

	constructor(options: OutputAccumulatorOptions & { spill: OutputSpillFactory }) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.tempFilePrefix = options.tempFilePrefix ?? "pi-output";
		this.createSpill = options.spill;
		this.tail = new TailWindow(Math.max(this.maxBytes * 2, 1));
	}

	append(data: Uint8Array): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}

		const text = this.decoder.decode(data, { stream: true });
		this.totalRawBytes += data.length;
		this.appendDecodedText(text, utf8ByteLength(text));

		if (this.openSpill || this.shouldUseTempFile()) {
			this.ensureTempFile();
			this.openSpill?.write(data);
		} else if (data.length > 0) {
			this.rawChunks.push(data);
		}
	}

	appendText(text: string): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}
		if (text.length === 0) {
			return;
		}

		const bytes = utf8ByteLength(text);
		this.totalRawBytes += bytes;
		this.appendDecodedText(text, bytes);

		if (this.openSpill || this.shouldUseTempFile()) {
			this.ensureTempFile();
			this.openSpill?.write(text);
		} else {
			this.rawChunks.push(text);
		}
	}

	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		const finalText = this.decoder.decode();
		this.appendDecodedText(finalText, utf8ByteLength(finalText));
		if (this.shouldUseTempFile()) {
			this.ensureTempFile();
		}
	}

	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const tailTruncation = truncateTail(this.getSnapshotText(), {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
			: null;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};

		if (options.persistIfTruncated && truncation.truncated) {
			this.ensureTempFile();
		}

		return {
			content: truncation.content,
			truncation,
			fullOutputPath: this.spill?.path,
		};
	}

	async closeTempFile(): Promise<void> {
		const spill = this.openSpill;
		this.openSpill = undefined;
		if (!spill) {
			return;
		}
		try {
			await spill.close();
		} catch (error) {
			try {
				await this.removeTempFile();
			} catch (unlinkError) {
				throw new AggregateError([error, unlinkError], "Output spill cleanup failed");
			}
			throw error;
		}
	}

	/**
	 * The complete output, for callers that can take more than the display snapshot. Call after
	 * `finish()` and `closeTempFile()`. Output longer than `maxBytes` raw bytes keeps its first and
	 * last `maxBytes / 2` bytes around an omission marker.
	 */
	async readFullOutput(maxBytes: number): Promise<FullOutput> {
		if (!this.spill) {
			// Fork `appendText()` buffers strings beside raw chunks; encode them back before decoding the whole.
			const chunks = this.rawChunks.map((chunk) => (typeof chunk === "string" ? encodeUtf8(chunk) : chunk));
			return { content: new TextDecoder().decode(concatBytes(chunks)), truncated: false };
		}
		return this.spill.readFull(maxBytes);
	}

	getLastLineBytes(): number {
		return this.currentLineBytes;
	}

	async removeTempFile(): Promise<void> {
		if (!this.spill) {
			return;
		}
		await this.spill.remove();
		this.spill = undefined;
	}

	private appendDecodedText(text: string, bytes: number): void {
		if (text.length === 0) {
			return;
		}

		this.totalDecodedBytes += bytes;
		this.tail.append(text, bytes, !this.hasOpenLine);

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.currentLineBytes += bytes;
			this.hasOpenLine = true;
		} else {
			this.completedLines += newlines;
			const tail = text.slice(lastNewline + 1);
			this.currentLineBytes = utf8ByteLength(tail);
			this.hasOpenLine = tail.length > 0;
		}
		this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
	}

	private getSnapshotText(): string {
		const text = this.tail.text();
		if (this.tail.startsAtLineBoundary) {
			return text;
		}

		const firstNewline = text.indexOf("\n");
		return firstNewline === -1 ? text : text.slice(firstNewline + 1);
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
		);
	}

	private ensureTempFile(): void {
		if (this.spill) {
			return;
		}
		const spill = this.createSpill(this.tempFilePrefix);
		this.spill = spill;
		this.openSpill = spill;
		for (const chunk of this.rawChunks) {
			spill.write(chunk);
		}
		this.rawChunks = [];
	}
}
