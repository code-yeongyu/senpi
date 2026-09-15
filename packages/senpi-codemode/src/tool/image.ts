import { writeFile } from "node:fs/promises";
import type { ExtensionContext } from "@code-yeongyu/senpi";
import type { KernelToHostMessage } from "../bridge/protocol.ts";
import type { TruncationMeta } from "../output/output-meta.ts";
import {
	artifactNotice,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	OutputSink,
	type OutputSummary,
	TailBuffer,
	truncateTail,
} from "../output/streaming-output.ts";
import { type EvalImageContent, type EvalImageResizer, resizeEvalImage } from "./image-resize.ts";

export {
	type EvalImageContent,
	type EvalImageResizeResult,
	type EvalImageResizer,
	resizeEvalImage,
	webpExclusionForModel,
} from "./image-resize.ts";
export { marshalToolResult, toolResultIsError } from "./tool-result-marshal.ts";

const MAX_DISPLAY_TEXT_BYTES = 8_000;

// Per-cell display caps: display payloads are retained for the whole result lifetime, so an unbounded
// burst pins base64 originals plus resized copies on the session heap (#1695).
const MAX_DISPLAY_IMAGES_PER_CELL = 8;
const MAX_DISPLAY_IMAGE_BYTES_PER_CELL = 24 * 1024 * 1024;
const MAX_JSON_OUTPUTS_PER_CELL = 64;

export interface EvalOutputOptions {
	readonly artifactPath?: string;
	readonly headBytes: number;
	readonly maxColumns: number;
	readonly model: ExtensionContext["model"];
	readonly imageResizer?: EvalImageResizer;
	readonly onChunk: (aggregateText: string, cellText: string) => void;
}

export interface EvalOutputResult {
	readonly output: string;
	readonly images: readonly EvalImageContent[];
	readonly jsonOutputs: readonly unknown[];
	readonly hasMarkdown: boolean;
	readonly truncated: boolean;
	readonly notice?: string;
	readonly meta?: TruncationMeta;
}

type DisplayMessage = Extract<KernelToHostMessage, { type: "display" }>;

class DisplayPayloadError extends Error {
	readonly name = "DisplayPayloadError";

	constructor(mimeType: string, cause: SyntaxError) {
		super(`Invalid ${mimeType} display payload: ${cause.message}`, { cause });
	}
}

export class EvalOutputCollector {
	readonly #options: EvalOutputOptions;
	readonly #sink: OutputSink;
	readonly #aggregateTail = new TailBuffer(DEFAULT_MAX_BYTES * 2);
	readonly #cellTail = new TailBuffer(DEFAULT_MAX_BYTES * 2);
	readonly #displayImages: EvalImageContent[] = [];
	readonly #images: EvalImageContent[] = [];
	readonly #jsonOutputs: unknown[] = [];
	#displayImageBytes = 0;
	#displayImagesElided = 0;
	#jsonOutputsElided = 0;
	#hasMarkdown = false;
	#imagesProcessed = false;

	constructor(options: EvalOutputOptions) {
		this.#options = options;
		this.#sink = new OutputSink({
			artifactPath: options.artifactPath,
			headBytes: options.headBytes,
			maxColumns: options.maxColumns,
			onChunk: (chunk) => {
				this.#aggregateTail.append(chunk);
				this.#cellTail.append(chunk);
				options.onChunk(this.#aggregateTail.text(), this.#cellTail.text());
			},
		});
	}

	push(text: string): void {
		this.#sink.push(text);
	}

	display(message: DisplayMessage): void {
		if (message.mimeType.startsWith("image/")) {
			if (
				this.#displayImages.length >= MAX_DISPLAY_IMAGES_PER_CELL ||
				this.#displayImageBytes + message.dataBase64.length > MAX_DISPLAY_IMAGE_BYTES_PER_CELL
			) {
				this.#displayImagesElided++;
				return;
			}
			this.#displayImages.push({ type: "image", mimeType: message.mimeType, data: message.dataBase64 });
			this.#displayImageBytes += message.dataBase64.length;
			return;
		}
		const text = Buffer.from(message.dataBase64, "base64").toString("utf8");
		if (message.mimeType === "application/json") {
			if (this.#jsonOutputs.length >= MAX_JSON_OUTPUTS_PER_CELL) {
				this.#jsonOutputsElided++;
				return;
			}
			let value: unknown;
			try {
				value = JSON.parse(text);
			} catch (error) {
				if (error instanceof SyntaxError) throw new DisplayPayloadError(message.mimeType, error);
				throw error;
			}
			this.#jsonOutputs.push(value);
			this.#sink.push(`display[${this.#jsonOutputs.length}]:\n${formatDisplayJson(value)}\n`);
			return;
		}
		if (message.mimeType === "text/markdown") this.#hasMarkdown = true;
		this.#sink.push(text.endsWith("\n") ? text : `${text}\n`);
	}

	aggregateText(): string {
		return this.#aggregateTail.text();
	}

	async finish(): Promise<EvalOutputResult> {
		await this.#processImages();
		const elided = this.#displayImagesElided + this.#jsonOutputsElided;
		if (elided > 0) {
			this.#sink.push(
				`[${this.#displayImagesElided} display image(s) and ${this.#jsonOutputsElided} JSON output(s) elided beyond per-cell caps]\n`,
			);
		}
		const summary = await this.#finalSummary();
		const meta = truncationMetaFromSummary(summary, this.#options.maxColumns);
		const notice = summary.artifactId === undefined ? undefined : artifactNotice(summary.artifactId);
		return {
			output: summary.output.trimEnd(),
			images: [...this.#images],
			jsonOutputs: [...this.#jsonOutputs],
			hasMarkdown: this.#hasMarkdown,
			truncated: summary.truncated,
			...(notice === undefined ? {} : { notice }),
			...(meta === undefined ? {} : { meta }),
		};
	}

	async flush(): Promise<void> {
		await this.#sink.dump();
	}

	async #processImages(): Promise<void> {
		if (this.#imagesProcessed) return;
		this.#imagesProcessed = true;
		const resize = this.#options.imageResizer ?? resizeEvalImage;
		for (const source of this.#displayImages) {
			const resized = await resize(source, this.#options.model);
			this.#images.push(resized.image);
			const description = resized.dimensionNote ?? `[${resized.image.mimeType}]`;
			this.#sink.push(`display image ${this.#images.length}: ${description}\n`);
		}
	}

	async #finalSummary(): Promise<OutputSummary> {
		const summary = await this.#sink.dump();
		if (summary.truncated || summary.totalLines <= DEFAULT_MAX_LINES) return summary;
		const truncated = truncateTail(summary.output, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: Number.MAX_SAFE_INTEGER,
		});
		let artifactId = summary.artifactId;
		if (artifactId === undefined && this.#options.artifactPath !== undefined) {
			await writeFile(this.#options.artifactPath, this.#aggregateTail.text(), "utf8");
			artifactId = this.#options.artifactPath;
		}
		return {
			...summary,
			output: truncated.content,
			truncated: true,
			outputLines: truncated.outputLines,
			outputBytes: truncated.outputBytes,
			...(artifactId === undefined ? {} : { artifactId }),
		};
	}
}

function formatDisplayJson(value: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(value, null, 2) ?? String(value);
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		text = String(value);
	}
	if (text.length <= MAX_DISPLAY_TEXT_BYTES) return text;
	return `${text.slice(0, MAX_DISPLAY_TEXT_BYTES)}\n[…${text.length - MAX_DISPLAY_TEXT_BYTES}ch elided…]`;
}

function truncationMetaFromSummary(summary: OutputSummary, maxColumns: number): TruncationMeta | undefined {
	if (!summary.truncated) return undefined;
	const artifact = summary.artifactId === undefined ? {} : { artifactId: summary.artifactId };
	if (summary.elidedBytes !== undefined && summary.elidedBytes > 0) {
		const elidedLines = summary.elidedLines ?? Math.max(0, summary.totalLines - summary.outputLines);
		const keptLines = Math.max(0, summary.outputLines - 1);
		const headLines = Math.ceil(keptLines / 2);
		const tailLines = keptLines - headLines;
		return {
			direction: "middle",
			truncatedBy: "middle",
			totalLines: summary.totalLines,
			totalBytes: summary.totalBytes,
			outputLines: summary.outputLines,
			outputBytes: summary.outputBytes,
			...(headLines > 0 ? { headRange: { start: 1, end: headLines } } : {}),
			...(tailLines > 0
				? { tailRange: { start: summary.totalLines - tailLines + 1, end: summary.totalLines } }
				: {}),
			elidedBytes: summary.elidedBytes,
			elidedLines,
			...artifact,
		};
	}
	const droppedBytes = Math.max(0, summary.totalBytes - summary.outputBytes);
	const clampedLines = summary.columnTruncatedLines ?? 0;
	const columnOnly = clampedLines > 0 && (summary.columnDroppedBytes ?? 0) >= droppedBytes;
	const byteCapped = summary.totalBytes - (summary.columnDroppedBytes ?? 0) > DEFAULT_MAX_BYTES;
	return {
		direction: "tail",
		truncatedBy: columnOnly ? "columns" : byteCapped ? "bytes" : "lines",
		...(columnOnly
			? { maxColumns, columnTruncatedLines: clampedLines }
			: byteCapped
				? { maxBytes: DEFAULT_MAX_BYTES }
				: {}),
		totalLines: summary.totalLines,
		totalBytes: summary.totalBytes,
		outputLines: summary.outputLines,
		outputBytes: summary.outputBytes,
		shownRange: { start: Math.max(1, summary.totalLines - summary.outputLines + 1), end: summary.totalLines },
		...artifact,
	};
}
