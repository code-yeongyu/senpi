import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SessionArtifactsDir {
	readonly dir: string;
	readonly temp: boolean;
}

export function formatMiddleElisionMarker(elidedLines: number, elidedBytes: number): string {
	return elidedLines <= 1 ? `[…${elidedBytes}B elided…]` : `[…${elidedLines}ln elided…]`;
}

export function artifactNotice(path: string): string {
	return `[Full output: ${path}]`;
}

export function resolveSessionArtifactsDir(sessionFile: string | undefined): SessionArtifactsDir {
	const temp = sessionFile === undefined;
	const dir =
		sessionFile === undefined
			? join(tmpdir(), `senpi-codemode-${randomBytes(8).toString("hex")}`)
			: `${sessionFile.endsWith(".jsonl") ? sessionFile.slice(0, -6) : sessionFile}-artifacts`;
	mkdirSync(dir, { recursive: true });
	return { dir, temp };
}

export interface TruncationMeta {
	readonly direction: "head" | "tail" | "middle";
	readonly truncatedBy: "lines" | "bytes" | "middle";
	readonly totalLines: number;
	readonly totalBytes: number;
	readonly outputLines: number;
	readonly outputBytes: number;
	readonly maxBytes?: number;
	readonly shownRange?: { readonly start: number; readonly end: number };
	readonly headRange?: { readonly start: number; readonly end: number };
	readonly tailRange?: { readonly start: number; readonly end: number };
	readonly elidedBytes?: number;
	readonly elidedLines?: number;
	/** Plain absolute artifact path; retained under the upstream field name. */
	readonly artifactId?: string;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function assertNever(value: never): never {
	throw new TypeError(`Unhandled truncation direction: ${String(value)}`);
}

export function formatTruncationWarning(meta: TruncationMeta | undefined): string | null {
	if (meta === undefined) return null;
	let message: string;
	switch (meta.direction) {
		case "middle": {
			const elidedLines = meta.elidedLines ?? Math.max(0, meta.totalLines - meta.outputLines);
			const elidedBytes = meta.elidedBytes ?? Math.max(0, meta.totalBytes - meta.outputBytes);
			message =
				meta.headRange !== undefined && meta.tailRange !== undefined
					? `Showing lines ${meta.headRange.start}-${meta.headRange.end} and ${meta.tailRange.start}-${meta.tailRange.end} of ${meta.totalLines}; ${elidedLines} middle line${elidedLines === 1 ? "" : "s"} (${formatBytes(elidedBytes)}) elided`
					: `Showing ${meta.outputLines} of ${meta.totalLines} lines; middle elided`;
			break;
		}
		case "head":
		case "tail":
			message =
				meta.shownRange !== undefined && meta.shownRange.end >= meta.shownRange.start
					? `Showing lines ${meta.shownRange.start}-${meta.shownRange.end} of ${meta.totalLines}`
					: `Showing ${meta.outputLines} of ${meta.totalLines} lines`;
			if (meta.truncatedBy === "bytes") message += ` (${formatBytes(meta.maxBytes ?? meta.outputBytes)} limit)`;
			break;
		default:
			return assertNever(meta.direction);
	}
	if (meta.artifactId !== undefined) message += `. Full output: ${meta.artifactId}`;
	return `[${message}]`;
}

export function stripOutputNotice(text: string, meta: TruncationMeta | undefined): string {
	const notice = formatTruncationWarning(meta);
	if (notice === null) return text;
	const trimmed = text.trimEnd();
	return trimmed.endsWith(notice) ? trimmed.slice(0, -notice.length).trimEnd() : text;
}
