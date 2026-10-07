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

export function sanitizeString(value: string): string {
	let output = "";
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				output += value[index] + value[index + 1];
				index += 1;
			} else {
				output += "\uFFFD";
			}
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			output += "\uFFFD";
		} else {
			output += value[index];
		}
	}
	return output;
}
