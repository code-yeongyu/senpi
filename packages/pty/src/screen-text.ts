import { Buffer } from "node:buffer";
import type { Terminal as XtermTerminalType } from "@xterm/headless";

const DEFAULT_SCROLLBACK = 1000;
const MIN_SIZE = 1;
const MAX_SIZE = 10000;
const MIN_REPLAY_HISTORY_LENGTH = 4096;
const MAX_REPLAY_HISTORY_LENGTH = 1_000_000;

export function readLine(buffer: XtermTerminalType["buffer"]["active"], lineIndex: number): string {
	return buffer.getLine(lineIndex)?.translateToString(true) ?? "";
}

export function normalizeDimension(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.trunc(value)));
}

export function normalizeScrollback(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_SCROLLBACK;
	return Math.max(0, Math.trunc(value));
}

export function normalizeReplayHistoryLength(cols: number, rows: number, scrollback: number): number {
	const visibleCells = Math.max(MIN_SIZE, cols) * Math.max(MIN_SIZE, rows + scrollback + 1);
	return Math.min(MAX_REPLAY_HISTORY_LENGTH, Math.max(MIN_REPLAY_HISTORY_LENGTH, visibleCells * 4));
}

export function decodeInput(value: string | Uint8Array): string {
	if (typeof value === "string") return value;
	return new TextDecoder("utf-8", { fatal: false }).decode(value);
}

/**
 * The last `maxLength` chars of `value`, sanitized, as a copy that does not keep `value` alive: a plain
 * slice of an oversized chunk would pin the whole chunk in replay history (senpi#3170). The UTF-16
 * round trip is lossless, lone surrogates included, and runs only when a chunk outgrows the cap.
 */
export function sanitizedTail(value: string, maxLength: number): string {
	const tail = Buffer.from(value.slice(-maxLength), "utf16le").toString("utf16le");
	return sanitizeString(tail);
}

/**
 * Replaces lone surrogates with U+FFFD. Valid text comes back as the same string, and repaired text is
 * joined from slices: the screen keeps these strings as replay history, and a string grown one character
 * at a time stays a rope of per-character nodes (senpi#3170).
 */
export function sanitizeString(value: string): string {
	const parts: string[] = [];
	let copiedUpTo = 0;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 0xd800 || code > 0xdfff) continue;
		if (code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				index += 1;
				continue;
			}
		}
		parts.push(value.slice(copiedUpTo, index), "\uFFFD");
		copiedUpTo = index + 1;
	}
	if (parts.length === 0) return value;
	parts.push(value.slice(copiedUpTo));
	return parts.join("");
}
