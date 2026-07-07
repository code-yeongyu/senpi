import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "../../../../../config.ts";
import type { McpSettings } from "../config-schema.ts";
import type { McpMappedContentBlock } from "../expose/schema-compat.ts";

export interface McpOutputGuardOptions {
	readonly agentDir?: string;
	readonly server: string;
	readonly outputGuard?: McpSettings["outputGuard"];
}

interface Payload {
	readonly bytes: Buffer;
	readonly extension: string;
	readonly lineCount: number;
	readonly previewSource: string;
	readonly summary: string;
}

const DEFAULT_MAX_BYTES = 50 * 1024;
const DEFAULT_MAX_LINES = 2000;
const PREVIEW_BYTE_BUDGET = 8192;
let spillCounter = 0;
const spilledFiles = new Set<string>();

export async function applyMcpOutputGuard(
	content: readonly McpMappedContentBlock[],
	options: McpOutputGuardOptions,
): Promise<readonly McpMappedContentBlock[]> {
	const limits = outputGuardLimits(options.outputGuard);
	const payload = contentToPayload(content);
	if (payload.bytes.byteLength <= limits.maxBytes && payload.lineCount <= limits.maxLines) return content;
	const preview = buildPreview(payload, limits);
	try {
		const path = await writePayload(payload, options);
		return [{ type: "text", text: spillMessage(payload, preview, path) }];
	} catch (error) {
		return [{ type: "text", text: fallbackMessage(payload, preview, error) }];
	}
}

function outputGuardLimits(outputGuard: McpSettings["outputGuard"]): { maxBytes: number; maxLines: number } {
	return {
		maxBytes: positiveInteger(outputGuard?.maxBytes) ?? DEFAULT_MAX_BYTES,
		maxLines: positiveInteger(outputGuard?.maxLines) ?? DEFAULT_MAX_LINES,
	};
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function contentToPayload(content: readonly McpMappedContentBlock[]): Payload {
	if (content.length === 1) {
		const binary = binaryPayload(content[0]);
		if (binary !== undefined) return binary;
	}
	const text = content.map(textForBlock).join("\n");
	const bytes = Buffer.from(text, "utf8");
	return {
		bytes,
		extension: "txt",
		lineCount: countLines(text),
		previewSource: text,
		summary: `text output (${bytes.byteLength} bytes, ${countLines(text)} lines)`,
	};
}

function binaryPayload(block: McpMappedContentBlock): Payload | undefined {
	if ((block.type === "image" || block.type === "audio") && block.data.length > 0) {
		const bytes = Buffer.from(block.data, "base64");
		return {
			bytes,
			extension: extensionForMime(block.mimeType),
			lineCount: 1,
			previewSource: `[${block.mimeType} binary output, ${bytes.byteLength} bytes]`,
			summary: `${block.mimeType} binary output (${bytes.byteLength} bytes)`,
		};
	}
	if (block.type !== "resource" || !isRecord(block.resource)) return undefined;
	const mimeType = typeof block.resource.mimeType === "string" ? block.resource.mimeType : "application/octet-stream";
	if (typeof block.resource.blob === "string") {
		const bytes = Buffer.from(block.resource.blob, "base64");
		return {
			bytes,
			extension: extensionForMime(mimeType),
			lineCount: 1,
			previewSource: `[${mimeType} binary resource, ${bytes.byteLength} bytes]`,
			summary: `${mimeType} binary resource (${bytes.byteLength} bytes)`,
		};
	}
	if (typeof block.resource.text === "string") {
		const bytes = Buffer.from(block.resource.text, "utf8");
		return {
			bytes,
			extension: extensionForMime(mimeType),
			lineCount: countLines(block.resource.text),
			previewSource: block.resource.text,
			summary: `${mimeType} resource (${bytes.byteLength} bytes, ${countLines(block.resource.text)} lines)`,
		};
	}
	return undefined;
}

async function writePayload(payload: Payload, options: McpOutputGuardOptions): Promise<string> {
	const dir = join(options.agentDir ?? getAgentDir(), "tmp", "mcp-out");
	await mkdir(dir, { recursive: true });
	const path = join(
		dir,
		`${safePathPart(options.server)}-${Date.now()}-${process.hrtime.bigint()}-${spillCounter++}.${payload.extension}`,
	);
	await writeFile(path, payload.bytes, { mode: 0o600 });
	await chmod(path, 0o600);
	spilledFiles.add(path);
	return path;
}

export async function cleanupMcpOutputArtifacts(): Promise<void> {
	const files = [...spilledFiles];
	spilledFiles.clear();
	await Promise.all(files.map((file) => rm(file, { force: true })));
}

function buildPreview(payload: Payload, limits: { maxBytes: number; maxLines: number }): string {
	const maxBytes = Math.min(PREVIEW_BYTE_BUDGET, Math.max(1024, Math.floor(limits.maxBytes / 2)));
	const maxLines = Math.min(80, Math.max(2, Math.floor(limits.maxLines / 2)));
	return trimBytes(headTailLines(payload.previewSource, maxLines), maxBytes);
}

function spillMessage(payload: Payload, preview: string, path: string): string {
	return [
		`MCP tool output exceeded outputGuard; ${payload.summary}.`,
		`Full output saved to: ${path}`,
		"Read the file in chunks instead of loading the entire file at once.",
		"Preview:",
		preview,
	].join("\n");
}

function fallbackMessage(payload: Payload, preview: string, error: unknown): string {
	return [
		`Warning: failed to write MCP output spill file: ${errorLabel(error)}`,
		`MCP output truncated inline; ${payload.summary}.`,
		"Preview:",
		preview,
	].join("\n");
}

function headTailLines(text: string, maxLines: number): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	const headCount = Math.max(1, Math.floor(maxLines / 2));
	const tailCount = Math.max(1, maxLines - headCount);
	return [...lines.slice(0, headCount), "[... truncated ...]", ...lines.slice(-tailCount)].join("\n");
}

function trimBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let result = text;
	while (result.length > 0 && Buffer.byteLength(`${result}\n[... truncated ...]`, "utf8") > maxBytes) {
		result = result.slice(0, Math.max(0, result.length - 256));
	}
	return `${result}\n[... truncated ...]`;
}

function textForBlock(block: McpMappedContentBlock): string {
	if (block.type === "text") return block.text;
	if (block.type === "image" || block.type === "audio") {
		return `[${block.mimeType} binary output, ${Buffer.byteLength(block.data, "base64")} bytes]`;
	}
	return JSON.stringify(block);
}

function countLines(text: string): number {
	return text.length === 0 ? 0 : text.split("\n").length;
}

function extensionForMime(mimeType: string): string {
	if (mimeType === "image/png") return "png";
	if (mimeType === "image/jpeg") return "jpg";
	if (mimeType === "image/webp") return "webp";
	if (mimeType === "image/gif") return "gif";
	if (mimeType === "audio/mpeg") return "mp3";
	if (mimeType === "audio/wav") return "wav";
	if (mimeType === "application/json") return "json";
	if (mimeType === "application/pdf") return "pdf";
	if (mimeType.startsWith("text/")) return "txt";
	return "bin";
}

function safePathPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "_") || "server";
}

function errorLabel(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
