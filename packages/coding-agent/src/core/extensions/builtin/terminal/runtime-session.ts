import {
	TerminalScreen,
	type TerminalScreenSnapshot,
	TerminalSession,
	type TerminalSessionExit,
	type TerminalSessionOptions,
} from "@earendil-works/pi-pty";
import { DEFAULT_SCROLLBACK, MAX_SESSION_OUTPUT_CHARS } from "./shared.ts";

export interface TerminalRuntimeOptions extends TerminalSessionOptions {
	readonly scrollback?: number;
}

export interface DeltaRead {
	readonly text: string;
	readonly droppedChars: number;
}

/**
 * A live terminal session: a pi-pty {@link TerminalSession} plus an xterm screen model
 * and a bounded decoded-output buffer with a per-consumer read cursor. Reads are pure
 * non-blocking peeks; watchers subscribe through `onOutput` (the monitor path).
 */
export class TerminalRuntimeSession {
	readonly session: TerminalSession;
	readonly command: string;
	private readonly screen: TerminalScreen;
	private readonly decoder = new TextDecoder("utf-8", { fatal: false });
	private buffer = "";
	private droppedChars = 0;
	private consumed = 0;
	private readonly outputListeners = new Set<(chunk: string) => void>();
	private unsubscribeData: (() => void) | null = null;

	constructor(command: string, options: TerminalRuntimeOptions) {
		this.command = command;
		this.screen = new TerminalScreen({
			cols: options.cols,
			rows: options.rows,
			scrollback: options.scrollback ?? DEFAULT_SCROLLBACK,
		});
		this.session = new TerminalSession(options);
		this.unsubscribeData = this.session.onData((chunk) => {
			const text = this.ingest(chunk);
			if (text.length === 0) return;
			for (const listener of this.outputListeners) {
				try {
					listener(text);
				} catch {
					// Output observers must not interfere with the session's ingest path.
				}
			}
		});
		this.session.start();
	}

	get backend(): string | null {
		return this.session.backend;
	}

	get exited(): boolean {
		return this.session.exited;
	}

	get exitResult(): TerminalSessionExit | null {
		return this.session.exitResult;
	}

	/** Total decoded chars produced so far (including any dropped from the front). */
	get totalChars(): number {
		return this.droppedChars + this.buffer.length;
	}

	private ingest(chunk: Uint8Array): string {
		const text = this.decoder.decode(chunk, { stream: true });
		if (text.length === 0) return text;
		void this.screen.feed(text);
		this.buffer += text;
		if (this.buffer.length > MAX_SESSION_OUTPUT_CHARS) {
			const overflow = this.buffer.length - MAX_SESSION_OUTPUT_CHARS;
			this.buffer = this.buffer.slice(overflow);
			this.droppedChars += overflow;
		}
		return text;
	}

	/** Subscribe to decoded output without affecting the read cursor. */
	onOutput(listener: (chunk: string) => void): () => void {
		this.outputListeners.add(listener);
		return () => this.outputListeners.delete(listener);
	}

	/** Return output produced since the last read and advance the read cursor. */
	readDelta(): DeltaRead {
		const start = Math.max(this.consumed, this.droppedChars);
		const dropped = Math.max(0, this.droppedChars - this.consumed);
		const text = this.buffer.slice(start - this.droppedChars);
		this.consumed = this.totalChars;
		return { text, droppedChars: dropped };
	}

	/** Full retained decoded output (`view:"log"`), without advancing the cursor. */
	fullOutput(): string {
		return this.buffer;
	}

	snapshot(): TerminalScreenSnapshot {
		return this.screen.snapshot();
	}

	resizeScreen(cols: number, rows: number): void {
		void this.screen.resize(cols, rows);
	}

	dispose(): void {
		this.unsubscribeData?.();
		this.unsubscribeData = null;
		this.outputListeners.clear();
		this.screen.dispose();
	}
}
