import type { Terminal as XtermTerminalType } from "@xterm/headless";
import xterm from "@xterm/headless";
import {
	MAX_PENDING_WRITE_CHARS,
	type ReplayOperation,
	type ResizeOperation,
	type ScreenOperation,
	settleOperation,
	sharedSettler,
} from "./screen-operations.ts";

import {
	decodeInput,
	normalizeDimension,
	normalizeReplayHistoryLength,
	normalizeScrollback,
	readLine,
	sanitizeString,
} from "./screen-text.ts";

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

/**
 * Headless xterm screen model with serialized, flow-controlled writes.
 *
 * Every terminal mutation (feed, resize, backlog replay) runs through one
 * FIFO queue that awaits xterm's parse callback before issuing the next
 * write, so xterm's pending-write watermark can never be exceeded. When the
 * queued backlog outgrows {@link MAX_PENDING_WRITE_CHARS}, the queued writes
 * collapse into a single bounded history replay that reconstructs the same
 * screen state. After {@link TerminalScreen.dispose}, queued and future
 * operations settle as resolved no-ops; a terminal is never created after
 * disposal.
 */
export class TerminalScreen {
	private terminal: XtermTerminalType;
	private readonly history: string[] = [];
	private historyLength = 0;
	private readonly operations: ScreenOperation[] = [];
	private pendingChars = 0;
	private draining = false;
	private disposed = false;
	private notifyDisposed: () => void = () => undefined;
	private readonly whenDisposed: Promise<void>;
	private readonly maxReplayHistoryLength: number;
	private readonly scrollback: number;

	constructor(options: TerminalScreenOptions = {}) {
		const cols = normalizeDimension(options.cols, DEFAULT_COLS);
		const rows = normalizeDimension(options.rows, DEFAULT_ROWS);
		this.scrollback = normalizeScrollback(options.scrollback);
		this.maxReplayHistoryLength = normalizeReplayHistoryLength(cols, rows, this.scrollback);
		this.whenDisposed = new Promise((resolve) => {
			this.notifyDisposed = resolve;
		});
		this.terminal = this.createTerminal(cols, rows);
	}

	feed(data: string | Uint8Array): Promise<void> {
		if (this.disposed) return Promise.resolve();
		const payload = decodeInput(data);
		const sanitizedPayload = sanitizeString(payload);
		if (sanitizedPayload.length > 0) this.appendHistory(sanitizedPayload);
		if (this.pendingChars + payload.length > MAX_PENDING_WRITE_CHARS) {
			return this.coalesceFeedIntoReplay(payload);
		}
		this.pendingChars += payload.length;
		const operation: ScreenOperation = { kind: "write", payload, settled: null, settlers: [] };
		return this.enqueue(operation, sharedSettler(operation));
	}

	resize(cols: number, rows: number): Promise<void> {
		if (this.disposed) return Promise.resolve();
		const nextCols = normalizeDimension(cols, this.terminal.cols);
		const nextRows = normalizeDimension(rows, this.terminal.rows);
		const snapshot = this.history.join("");
		const tail = this.operations[this.operations.length - 1];
		if (tail !== undefined && tail.kind === "resize") {
			tail.cols = nextCols;
			tail.rows = nextRows;
			this.pendingChars += snapshot.length - tail.replay.length;
			tail.replay = snapshot;
			return sharedSettler(tail);
		}
		if (this.pendingChars + snapshot.length > MAX_PENDING_WRITE_CHARS) {
			return this.coalesceQueueIntoResize(nextCols, nextRows, snapshot);
		}
		const operation: ResizeOperation = {
			kind: "resize",
			cols: nextCols,
			rows: nextRows,
			replay: snapshot,
			settled: null,
			settlers: [],
		};
		this.pendingChars += snapshot.length;
		return this.enqueue(operation, sharedSettler(operation));
	}

	/**
	 * Resolves once everything fed before this call has been parsed. Attaches
	 * to the queue tail instead of enqueueing a marker so a flush can never
	 * split a tail replay (which would let over-cap feeds mint unbounded new
	 * replay operations); only an empty queue enqueues a zero-length write.
	 */
	flush(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		const tail = this.operations[this.operations.length - 1];
		if (tail !== undefined) return sharedSettler(tail);
		const operation: ScreenOperation = { kind: "write", payload: "", settled: null, settlers: [] };
		return this.enqueue(operation, sharedSettler(operation));
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
		if (this.disposed) return;
		this.disposed = true;
		this.notifyDisposed();
		const pending = this.operations.splice(0, this.operations.length);
		this.pendingChars = 0;
		for (const operation of pending) {
			settleOperation(operation.settlers, null);
		}
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

	private enqueue(operation: ScreenOperation, settled: Promise<void>): Promise<void> {
		this.operations.push(operation);
		void this.drain();
		return settled;
	}

	/**
	 * Route an over-cap feed to the queue's tail replay instead of enqueueing
	 * another write. Replay payloads are owned snapshot strings (immune to
	 * history trimming) bounded to the replay budget, and every coalesced feed
	 * shares the tail's memoized promise, so a flood cannot grow the queue,
	 * its payload memory, or its settler memory past the configured bounds.
	 */
	private coalesceFeedIntoReplay(payload: string): Promise<void> {
		const tail = this.operations[this.operations.length - 1];
		if (tail !== undefined && tail.kind === "replay") {
			const previousLength = tail.payload.length;
			tail.payload = this.boundReplayPayload(tail.payload + payload);
			this.pendingChars += tail.payload.length - previousLength;
			return sharedSettler(tail);
		}
		const operation: ReplayOperation = {
			kind: "replay",
			payload: this.history.join(""),
			settled: null,
			settlers: [],
		};
		this.pendingChars += operation.payload.length;
		return this.enqueue(operation, sharedSettler(operation));
	}

	/**
	 * A resize whose snapshot would push the queued payload past the cap
	 * collapses the whole queue into one resize at the latest dimensions:
	 * every dropped operation's payload is already covered by the bounded
	 * history snapshot, and their settlers settle with this operation.
	 */
	private coalesceQueueIntoResize(cols: number, rows: number, snapshot: string): Promise<void> {
		const operation: ResizeOperation = {
			kind: "resize",
			cols,
			rows,
			replay: snapshot,
			settled: null,
			settlers: [],
		};
		for (const queued of this.operations.splice(0, this.operations.length)) {
			for (const settler of queued.settlers) operation.settlers.push(settler);
			queued.settlers.length = 0;
		}
		this.pendingChars = snapshot.length;
		return this.enqueue(operation, sharedSettler(operation));
	}

	private boundReplayPayload(payload: string): string {
		if (payload.length <= this.maxReplayHistoryLength) return payload;
		return sanitizeString(payload.slice(-this.maxReplayHistoryLength));
	}

	private async drain(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			while (!this.disposed) {
				const operation = this.operations.shift();
				if (operation === undefined) return;
				this.pendingChars -= operation.kind === "resize" ? operation.replay.length : operation.payload.length;
				try {
					await this.run(operation);
					settleOperation(operation.settlers, null);
				} catch (error) {
					settleOperation(operation.settlers, error instanceof Error ? error : new Error(String(error)));
				}
			}
		} finally {
			this.draining = false;
		}
	}

	private async run(operation: ScreenOperation): Promise<void> {
		if (this.disposed) return;
		switch (operation.kind) {
			case "write":
				await this.raceDisposal(this.write(operation.payload));
				return;
			case "replay":
				this.terminal.reset();
				await this.raceDisposal(this.write(operation.payload));
				return;
			case "resize":
				this.terminal.dispose();
				this.terminal = this.createTerminal(operation.cols, operation.rows);
				await this.raceDisposal(this.write(operation.replay));
				return;
		}
	}

	/** A disposed terminal may never invoke its parse callback; do not hang. */
	private raceDisposal(written: Promise<void>): Promise<void> {
		return Promise.race([written, this.whenDisposed]);
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
