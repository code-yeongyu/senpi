import { writeFile } from "node:fs/promises";
import type { AgentToolResult, ExtensionContext } from "@code-yeongyu/senpi";
import { convertToPng, formatDimensionNote, resizeImage } from "@code-yeongyu/senpi";
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

const MAX_DISPLAY_TEXT_BYTES = 8_000;

export interface EvalImageContent {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

export interface EvalImageResizeResult {
	readonly image: EvalImageContent;
	readonly dimensionNote?: string;
}

export type EvalImageResizer = (
	image: EvalImageContent,
	model: ExtensionContext["model"],
) => Promise<EvalImageResizeResult>;

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
type WebpModel = { readonly provider: string; readonly api: string } | undefined;

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
			this.#displayImages.push({ type: "image", mimeType: message.mimeType, data: message.dataBase64 });
			return;
		}
		const text = Buffer.from(message.dataBase64, "base64").toString("utf8");
		if (message.mimeType === "application/json") {
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
		const summary = await this.#finalSummary();
		const meta = truncationMetaFromSummary(summary);
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

export function webpExclusionForModel(model: WebpModel): true | undefined {
	if (model === undefined) return undefined;
	return model.provider === "ollama" ||
		model.provider === "ollama-cloud" ||
		model.provider === "llama.cpp" ||
		model.provider === "lm-studio" ||
		model.provider === "local-server" ||
		model.api === "ollama-chat"
		? true
		: undefined;
}

export const resizeEvalImage: EvalImageResizer = async (image, model) => {
	const excludeWebP = webpExclusionForModel(model);
	const forceWebpConversion = excludeWebP === true && image.mimeType === "image/webp";
	const resized = await resizeImage(
		Buffer.from(image.data, "base64"),
		image.mimeType,
		forceWebpConversion ? { maxBytes: Buffer.byteLength(image.data, "utf8") } : undefined,
	);
	let output: EvalImageContent =
		resized === null ? image : { type: "image", data: resized.data, mimeType: resized.mimeType };
	if (excludeWebP === true && output.mimeType === "image/webp") {
		const converted = await convertToPng(output.data, output.mimeType);
		if (converted === null)
			throw new TypeError(`Unable to convert ${output.mimeType} display output for the active model`);
		output = { type: "image", data: converted.data, mimeType: converted.mimeType };
	}
	const dimensionNote = resized === null ? undefined : formatDimensionNote(resized);
	return { image: output, ...(dimensionNote === undefined ? {} : { dimensionNote }) };
};

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

function truncationMetaFromSummary(summary: OutputSummary): TruncationMeta | undefined {
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
	return {
		direction: "tail",
		truncatedBy: summary.outputBytes < summary.totalBytes ? "bytes" : "lines",
		totalLines: summary.totalLines,
		totalBytes: summary.totalBytes,
		outputLines: summary.outputLines,
		outputBytes: summary.outputBytes,
		shownRange: { start: Math.max(1, summary.totalLines - summary.outputLines + 1), end: summary.totalLines },
		...artifact,
	};
}

export function marshalToolResult(result: AgentToolResult<unknown>) {
	const texts = result.content.filter((part) => part.type === "text").map((part) => part.text);
	const images = result.content
		.filter((part) => part.type === "image")
		.map((part) => ({ mimeType: part.mimeType, dataBase64: part.data }));
	const details =
		typeof result.details === "object" &&
		result.details !== null &&
		!Array.isArray(result.details) &&
		Object.keys(result.details).length === 0
			? undefined
			: result.details;
	const hasError = toolResultIsError(result);
	const text = texts.join("\n");
	return images.length === 0 && details === undefined && !hasError ? { text } : { text, details, images, hasError };
}

export function toolResultIsError(result: AgentToolResult<unknown>): boolean {
	const details = result.details;
	return typeof details === "object" && details !== null && "isError" in details && details.isError === true;
}
