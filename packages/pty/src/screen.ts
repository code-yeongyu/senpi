import type { Terminal as XtermTerminalType } from "@xterm/headless";
import xterm from "@xterm/headless";

export interface TerminalScreenOptions {
	readonly cols?: number;
	readonly rows?: number;
	readonly scrollback?: number;
}

export interface TerminalScreenSnapshot {
	readonly cols: number;
	readonly rows: number;
	readonly visibleGrid: readonly string[];
	readonly scrollback: readonly string[];
	readonly cursor: {
		readonly x: number;
		readonly y: number;
	};
}

const XtermTerminal = xterm.Terminal;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_SCROLLBACK = 1000;
const MIN_SIZE = 1;
const MAX_SIZE = 10000;
const MIN_REPLAY_HISTORY_LENGTH = 4096;
const MAX_REPLAY_HISTORY_LENGTH = 1_000_000;

export class TerminalScreen {
	private terminal: XtermTerminalType;
	private readonly history: string[] = [];
	private historyLength = 0;
	private readonly maxReplayHistoryLength: number;
	private readonly scrollback: number;

	constructor(options: TerminalScreenOptions = {}) {
		const cols = normalizeDimension(options.cols, DEFAULT_COLS);
		const rows = normalizeDimension(options.rows, DEFAULT_ROWS);
		this.scrollback = normalizeScrollback(options.scrollback);
		this.maxReplayHistoryLength = normalizeReplayHistoryLength(cols, rows, this.scrollback);
		this.terminal = this.createTerminal(cols, rows);
	}

	feed(data: string | Uint8Array): Promise<void> {
		const payload = decodeInput(data);
		const sanitizedPayload = sanitizeString(payload);
		if (sanitizedPayload.length > 0) this.appendHistory(sanitizedPayload);
		return this.write(payload);
	}

	resize(cols: number, rows: number): Promise<void> {
		const nextCols = normalizeDimension(cols, this.terminal.cols);
		const nextRows = normalizeDimension(rows, this.terminal.rows);
		this.terminal.dispose();
		this.terminal = this.createTerminal(nextCols, nextRows);
		return this.write(this.history.join(""));
	}

	flush(): Promise<void> {
		return this.write("");
	}

	snapshot(): TerminalScreenSnapshot {
		const buffer = this.terminal.buffer.active;
		const viewportStart = buffer.viewportY;
		const visibleGrid: string[] = [];
		const scrollback: string[] = [];
		const scrollbackStart = Math.max(0, viewportStart - this.scrollback);

		for (let lineIndex = scrollbackStart; lineIndex < viewportStart; lineIndex += 1) {
			scrollback.push(readLine(buffer, lineIndex));
		}
		for (let row = 0; row < this.terminal.rows; row += 1) {
			visibleGrid.push(readLine(buffer, viewportStart + row));
		}

		return {
			cols: this.terminal.cols,
			rows: this.terminal.rows,
			visibleGrid,
			scrollback,
			cursor: {
				x: buffer.cursorX,
				y: buffer.cursorY,
			},
		};
	}

	dispose(): void {
		this.terminal.dispose();
	}

	private createTerminal(cols: number, rows: number): XtermTerminalType {
		return new XtermTerminal({
			cols,
			rows,
			scrollback: this.scrollback,
			disableStdin: true,
			allowProposedApi: true,
			logLevel: "off",
		});
	}

	private write(payload: string): Promise<void> {
		return new Promise((resolve, reject) => {
			try {
				this.terminal.write(payload, resolve);
			} catch (error) {
				const sanitizedPayload = sanitizeString(payload);
				if (sanitizedPayload === payload) {
					reject(error instanceof Error ? error : new Error(String(error)));
					return;
				}
				this.terminal.write(sanitizedPayload, resolve);
			}
		});
	}

	private appendHistory(payload: string): void {
		this.history.push(payload);
		this.historyLength += payload.length;
		this.trimHistory();
	}

	private trimHistory(): void {
		while (this.historyLength > this.maxReplayHistoryLength && this.history.length > 1) {
			const removed = this.history.shift();
			if (removed === undefined) return;
			this.historyLength -= removed.length;
		}

		if (this.historyLength <= this.maxReplayHistoryLength) return;
		const [onlyChunk] = this.history;
		if (onlyChunk === undefined) return;
		const trimmed = sanitizeString(onlyChunk.slice(-this.maxReplayHistoryLength));
		this.history[0] = trimmed;
		this.historyLength = trimmed.length;
	}
}

function readLine(buffer: XtermTerminalType["buffer"]["active"], lineIndex: number): string {
	return buffer.getLine(lineIndex)?.translateToString(true) ?? "";
}

function normalizeDimension(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.trunc(value)));
}

function normalizeScrollback(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_SCROLLBACK;
	return Math.max(0, Math.trunc(value));
}

function normalizeReplayHistoryLength(cols: number, rows: number, scrollback: number): number {
	const visibleCells = Math.max(MIN_SIZE, cols) * Math.max(MIN_SIZE, rows + scrollback + 1);
	return Math.min(MAX_REPLAY_HISTORY_LENGTH, Math.max(MIN_REPLAY_HISTORY_LENGTH, visibleCells * 4));
}

function decodeInput(value: string | Uint8Array): string {
	if (typeof value === "string") return value;
	return new TextDecoder("utf-8", { fatal: false }).decode(value);
}

function sanitizeString(value: string): string {
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
