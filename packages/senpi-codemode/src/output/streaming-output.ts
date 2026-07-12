import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "../host-sdk.ts";
import { formatMiddleElisionMarker } from "./output-meta.ts";

export { artifactNotice, formatMiddleElisionMarker, resolveSessionArtifactsDir } from "./output-meta.ts";
export { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail };

export const ARTIFACT_DEFAULT_HEAD_BYTES = 3 * 1024 * 1024;

export interface OutputSummary {
	readonly output: string;
	readonly truncated: boolean;
	readonly totalLines: number;
	readonly totalBytes: number;
	readonly outputLines: number;
	readonly outputBytes: number;
	readonly elidedBytes?: number;
	readonly elidedLines?: number;
	readonly columnDroppedBytes?: number;
	readonly columnTruncatedLines?: number;
	readonly artifactId?: string;
}

export interface OutputSinkOptions {
	readonly artifactPath?: string;
	readonly spillThreshold?: number;
	readonly headBytes?: number;
	readonly maxColumns?: number;
	readonly onChunk?: (chunk: string) => void;
	readonly chunkThrottleMs?: number;
}

interface ByteSlice {
	readonly text: string;
	readonly bytes: number;
}

function countNewlines(text: string): number {
	let count = 0;
	let cursor = text.indexOf("\n");
	while (cursor !== -1) {
		count++;
		cursor = text.indexOf("\n", cursor + 1);
	}
	return count;
}

function lineCount(text: string): number {
	return text.length === 0 ? 0 : countNewlines(text) + 1;
}

function truncateHeadBytes(text: string, maxBytes: number): ByteSlice {
	if (maxBytes <= 0) return { text: "", bytes: 0 };
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) return { text, bytes: buffer.length };
	let end = maxBytes;
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	const slice = buffer.subarray(0, end);
	return { text: slice.toString("utf8"), bytes: slice.length };
}

function truncateTailBytes(text: string, maxBytes: number): ByteSlice {
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

export class OutputSink {
	readonly #artifactPath: string | undefined;
	readonly #spillThreshold: number;
	readonly #headLimit: number;
	readonly #maxColumns: number;
	readonly #onChunk: ((chunk: string) => void) | undefined;
	readonly #chunkThrottleMs: number;
	readonly #tail: TailBuffer;
	#head = "";
	#headBytes = 0;
	#totalNewlines = 0;
	#totalBytes = 0;
	#sawData = false;
	#truncated = false;
	#currentLineBytes = 0;
	#columnCapped = false;
	#columnDroppedBytes = 0;
	#columnTruncatedLines = 0;
	#lastChunkTime = 0;
	#pendingChunk = "";
	#beforeSpill = "";
	#file: WriteStream | undefined;
	#fileError: Error | undefined;
	#dumpPromise: Promise<OutputSummary> | undefined;

	constructor(options: OutputSinkOptions = {}) {
		this.#artifactPath = options.artifactPath;
		this.#spillThreshold = Math.max(0, Math.floor(options.spillThreshold ?? DEFAULT_MAX_BYTES));
		this.#headLimit = Math.max(0, Math.floor(options.headBytes ?? 0));
		this.#maxColumns = Math.max(0, Math.floor(options.maxColumns ?? 0));
		this.#onChunk = options.onChunk;
		this.#chunkThrottleMs = Math.max(0, Math.floor(options.chunkThrottleMs ?? 0));
		this.#tail = new TailBuffer(this.#spillThreshold);
	}

	push(chunk: string): void {
		if (chunk.length === 0) return;
		this.#emitPreview(chunk);
		const rawBytes = Buffer.byteLength(chunk, "utf8");
		this.#totalBytes += rawBytes;
		this.#totalNewlines += countNewlines(chunk);
		this.#sawData = true;
		this.#mirrorRaw(chunk);
		this.#retain(this.#maxColumns > 0 ? this.#clampColumns(chunk) : chunk);
	}

	dump(notice?: string): Promise<OutputSummary> {
		this.#dumpPromise ??= this.#finishDump(notice);
		return this.#dumpPromise;
	}

	#emitPreview(chunk: string): void {
		if (this.#onChunk === undefined) return;
		const now = Date.now();
		if (now - this.#lastChunkTime >= this.#chunkThrottleMs) {
			this.#lastChunkTime = now;
			this.#onChunk(this.#pendingChunk + chunk);
			this.#pendingChunk = "";
			return;
		}
		this.#pendingChunk += chunk;
	}

	#mirrorRaw(chunk: string): void {
		if (this.#artifactPath === undefined) return;
		if (this.#file !== undefined) {
			this.#file.write(chunk);
			return;
		}
		if (this.#totalBytes <= this.#spillThreshold) {
			this.#beforeSpill += chunk;
			return;
		}
		mkdirSync(dirname(this.#artifactPath), { recursive: true });
		const stream = createWriteStream(this.#artifactPath, { encoding: "utf8" });
		stream.on("error", (error) => {
			this.#fileError = error;
		});
		this.#file = stream;
		if (this.#beforeSpill.length > 0) stream.write(this.#beforeSpill);
		this.#beforeSpill = "";
		stream.write(chunk);
	}

	#retain(text: string): void {
		let tailText = text;
		if (this.#headBytes < this.#headLimit) {
			const head = truncateHeadBytes(text, this.#headLimit - this.#headBytes);
			this.#head += head.text;
			this.#headBytes += head.bytes;
			tailText = text.substring(head.text.length);
		}
		this.#tail.append(tailText);
		const effectiveBytes = this.#totalBytes - this.#columnDroppedBytes;
		if (effectiveBytes > this.#headBytes + this.#tail.bytes()) this.#truncated = true;
	}

	#clampColumns(chunk: string): string {
		const output: string[] = [];
		let cursor = 0;
		while (cursor < chunk.length) {
			const newline = chunk.indexOf("\n", cursor);
			const end = newline === -1 ? chunk.length : newline;
			const segment = chunk.substring(cursor, end);
			if (segment.length > 0) {
				const segmentBytes = Buffer.byteLength(segment, "utf8");
				if (this.#columnCapped) {
					this.#columnDroppedBytes += segmentBytes;
				} else {
					const remaining = Math.max(0, this.#maxColumns - this.#currentLineBytes);
					const kept = truncateHeadBytes(segment, remaining);
					output.push(kept.text);
					this.#currentLineBytes += kept.bytes;
					if (kept.bytes < segmentBytes) {
						output.push("…");
						this.#columnDroppedBytes += segmentBytes - kept.bytes;
						this.#columnTruncatedLines++;
						this.#columnCapped = true;
						this.#truncated = true;
					}
				}
			}
			if (newline === -1) break;
			output.push("\n");
			this.#currentLineBytes = 0;
			this.#columnCapped = false;
			cursor = newline + 1;
		}
		return output.join("");
	}

	async #finishDump(notice: string | undefined): Promise<OutputSummary> {
		if (this.#onChunk !== undefined && this.#pendingChunk.length > 0) {
			this.#onChunk(this.#pendingChunk);
			this.#pendingChunk = "";
		}
		await this.#closeFile();
		let tail = this.#tail.text();
		if (lineCount(tail) > DEFAULT_MAX_LINES) {
			tail = truncateTail(tail, { maxLines: DEFAULT_MAX_LINES, maxBytes: Number.MAX_SAFE_INTEGER }).content;
			this.#truncated = true;
		}
		const totalLines = this.#sawData ? this.#totalNewlines + 1 : 0;
		const tailBytes = Buffer.byteLength(tail, "utf8");
		const effectiveBytes = Math.max(0, this.#totalBytes - this.#columnDroppedBytes);
		let body = this.#head + tail;
		let elidedBytes: number | undefined;
		let elidedLines: number | undefined;
		if (this.#headBytes > 0 && effectiveBytes > this.#headBytes + tailBytes) {
			elidedBytes = effectiveBytes - this.#headBytes - tailBytes;
			elidedLines = Math.max(0, totalLines - lineCount(this.#head) - lineCount(tail));
			const headSeparator = this.#head.endsWith("\n") ? "" : "\n";
			const tailSeparator = tail.length === 0 || tail.startsWith("\n") ? "" : "\n";
			body = `${this.#head}${headSeparator}${formatMiddleElisionMarker(elidedLines, elidedBytes)}${tailSeparator}${tail}`;
			this.#truncated = true;
		}
		return {
			output: notice === undefined ? body : `[${notice}]\n${body}`,
			truncated: this.#truncated,
			totalLines,
			totalBytes: this.#totalBytes,
			outputLines: lineCount(body),
			outputBytes: Buffer.byteLength(body, "utf8"),
			elidedBytes,
			elidedLines,
			columnDroppedBytes: this.#columnDroppedBytes > 0 ? this.#columnDroppedBytes : undefined,
			columnTruncatedLines: this.#columnTruncatedLines > 0 ? this.#columnTruncatedLines : undefined,
			artifactId: this.#file === undefined ? undefined : this.#artifactPath,
		};
	}

	async #closeFile(): Promise<void> {
		const stream = this.#file;
		if (stream === undefined) return;
		if (this.#fileError !== undefined) throw this.#fileError;
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				stream.off("finish", onFinish);
				reject(error);
			};
			const onFinish = () => {
				stream.off("error", onError);
				resolve();
			};
			stream.once("error", onError);
			stream.once("finish", onFinish);
			stream.end();
		});
	}
}
