import {
	createTerminalSession,
	TerminalScreen,
	type TerminalScreenSnapshot,
	type TerminalSession,
	type TerminalSessionExit,
	type TerminalSessionOptions,
} from "@earendil-works/pi-pty";
import { DEFAULT_SCROLLBACK, MAX_SESSION_OUTPUT_CHARS, safeRegExp } from "./shared.ts";

export interface TerminalRuntimeOptions extends TerminalSessionOptions {
	readonly scrollback?: number;
}

export interface DeltaRead {
	readonly text: string;
	readonly droppedChars: number;
}

type OutputWaitOutcome = "matched" | "exited" | "timeout" | "aborted" | "invalid_pattern";

interface OutputWaiter {
	readonly regex: RegExp;
	buffer: string;
	timer: ReturnType<typeof setTimeout> | null;
	readonly signal: AbortSignal | undefined;
	readonly onAbort: () => void;
	readonly resolve: (outcome: OutputWaitOutcome) => void;
}

/**
 * A live terminal session: a pi-pty {@link TerminalSession} plus an xterm screen model,
 * a bounded decoded-output buffer with a per-consumer read cursor, and `wait_for` waiters.
 */
export class TerminalRuntimeSession {
	readonly session: TerminalSession;
	readonly command: string;
	private readonly screen: TerminalScreen;
	private readonly decoder = new TextDecoder("utf-8", { fatal: false });
	private buffer = "";
	private droppedChars = 0;
	private consumed = 0;
	private readonly waiters = new Set<OutputWaiter>();
	private unsubscribeData: (() => void) | null = null;

	constructor(command: string, options: TerminalRuntimeOptions) {
		this.command = command;
		this.screen = new TerminalScreen({
			cols: options.cols,
			rows: options.rows,
			scrollback: options.scrollback ?? DEFAULT_SCROLLBACK,
		});
		this.session = createTerminalSession(options);
		this.unsubscribeData = this.session.onData((chunk) => this.ingest(chunk));
		this.session.onExit(() => this.settleWaiters("exited"));
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

	private ingest(chunk: Uint8Array): void {
		const text = this.decoder.decode(chunk, { stream: true });
		if (text.length === 0) return;
		void this.screen.feed(text);
		this.buffer += text;
		if (this.buffer.length > MAX_SESSION_OUTPUT_CHARS) {
			const overflow = this.buffer.length - MAX_SESSION_OUTPUT_CHARS;
			this.buffer = this.buffer.slice(overflow);
			this.droppedChars += overflow;
		}
		for (const waiter of this.waiters) {
			waiter.buffer += text;
			if (waiter.regex.test(waiter.buffer)) this.resolveWaiter(waiter, "matched");
		}
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

	/**
	 * Wait until `pattern` matches newly produced output, the session exits, the
	 * timeout elapses, or the wait is aborted.
	 */
	waitFor(pattern: string, timeoutMs: number, signal?: AbortSignal): Promise<OutputWaitOutcome> {
		const regex = safeRegExp(pattern);
		if (regex === null) return Promise.resolve("invalid_pattern");
		if (this.exited) return Promise.resolve("exited");
		if (signal?.aborted) return Promise.resolve("aborted");
		return new Promise((resolve) => {
			const waiter: OutputWaiter = {
				regex,
				buffer: "",
				timer: null,
				signal,
				onAbort: () => this.resolveWaiter(waiter, "aborted"),
				resolve,
			};
			this.waiters.add(waiter);
			waiter.timer = setTimeout(() => this.resolveWaiter(waiter, "timeout"), timeoutMs);
			if (signal) {
				signal.addEventListener("abort", waiter.onAbort, { once: true });
				if (signal.aborted) this.resolveWaiter(waiter, "aborted");
			}
		});
	}

	dispose(): void {
		this.unsubscribeData?.();
		this.unsubscribeData = null;
		this.settleWaiters(this.exited ? "exited" : "timeout");
		this.screen.dispose();
	}

	private settleWaiters(outcome: "exited" | "timeout"): void {
		for (const waiter of [...this.waiters]) this.resolveWaiter(waiter, outcome);
	}

	private resolveWaiter(waiter: OutputWaiter, outcome: Exclude<OutputWaitOutcome, "invalid_pattern">): void {
		if (!this.waiters.delete(waiter)) return;
		if (waiter.timer !== null) {
			clearTimeout(waiter.timer);
			waiter.timer = null;
		}
		waiter.signal?.removeEventListener("abort", waiter.onAbort);
		waiter.resolve(outcome);
	}
}
