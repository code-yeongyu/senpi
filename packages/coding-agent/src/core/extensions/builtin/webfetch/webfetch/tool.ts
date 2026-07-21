import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { defineTool } from "../../../types.ts";

import { htmlToMarkdown, htmlToText } from "./content.ts";
import { clampTimeout, fetchUrl, type WebfetchFormat } from "./fetcher.ts";

const WEBFETCH_FORMATS = ["markdown", "text", "html"] as const;

const Params = Type.Object({
	url: Type.String({ description: "The URL to fetch content from" }),
	format: Type.Optional(
		StringEnum(["markdown", "text", "html"] as const, {
			description: "The format to return the content in. Defaults to markdown.",
		}),
	),
	timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds. Maximum 120." })),
});

export interface WebfetchDetails {
	url: string;
	finalUrl: string;
	format: WebfetchFormat;
	status: number;
	statusText: string;
	contentType: string;
	bytes: number;
	timeoutSeconds: number;
	converted: boolean;
	/** Whether the network response body was truncated at the {@link MAX_RESPONSE_SIZE_BYTES} fetch limit. */
	truncated: boolean;
	/** Whether the text handed to the model was capped below the raw content size. */
	outputTruncated: boolean;
	/** Byte length of the text handed to the model (excluding the truncation notice). */
	outputBytes: number;
	/** Byte length of the full converted text before the output cap. */
	outputTotalBytes: number;
}

export interface WebfetchProgressDetails {
	phase: "fetching" | "downloading" | "converting";
	url: string;
	format: WebfetchFormat;
	timeoutSeconds: number;
	bytesRead?: number;
	totalBytes?: number;
	progress: {
		activity: string;
		startedAt: number;
		maxWaitMs: number;
	};
}

export type WebfetchRenderDetails = WebfetchDetails | WebfetchProgressDetails;

export const webfetch = defineTool<typeof Params, WebfetchRenderDetails>({
	name: "webfetch",
	label: "Web Fetch",
	description:
		"Fetches content from a URL and returns it as markdown, plain text, or HTML. " +
		"Network use is bounded by timeout and response size limits.",
	promptSnippet: "webfetch: retrieve URL content as markdown, text, or html",
	promptGuidelines: [
		"Use webfetch when a specific URL must be retrieved.",
		"Prefer markdown format unless raw HTML or plain text is explicitly needed.",
		"The tool is read-only and does not modify files.",
	],
	parameters: Params,
	async execute(_toolCallId, params, signal, onUpdate, _ctx) {
		const format = parseWebfetchFormat(params.format);
		const timeoutSeconds = clampTimeout(params.timeout);
		const startedAt = Date.now();
		const progress = {
			activity: `fetching ${params.url}`,
			startedAt,
			maxWaitMs: timeoutSeconds * 1000,
		};
		let downloadedTotalBytes: number | undefined;
		const emitProgress = (details: WebfetchProgressDetails): void => {
			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Fetching ${params.url} as ${format} (timeout ${timeoutSeconds}s)`,
					},
				],
				details,
			});
		};
		emitProgress({
			phase: "fetching",
			url: params.url,
			format,
			timeoutSeconds,
			progress,
		});

		const fetched = await fetchUrl({
			url: params.url,
			format,
			timeoutSeconds,
			...(signal === undefined ? {} : { signal }),
			onProgress: (bytesRead, totalBytes) => {
				downloadedTotalBytes = totalBytes;
				emitProgress({
					phase: "downloading",
					url: params.url,
					format,
					timeoutSeconds,
					bytesRead,
					...(totalBytes === undefined ? {} : { totalBytes }),
					progress,
				});
			},
		});
		const raw = new TextDecoder().decode(fetched.body);
		const contentType = fetched.contentType.toLowerCase();
		emitProgress({
			phase: "converting",
			url: params.url,
			format,
			timeoutSeconds,
			bytesRead: fetched.bytes,
			...(downloadedTotalBytes === undefined ? {} : { totalBytes: downloadedTotalBytes }),
			progress,
		});
		const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
		let text = raw;
		let converted = false;

		if (isHtml && format === "markdown") {
			text = htmlToMarkdown(raw, fetched.url);
			converted = true;
		} else if (isHtml && format === "text") {
			text = htmlToText(raw, fetched.url);
			converted = true;
		}

		const capped = capWebfetchOutput(text);

		const details: WebfetchDetails = {
			url: params.url,
			finalUrl: fetched.url,
			format,
			status: fetched.status,
			statusText: fetched.statusText,
			contentType: fetched.contentType,
			bytes: fetched.bytes,
			timeoutSeconds,
			converted,
			truncated: fetched.truncated,
			outputTruncated: capped.truncated,
			outputBytes: capped.outputBytes,
			outputTotalBytes: capped.totalBytes,
		};

		return {
			content: [{ type: "text", text: capped.text }],
			details,
		};
	},
});

export function parseWebfetchFormat(value: unknown): WebfetchFormat {
	if (value === undefined) return "markdown";
	for (const format of WEBFETCH_FORMATS) {
		if (value === format) return format;
	}
	return "markdown";
}

/** Byte ceiling for the text handed to the model, mirroring senpi's read-tool output cap. */
export const DEFAULT_OUTPUT_MAX_BYTES = 50 * 1024;

export interface WebfetchOutputCap {
	/** Model-facing text after the output cap, with a notice appended when truncated. */
	text: string;
	/** Whether the text was capped below the full converted size. */
	truncated: boolean;
	/** Byte length of {@link WebfetchOutputCap.text} excluding the appended notice. */
	outputBytes: number;
	/** Byte length of the full converted text before capping. */
	totalBytes: number;
}

/**
 * Bound the text handed to the model so a single fetch cannot flood the context
 * window and force an unwanted compaction. Keeps whole leading lines until the
 * byte ceiling is hit; when the first line alone exceeds the ceiling (minified
 * JSON, single-line payloads) it falls back to a UTF-8-safe byte prefix so the
 * head is preserved instead of dropped.
 */
export function capWebfetchOutput(text: string): WebfetchOutputCap {
	const totalBytes = Buffer.byteLength(text, "utf-8");
	if (totalBytes <= DEFAULT_OUTPUT_MAX_BYTES) {
		return { text, truncated: false, outputBytes: totalBytes, totalBytes };
	}

	const head = takeHeadBytes(text, DEFAULT_OUTPUT_MAX_BYTES);
	const outputBytes = Buffer.byteLength(head, "utf-8");
	const notice = `\n\n[Output truncated: ${formatByteSize(outputBytes)} of ${formatByteSize(
		totalBytes,
	)} shown (${formatByteSize(DEFAULT_OUTPUT_MAX_BYTES)} limit). Re-fetch a more specific URL or use web_search for targeted content.]`;
	return { text: head + notice, truncated: true, outputBytes, totalBytes };
}

/** Keep whole leading lines within the byte ceiling; fall back to a UTF-8-safe byte prefix for one oversized line. */
function takeHeadBytes(text: string, maxBytes: number): string {
	const lines: string[] = [];
	let usedBytes = 0;
	let start = 0;
	while (start <= text.length) {
		const newlineIndex = text.indexOf("\n", start);
		const line = newlineIndex === -1 ? text.slice(start) : text.slice(start, newlineIndex);
		const lineBytes = Buffer.byteLength(line, "utf-8") + (lines.length > 0 ? 1 : 0);
		if (usedBytes + lineBytes > maxBytes) break;
		lines.push(line);
		usedBytes += lineBytes;
		if (newlineIndex === -1) break;
		start = newlineIndex + 1;
	}
	return lines.length === 0 ? sliceUtf8Head(text, maxBytes) : lines.join("\n");
}

/** Slice the first {@link maxBytes} bytes of a UTF-8 string without leaving a split code point. */
function sliceUtf8Head(value: string, maxBytes: number): string {
	const buffer = Buffer.from(value, "utf-8");
	if (buffer.length <= maxBytes) return value;
	const decoded = new TextDecoder("utf-8").decode(buffer.subarray(0, maxBytes));
	// A trailing partial code point decodes to U+FFFD; drop it so no split byte remains.
	return decoded.endsWith("\uFFFD") ? decoded.slice(0, -1) : decoded;
}

/** Human-readable byte size (B / KB / MB). */
function formatByteSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
